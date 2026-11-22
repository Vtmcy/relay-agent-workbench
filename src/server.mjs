import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { agentSettings, startAgent } from './agent.mjs';
import { openStore } from './store.mjs';
import { HttpError, listFiles, openDownload, saveUpload, uploadLimit, workspace } from './workspace.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const dataDir = path.resolve(process.env.WORKBENCH_DATA_DIR || '.workbench');
const bind = process.env.WORKBENCH_BIND || '127.0.0.1';
const port = Number(process.env.WORKBENCH_PORT || 4177);
const hosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(process.env.WORKBENCH_ALLOWED_HOST || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)]);
const settings = agentSettings();
const active = new Map();
let stopping = false;
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const data = fs.realpathSync.native(dataDir);
const store = openStore(path.join(data, 'workbench.sqlite'));

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function json(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function body(request, max) {
  if (Number(request.headers['content-length']) > max) throw new HttpError(413, '请求内容过大。');
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, '请求内容过大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function jsonBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '需要 JSON 请求。');
  const raw = await body(request, 65_536);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw new HttpError(400, '请求的 JSON 无效。');
}

async function route(request, response) {
  const origin = request.headers.origin;
  let parsedHost;
  try { parsedHost = new URL(`http://${request.headers.host}`); } catch { throw new HttpError(403, '访问地址无效。'); }
  if (!hosts.has(parsedHost.hostname) || parsedHost.host !== request.headers.host?.toLowerCase() ||
    (origin && ![`http://${parsedHost.host}`, `https://${parsedHost.host}`].includes(origin)) ||
    request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '访问地址无效。');
  if (!request.url.startsWith('/') || request.url.startsWith('//')) throw new HttpError(400, 'URL 无效。');
  const url = new URL(request.url, parsedHost.origin);
  const method = request.method;
  if (method === 'POST' && request.headers['x-workbench'] !== '1') throw new HttpError(403, '请求来源无效。');
  if (method === 'POST' && stopping) throw new HttpError(503, '服务正在停止。');

  if (method === 'GET' && staticFiles.has(url.pathname)) {
    const [filename, type] = staticFiles.get(url.pathname);
    response.writeHead(200, { 'Content-Type': type });
    await pipeline(fs.createReadStream(path.join(publicDir, filename)), response);
    return;
  }
  if (method === 'GET' && url.pathname === '/api/health') {
    return json(response, { ready: !settings.problem, problem: settings.problem || null, model: settings.model || null });
  }
  if (url.pathname === '/api/sessions') {
    if (method === 'GET') return json(response, { sessions: store.list() });
    if (method === 'POST') {
      const { title } = await jsonBody(request);
      const session = store.create(typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : '新会话');
      return json(response, { id: session.id, title: session.title }, 201);
    }
  }
  const match = /^\/api\/sessions\/([a-f\d-]{36})(?:\/(runs|cancel|files|upload))?$/.exec(url.pathname);
  if (!match) throw new HttpError(404, '页面或接口不存在。');
  const [, id, action] = match;
  const session = store.session(id);
  if (!session) throw new HttpError(404, '会话不存在。');
  if (method === 'GET' && !action) {
    const after = Number(url.searchParams.get('after') ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '事件游标无效。');
    return json(response, { title: session.title, runs: store.runs(id), events: store.events(id, after) });
  }
  if (method === 'POST' && action === 'runs') {
    if (settings.problem) throw new HttpError(503, settings.problem);
    const { prompt } = await jsonBody(request);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12_000) throw new HttpError(400, '任务内容须为 1–12000 字符。');
    if (active.has(id)) throw new HttpError(409, '当前会话已有任务在执行。');
    if (active.size >= 4) throw new HttpError(409, '最多可同时执行 4 个会话，请稍后重试。');
    const paths = workspace(data, id);
    const latest = store.session(id);
    const run = store.begin(latest, prompt.trim());
    try {
      const stop = startAgent({ settings, session: latest, run, cwd: paths.root,
        agentHome: path.join(data, 'codex', id), store, onFinish: () => active.delete(id) });
      active.set(id, stop);
    } catch (error) {
      store.finish(run, 'failed', '无法初始化 Codex。请检查数据目录和 CLI 配置。');
      console.error('Agent startup error:', error.code || error.name);
    }
    return json(response, { id: run.id }, 202);
  }
  if (method === 'POST' && action === 'cancel') {
    const stop = active.get(id);
    if (!stop) throw new HttpError(409, '当前会话没有正在运行的任务。');
    stop('cancelled');
    return json(response, { stopping: true }, 202);
  }
  if (method === 'POST' && action === 'upload') {
    const name = url.searchParams.get('name') || '';
    const contents = await body(request, uploadLimit);
    if (active.has(id)) throw new HttpError(409, '请等待当前任务停止或完成后再上传。');
    const file = saveUpload(workspace(data, id), name, contents);
    store.touch(id);
    return json(response, file, 201);
  }
  if (method === 'GET' && action === 'files') {
    const paths = workspace(data, id);
    const relative = url.searchParams.get('path');
    if (!relative) return json(response, { files: listFiles(paths) });
    const preview = url.searchParams.get('preview') === '1';
    const { stream, size, name } = openDownload(paths, relative, preview);
    response.setHeader('Content-Type', preview ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    response.setHeader('Content-Length', size);
    if (!preview) response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`);
    await pipeline(stream, response);
    return;
  }
  throw new HttpError(404, '接口不存在。');
}

const server = http.createServer({ requestTimeout: 60_000 }, (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
  route(request, response).catch((error) => {
    if (response.headersSent || response.destroyed) return response.destroy();
    const expected = error instanceof HttpError;
    if (!expected) console.error('HTTP error:', error.code || error.name);
    if (!request.complete) {
      response.setHeader('Connection', 'close');
      request.resume();
    }
    json(response, { error: expected ? error.message : '工作台暂时无法处理该请求。' }, expected ? error.status : 500);
  });
});
server.listen(port, bind, () => console.log(`Relay workbench listening on http://${bind}:${server.address().port}`));

function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const stop of active.values()) stop('interrupted');
  server.close();
  const deadline = Date.now() + 4000;
  const timer = setInterval(() => {
    if (!active.size || Date.now() > deadline) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 80);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
