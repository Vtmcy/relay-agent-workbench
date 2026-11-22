const element = (name) => document.getElementById(name);
const layout = document.querySelector('.layout');
const timeline = element('timeline');
const promptBox = element('prompt');
const runsPanel = element('runs');
const viewport = matchMedia('(max-width:820px)');
const statusNames = {
  running: '执行中', succeeded: '已完成', failed: '失败', timed_out: '超时', cancelled: '已停止', interrupted: '已中断',
};
const eventNames = {
  command: '执行命令', command_result: '命令结果', file: '文件变更', plan: '任务清单', error: '错误', diagnostic: '运行诊断',
};
const examples = {
  code: '用 Python 标准库编写一个 CSV 汇总工具。输入有 category、amount 两列，按类别汇总金额并输出 CSV。请把源码、示例和 unittest 测试放在 outputs/，运行测试和示例。',
  report: '根据 inputs/ 中的工单和会议纪要整理一份中文周报。统计优先级和状态，提炼主要问题与下一步行动，将报告写入 outputs/report.md，并核对统计结果。',
};
let current;
let config;
let creating;
let sessionList = [];
let navKey = '';
const drafts = new Map();

function node(tag, cssClass, value) {
  const created = document.createElement(tag);
  if (cssClass) created.className = cssClass;
  if (value !== undefined) created.textContent = value;
  return created;
}

async function api(url, { method = 'GET', payload, file } = {}) {
  const headers = method === 'POST' ? { 'X-Workbench': '1' } : {};
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { method, headers, body: file ?? JSON.stringify(payload) });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error || `请求失败（${response.status}）`);
  }
  return response;
}

async function getJSON(url, options) {
  return (await api(url, options)).json();
}

function sessionUrl(view) {
  return `/api/sessions/${view.id}`;
}

function feedback(message = '') {
  element('compose-error').textContent = message;
  element('compose-error').hidden = !message;
}

function renderNavigation() {
  const key = JSON.stringify([current?.id, sessionList]);
  if (navKey === key) return;
  navKey = key;
  element('sessions').replaceChildren(...sessionList.map((session) => {
    const button = node('button', `session-link ${session.status || ''}`);
    if (current?.id === session.id) button.setAttribute('aria-current', 'page');
    button.title = session.title;
    const icon = node('span', 'session-icon', session.status === 'running' ? '◉' : '◇');
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, node('span', '', session.title));
    button.addEventListener('click', () => select(session.id, session.title));
    return button;
  }));
}

function renderControls() {
  const running = current?.runs.some((run) => run.status === 'running');
  const busy = running || current?.posting;
  element('send').disabled = !config?.ready || !!busy || !!current?.uploading || !promptBox.value.trim();
  element('cancel-run').hidden = !running;
  element('cancel-run').disabled = !!current?.cancelling;
  element('upload').disabled = !!busy || !!current?.uploading;
  element('composer-upload').disabled = element('upload').disabled;
  element('agent-label').textContent = running ? 'Codex 执行中' : config?.ready ? 'Codex CLI' : config ? 'Agent 未配置' : '连接中';
  element('agent-label').title = config?.model || '';
  element('agent-status').classList.toggle('active', !!running);
  element('agent-status').classList.toggle('offline', !config?.ready);
  element('configuration').textContent = config?.problem || '';
  element('configuration').hidden = !config?.problem;
}

function message(who, value, time) {
  const isAgent = who === 'Codex';
  const row = node('div', isAgent ? 'agent-message' : 'user-message');
  const body = node('div', 'message-body');
  const title = node('div', 'message-title', who);
  if (time) title.append(node('time', '', new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  body.append(title, node('p', 'message-text', value));
  row.append(node('span', isAgent ? 'avatar agent-avatar' : 'avatar', isAgent ? '▲' : '你'), body);
  return row;
}

function renderEvent(event) {
  if (event.kind === 'answer') return message('Codex', event.text);
  const detail = node('details', `event ${event.kind}`);
  const firstLine = event.text.split('\n', 1)[0];
  const label = eventNames[event.kind] || '运行事件';
  detail.append(node('summary', '', `${label} · ${firstLine.slice(0, 140)}`), node('pre', '', event.text));
  return detail;
}

function renderRuns(view) {
  const follow = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 110;
  element('session-title').textContent = view.title;
  element('welcome').hidden = view.runs.length > 0;
  for (const run of view.runs) {
    let entry = view.nodes.get(run.id);
    if (!entry) {
      const article = node('article', 'run');
      const events = node('div', 'events');
      const status = node('div', 'run-state');
      status.setAttribute('role', 'status');
      article.append(message('你', run.prompt, run.created_at), events, status);
      runsPanel.append(article);
      entry = { events, status };
      view.nodes.set(run.id, entry);
    }
    const text = `${statusNames[run.status] || run.status}${run.detail ? ` · ${run.detail}` : ''}`;
    if (entry.status.textContent !== text) {
      entry.status.className = `run-state ${run.status}`;
      entry.status.textContent = text;
    }
  }
  for (const event of view.pending.splice(0)) view.nodes.get(event.run_id)?.events.append(renderEvent(event));
  if (follow) timeline.scrollTop = timeline.scrollHeight;
}

function fileUrl(view, file, preview = false) {
  const params = new URLSearchParams({ path: file.path });
  if (preview) params.set('preview', '1');
  return `${sessionUrl(view)}/files?${params}`;
}

function formattedSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function previewFile(view, file) {
  const dialog = element('preview-dialog');
  const output = element('preview-body');
  const url = fileUrl(view, file);
  element('preview-title').textContent = file.path;
  element('preview-download').href = url;
  output.textContent = '读取中…';
  if (!dialog.open) dialog.showModal();
  try {
    const knownBinary = /\.(pdf|docx?|xlsx?|pptx?|zip|gz|png|jpe?g|gif|mp[34]|exe|webp)$/i.test(file.path);
    const text = knownBinary ? '此格式请下载后查看。' : await (await api(fileUrl(view, file, true))).text();
    if (element('preview-download').getAttribute('href') === url) output.textContent = text.includes('\0') ? '此格式请下载后查看。' : text;
  } catch (error) {
    if (element('preview-download').getAttribute('href') === url) output.textContent = error.message;
  }
}

function renderFiles(view, files) {
  const key = JSON.stringify(files);
  if (view && key === view.filesKey) return;
  if (view) view.filesKey = key;
  for (const group of ['outputs', 'inputs']) {
    const matches = files.filter((file) => file.path.startsWith(`${group}/`));
    element(`${group}-count`).textContent = matches.length;
    element(group).replaceChildren(...(matches.length ? matches.map((file) => {
      const row = node('div', 'file-row');
      const button = node('button', 'file-link');
      button.title = file.path;
      button.append(node('strong', '', file.path.slice(group.length + 1)), node('small', '', formattedSize(file.size)));
      button.addEventListener('click', () => previewFile(view, file));
      const download = node('a', 'file-download', '↓');
      download.href = fileUrl(view, file);
      download.download = '';
      download.setAttribute('aria-label', `下载 ${file.path}`);
      row.append(button, download);
      return row;
    }) : [node('p', 'file-empty', group === 'outputs' ? '任务生成的文件会显示在这里。' : '还没有上传材料。')]));
  }
}

function renderUpload(view) {
  const status = element('upload-status');
  status.textContent = view?.uploadMessage || '';
  status.classList.toggle('error', !!view?.uploadError);
}

async function sync(view) {
  if (!view || view.syncing) return;
  view.syncing = true;
  try {
    let count;
    do {
      const data = await getJSON(`${sessionUrl(view)}?after=${view.after}`);
      if (current !== view) return;
      view.runs = data.runs;
      view.title = data.title;
      count = data.events.length;
      if (count) view.after = data.events.at(-1).id;
      view.pending.push(...data.events);
      renderRuns(view);
      renderControls();
    } while (count === 200);
    const { files } = await getJSON(`${sessionUrl(view)}/files`);
    if (current === view) renderFiles(view, files);
  } finally {
    view.syncing = false;
  }
}

function select(id, title) {
  if (current?.id === id) {
    layout.classList.remove('sidebar-mobile');
    element('toggle-sidebar').setAttribute('aria-expanded', 'false');
    return current;
  }
  drafts.set(current?.id || '', promptBox.value);
  const view = { id, title, runs: [], after: 0, nodes: new Map(), pending: [] };
  current = view;
  promptBox.value = drafts.get(id) || '';
  const location = new URL(window.location.href);
  location.searchParams.set('session', id);
  history.replaceState(null, '', location);
  runsPanel.replaceChildren();
  timeline.scrollTop = 0;
  element('session-title').textContent = title;
  element('welcome').hidden = false;
  layout.classList.remove('sidebar-mobile');
  element('toggle-sidebar').setAttribute('aria-expanded', 'false');
  feedback();
  renderNavigation();
  renderFiles(view, []);
  renderUpload(view);
  renderControls();
  sync(view).catch((error) => { if (current === view) feedback(error.message); });
  return view;
}

async function newSession() {
  if (creating) return creating;
  creating = (async () => {
    const created = await getJSON('/api/sessions', { method: 'POST', payload: {} });
    sessionList.unshift(created);
    return select(created.id, created.title);
  })();
  try { return await creating; } finally { creating = null; }
}

element('new-session').addEventListener('click', () => {
  newSession().then(() => promptBox.focus()).catch((error) => feedback(error.message));
});
promptBox.addEventListener('input', renderControls);
promptBox.addEventListener('keydown', (event) => {
  if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (!element('send').disabled) element('composer').requestSubmit();
  }
});
for (const suggestion of document.querySelectorAll('[data-example]')) {
  suggestion.addEventListener('click', () => {
    promptBox.value = examples[suggestion.dataset.example];
    promptBox.focus();
    renderControls();
  });
}
element('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (element('send').disabled) return;
  const prompt = promptBox.value.trim();
  let view = current;
  try {
    view ||= await newSession();
    if (view.posting) return;
    view.posting = true;
    if (current === view) renderControls();
    const { id } = await getJSON(`${sessionUrl(view)}/runs`, { method: 'POST', payload: { prompt } });
    if (!view.runs.some((run) => run.id === id)) view.runs.push({ id, prompt, status: 'running', created_at: Date.now() });
    if (current === view) {
      if (!promptBox.value.trim() || promptBox.value.trim() === prompt) promptBox.value = '';
      feedback();
      renderRuns(view);
      timeline.scrollTop = timeline.scrollHeight;
      await sync(view);
    } else if (drafts.get(view.id)?.trim() === prompt) {
      drafts.delete(view.id);
    }
  } catch (error) {
    if (!view || current === view) {
      if (!promptBox.value.trim()) promptBox.value = prompt;
      feedback(error.message);
    }
  } finally {
    if (view) view.posting = false;
    renderControls();
  }
});

element('cancel-run').addEventListener('click', async () => {
  const view = current;
  view.cancelling = true;
  renderControls();
  try {
    await api(`${sessionUrl(view)}/cancel`, { method: 'POST' });
    if (current === view) await sync(view);
  } catch (error) {
    if (current === view) feedback(error.message);
  } finally {
    view.cancelling = false;
    renderControls();
  }
});

function setFiles(open) {
  layout.classList.toggle(viewport.matches ? 'files-mobile' : 'files-hidden', viewport.matches ? open : !open);
  element('toggle-files').setAttribute('aria-expanded', String(open));
}
viewport.addEventListener('change', () => setFiles(!viewport.matches));
setFiles(!viewport.matches);
element('toggle-files').addEventListener('click', () => setFiles(element('toggle-files').getAttribute('aria-expanded') !== 'true'));
element('close-files').addEventListener('click', () => setFiles(false));
element('toggle-sidebar').addEventListener('click', () => {
  const expanded = layout.classList.toggle('sidebar-mobile');
  element('toggle-sidebar').setAttribute('aria-expanded', String(expanded));
});
for (const button of [element('upload'), element('composer-upload')]) button.addEventListener('click', () => element('upload-input').click());

async function uploadFiles(files) {
  if (!files.length || element('upload').disabled) return;
  let view;
  try {
    view = current || await newSession();
    view.uploading = true;
    view.uploadError = false;
    view.uploadMessage = `正在上传 ${files.length} 个文件…`;
    setFiles(true);
    renderUpload(view);
    renderControls();
    let uploaded = 0;
    const failures = [];
    for (const file of files) {
      const params = new URLSearchParams({ name: file.name });
      try {
        await api(`${sessionUrl(view)}/upload?${params}`, { method: 'POST', file });
        uploaded++;
      } catch (error) {
        failures.push(`${file.name}：${error.message}`);
      }
    }
    view.uploadError = failures.length > 0;
    view.uploadMessage = [`已上传 ${uploaded} 个文件。`, ...failures].join(' ');
    if (current === view) await sync(view);
  } catch (error) {
    if (!view || current === view) feedback(error.message);
  } finally {
    if (view) view.uploading = false;
    renderUpload(current);
    renderControls();
  }
}

element('upload-input').addEventListener('change', (event) => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  uploadFiles(files);
});
const dropZone = element('upload');
dropZone.addEventListener('dragover', (event) => { event.preventDefault(); if (!dropZone.disabled) dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('drag');
  uploadFiles(Array.from(event.dataTransfer.files));
});

async function refresh() {
  try {
    if (!config) config = await getJSON('/api/health');
    if (!current) {
      const requested = new URL(window.location.href).searchParams.get('session');
      sessionList = (await getJSON('/api/sessions')).sessions;
      const selected = sessionList.find((session) => session.id === requested) || sessionList[0];
      if (!current && selected) select(selected.id, selected.title);
    } else {
      const [listResult, viewResult] = await Promise.allSettled([getJSON('/api/sessions'), sync(current)]);
      if (listResult.status === 'fulfilled') sessionList = listResult.value.sessions;
      else throw listResult.reason;
      if (viewResult.status === 'rejected') throw viewResult.reason;
    }
    renderNavigation();
    if (element('compose-error').dataset.network === '1') feedback();
    delete element('compose-error').dataset.network;
  } catch (error) {
    if (element('compose-error').hidden || element('compose-error').dataset.network === '1') {
      feedback(`同步失败，稍后自动重试。${error.message}`);
      element('compose-error').dataset.network = '1';
    }
  } finally {
    renderControls();
    setTimeout(refresh, 1200);
  }
}
renderFiles(null, []);
renderControls();
refresh();
