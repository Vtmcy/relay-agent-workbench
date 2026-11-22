import fs from 'node:fs';
import path from 'node:path';

export const uploadLimit = 20 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validName(name) {
  return name.length > 0 && Buffer.byteLength(name) <= 240 && !name.startsWith('.') &&
    !/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(name) && !/[. ]$/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(name);
}

function canonical(filename) {
  return path.relative(filename, fs.realpathSync.native(filename)) === '';
}

function directory(filename) {
  fs.mkdirSync(filename, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(filename).isDirectory() || !canonical(filename)) throw new HttpError(409, '工作目录不可用。');
  return filename;
}

export function workspace(data, id) {
  const root = directory(path.join(data, 'workspaces', id));
  return { root, inputs: directory(path.join(root, 'inputs')), outputs: directory(path.join(root, 'outputs')) };
}

export function saveUpload(paths, name, contents) {
  if (!validName(name)) throw new HttpError(400, '文件名无效。');
  try {
    fs.writeFileSync(path.join(paths.inputs, name), contents, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new HttpError(409, '同名文件已存在，请重命名后上传。');
    throw error;
  }
  return { path: `inputs/${name}`, size: contents.length };
}

export function listFiles(paths) {
  const files = [];
  let visited = 0;
  function walk(parent, location, depth) {
    if (depth > 10) return;
    for (const entry of fs.readdirSync(location, { withFileTypes: true })) {
      if (++visited > 3500 || files.length >= 300) return;
      if (!validName(entry.name)) continue;
      const full = path.join(location, entry.name);
      const relative = `${parent}/${entry.name}`;
      try {
        const info = fs.lstatSync(full);
        if (info.isDirectory() && canonical(full)) walk(relative, full, depth + 1);
        if (info.isFile() && info.nlink === 1) files.push({ path: relative, size: info.size, updated_at: info.mtimeMs });
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      }
    }
  }
  walk('outputs', paths.outputs, 0);
  walk('inputs', paths.inputs, 0);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function openDownload(paths, relative, preview) {
  const [group, ...segments] = relative.split('/');
  if (!['inputs', 'outputs'].includes(group) || !segments.length || segments.length > 11 || !segments.every(validName)) {
    throw new HttpError(400, '文件路径无效。');
  }
  let current = paths[group];
  let descriptor;
  try {
    for (const segment of segments) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink() || !canonical(current)) throw new HttpError(404, '文件不存在。');
    }
    if (!fs.lstatSync(current).isFile()) throw new HttpError(404, '文件不存在。');
    descriptor = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1) throw new HttpError(404, '文件不存在。');
    if (preview && info.size > 512 * 1024) throw new HttpError(413, '文件过大，请下载查看。');
    return { stream: fs.createReadStream(current, { fd: descriptor, end: Math.max(0, info.size - 1) }), size: info.size, name: segments.at(-1) };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw new HttpError(404, '文件不存在。');
    throw error;
  }
}
