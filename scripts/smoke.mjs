import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixtureApi } from './fixture-api.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const serverScript = process.env.WORKBENCH_SERVER_SCRIPT || path.join(project, 'src', 'server.mjs');
const tempRoot = process.env.WORKBENCH_TEST_DATA_PARENT || os.tmpdir();
const temp = await fs.mkdtemp(path.join(tempRoot, 'relay-smoke-'));
const runTimeout = Number(process.env.WORKBENCH_TEST_TIMEOUT_SECONDS || 18);
const { server: fixture, state } = fixtureApi();
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const endpoint = `http://127.0.0.1:${fixture.address().port}/v1`;
let child;
let base;
let serverError = '';

async function start() {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverScript], {
    cwd: project,
    env: {
      ...process.env, AGENT_API_KEY: 'fixture-key-local-only', AGENT_MODEL: 'relay-fixture', AGENT_BASE_URL: endpoint,
      AGENT_TIMEOUT_SECONDS: String(runTimeout), WORKBENCH_BIND: '127.0.0.1', WORKBENCH_PORT: '0', WORKBENCH_DATA_DIR: temp,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { serverError += chunk; });
  let stdout = '';
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Workbench did not start')), 8000);
    child.on('close', (code) => { clearTimeout(timer); reject(new Error(`Workbench stopped (${code})`)); });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const listening = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (listening) { clearTimeout(timer); resolve(listening[0]); }
    });
  });
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}

async function request(route, { method = 'GET', data, raw, status = 200, headers = {} } = {}) {
  if (method === 'POST') headers['X-Workbench'] = '1';
  if (data) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${route}`, { method, headers, body: raw ?? JSON.stringify(data) });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${route}: ${text.slice(0, 800)}`);
  if (response.headers.get('content-type').startsWith('application/json')) return JSON.parse(text);
  return text;
}

function create(title) {
  return request('/api/sessions', { method: 'POST', data: { title }, status: 201 });
}

function submit(url, prompt, status = 202) {
  return request(`${url}/runs`, { method: 'POST', data: { prompt }, status });
}

async function waitForRun(url, expected) {
  const deadline = Date.now() + (runTimeout + 15) * 1000;
  while (Date.now() < deadline) {
    const view = await request(url);
    const latest = view.runs.at(-1);
    if (latest && latest.status !== 'running') {
      assert.equal(latest.status, expected, JSON.stringify({ latest, events: view.events, state }));
      return view;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

async function download(url, filename) {
  return request(`${url}/files?${new URLSearchParams({ path: filename })}`);
}

try {
  await start();
  assert.equal((await request('/api/health')).ready, true);
  assert.match(await request('/'), /Relay/);
  await request('/api/sessions', { headers: { Origin: 'https://other.invalid' }, status: 403 });
  const code = `/api/sessions/${(await create('代码开发')).id}`;
  const report = `/api/sessions/${(await create('材料整理')).id}`;
  for (const name of ['工单.csv', '会议纪要.txt']) {
    const contents = await fs.readFile(path.join(project, 'demo', name));
    const url = `${report}/upload?${new URLSearchParams({ name })}`;
    await request(url, { method: 'POST', raw: contents, status: 201 });
    await request(url, { method: 'POST', raw: contents, status: 409 });
  }
  await request(`${report}/upload?name=..%2Fescape.txt`, { method: 'POST', raw: 'x', status: 400 });
  await request(`${report}/files?path=inputs%2F..%2Fworkbench.sqlite`, { status: 400 });
  await Promise.all([submit(code, 'FIXTURE_CODE INITIAL 开发 CSV 汇总工具'), submit(report, 'FIXTURE_REPORT INITIAL 生成产品支持周报')]);
  await submit(code, 'Duplicate active run', 409);
  const [codeView, reportView] = await Promise.all([waitForRun(code, 'succeeded'), waitForRun(report, 'succeeded')]);
  assert.ok(codeView.events.some((event) => event.kind === 'command_result' && /Ran 1 test/.test(event.text) && /退出码 0/.test(event.text)), JSON.stringify({ codeView, state }));
  assert.ok(reportView.events.some((event) => event.kind === 'answer'));
  assert.match(await download(report, 'outputs/report.md'), /7 条/);
  assert.ok((await request(`${code}/files`)).files.every((file) => file.path.startsWith('outputs/')));
  assert.equal((await request(`${code}?after=${codeView.events.at(-1).id}`)).events.length, 0);
  console.log('PASS concurrent code/report workspaces, upload, verified tool execution, history, download, origin and path checks');

  await stop();
  await start();
  assert.equal((await request('/api/sessions')).sessions.length, 2);
  assert.equal((await request(report)).runs.length, 1);
  await Promise.all([submit(code, 'FIXTURE_CODE FIXTURE_REVISE 增加降序与空数据测试'), submit(report, 'FIXTURE_REPORT FIXTURE_REVISE 补行动和截止日')]);
  const [revisedCode, revisedReport] = await Promise.all([waitForRun(code, 'succeeded'), waitForRun(report, 'succeeded')]);
  assert.ok(state.resumedRequests >= 4, JSON.stringify(state));
  assert.ok(revisedCode.events.some((event) => event.kind === 'command_result' && /Ran 3 tests/.test(event.text) && /退出码 0/.test(event.text)));
  assert.ok(revisedReport.events.some((event) => event.kind === 'command_result' && /Verified 7 tickets/.test(event.text)));
  const finalReport = await download(report, 'outputs/report.md');
  assert.match(finalReport, /未约定/);
  assert.match(finalReport, /2026-11-24/);
  console.log('PASS restart preservation and true Codex thread resume for both sessions, 3 code tests and revised report');

  const errors = `/api/sessions/${(await create('异常处理')).id}`;
  await submit(errors, 'FIXTURE_FAIL');
  const rejected = await waitForRun(errors, 'failed');
  assert.match(rejected.runs.at(-1).detail, /401|credential rejected/i);
  await submit(errors, 'FIXTURE_SLOW');
  await request(`${errors}/cancel`, { method: 'POST', status: 202 });
  await waitForRun(errors, 'cancelled');
  await submit(errors, 'FIXTURE_SLOW');
  await waitForRun(errors, 'timed_out');
  await submit(errors, 'FIXTURE_SLOW');
  await stop();
  await start();
  await waitForRun(errors, 'interrupted');
  console.log('PASS provider rejection, cancellation, timeout, interrupted run recovery');

  if (process.env.RELAY_EVIDENCE_DIR) {
    const evidenceDir = path.resolve(process.env.RELAY_EVIDENCE_DIR);
    await fs.mkdir(evidenceDir, { recursive: true });
    for (const file of ['summary.py', 'sample.csv', 'test_summary.py']) await fs.writeFile(path.join(evidenceDir, file), await download(code, `outputs/${file}`));
    await fs.writeFile(path.join(evidenceDir, 'report.md'), finalReport);
    const testOutput = revisedCode.events.findLast((event) => event.kind === 'command_result' && /Ran 3 tests/.test(event.text));
    const checks = [
      `Platform: ${process.platform}; Node: ${process.version}`,
      'CLI: Codex exec --json and exec resume; upstream: local deterministic Responses fixture',
      `Provider requests: ${state.requests}; requests with verified prior prompt: ${state.resumedRequests}`,
      'PASS: code and document workspaces, uploads, file fetching, run events, session restart and resume',
      'PASS: provider rejection, cancellation, timeout, interrupted run recovery',
      '', 'Codex command result:', testOutput.text,
    ];
    await fs.writeFile(path.join(evidenceDir, 'smoke-result.txt'), `${checks.join('\n')}\n`);
  }
} catch (error) {
  console.error(error.message);
  if (serverError) console.error(serverError);
  process.exitCode = 1;
} finally {
  await stop();
  fixture.closeAllConnections();
  fixture.close();
  const prefix = path.join(await fs.realpath(tempRoot), 'relay-smoke-');
  const resolved = await fs.realpath(temp);
  if (resolved.startsWith(prefix)) await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
