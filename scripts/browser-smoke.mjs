import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { fixtureApi } from './fixture-api.mjs';

const playwright = await import(process.env.RELAY_PLAYWRIGHT ? pathToFileURL(process.env.RELAY_PLAYWRIGHT) : 'playwright');
const project = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.resolve(process.env.RELAY_EVIDENCE_DIR || 'evidence');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-browser-'));
const { server: fixture } = fixtureApi();
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const child = spawn(process.execPath, [path.join(project, 'src', 'server.mjs')], {
  cwd: project,
  env: { ...process.env, AGENT_API_KEY: 'fixture-key-local-only', AGENT_MODEL: 'relay-fixture',
    AGENT_BASE_URL: `http://127.0.0.1:${fixture.address().port}/v1`, AGENT_TIMEOUT_SECONDS: '60',
    WORKBENCH_BIND: '127.0.0.1', WORKBENCH_PORT: '0', WORKBENCH_DATA_DIR: data },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let browser;

async function waitForUrl() {
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) return url;
  }
  throw new Error('Workbench did not start');
}

async function submit(page, text) {
  await page.locator('#prompt').fill(text);
  await page.locator('#send').click();
  await page.locator('.user-message .message-text').getByText(text, { exact: true }).waitFor();
}

async function lastStatus(page, status) {
  await page.locator('.run-state').last().getByText(status, { exact: true }).waitFor({ timeout: 45_000 });
}

try {
  const base = await waitForUrl();
  await fs.mkdir(evidence, { recursive: true });
  browser = await playwright.chromium.launch({ executablePath: process.env.RELAY_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 }, locale: 'zh-CN', acceptDownloads: true });
  let page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('#agent-label').getByText('Codex CLI').waitFor();
  await page.screenshot({ path: path.join(evidence, '01-workbench.png') });
  await page.getByRole('button', { name: /开发一个工具/ }).click();
  assert.match(await page.locator('#prompt').inputValue(), /CSV 汇总工具/);
  await submit(page, '开发 CSV 汇总工具，运行测试并输出示例。\nFIXTURE_CODE INITIAL');
  await page.locator('.run-state.running').waitFor();
  const codeUrl = page.url();
  await page.locator('#new-session').click();
  await page.waitForURL((url) => url.href !== codeUrl);
  await page.locator('#upload-input').setInputFiles(['工单.csv', '会议纪要.txt'].map((name) => path.join(project, 'demo', name)));
  await page.locator('#inputs').getByText('会议纪要.txt').waitFor();
  await submit(page, '根据工单和会议纪要整理产品支持周报。\nFIXTURE_REPORT INITIAL');
  await page.locator('.run-state.running').waitFor();
  const reportUrl = page.url();
  await page.close();
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(reportUrl);
  await lastStatus(page, '已完成');
  await page.locator('#outputs').getByText('report.md').waitFor();
  await submit(page, '补充行动表，列出负责人和截止日。\nFIXTURE_REPORT FIXTURE_REVISE');
  await lastStatus(page, '已完成');
  await page.locator('#outputs').getByRole('button', { name: /report.md/ }).click();
  await page.waitForFunction(() => document.querySelector('#preview-body').textContent.includes('2026-11-24'));
  await page.screenshot({ path: path.join(evidence, '03-report-preview.png') });
  const [reportDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#preview-download').click()]);
  assert.equal(reportDownload.suggestedFilename(), 'report.md');
  await page.getByRole('button', { name: '关闭预览' }).click();
  await page.locator('#sessions').getByRole('button', { name: /开发 CSV 汇总工具/ }).click();
  await page.waitForURL(codeUrl);
  await lastStatus(page, '已完成');
  await submit(page, '加入金额降序和空数据测试。\nFIXTURE_CODE FIXTURE_REVISE');
  await lastStatus(page, '已完成');
  const testResult = page.locator('.command_result').last();
  await testResult.locator('summary').click();
  await testResult.locator('pre').getByText(/Ran 3 tests/).waitFor();
  const [sourceDownload] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('link', { name: '下载 outputs/summary.py' }).click(),
  ]);
  assert.equal(sourceDownload.suggestedFilename(), 'summary.py');
  await testResult.locator('pre').evaluate((log) => { log.scrollTop = log.scrollHeight; });
  await page.locator('#timeline').evaluate((feed) => { feed.scrollTop = feed.scrollHeight; });
  await page.screenshot({ path: path.join(evidence, '02-code-tests.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#toggle-files').click();
  await page.locator('#outputs').getByText('summary.py', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭文件面板' }).click();
  assert.equal(await page.locator('#file-pane').isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.deepEqual(errors, []);
  const result = 'PASS Chromium desktop and mobile, send, uploads, closed-page recovery, navigation, both follow-ups, expanded test results, report preview and two browser downloads';
  console.log(result);
  await fs.writeFile(path.join(evidence, 'browser-result.txt'), `${result}\nBrowser: ${browser.version()}\nUpstream: local Responses fixture, real Codex CLI and sandboxed shell tool\n`);
} finally {
  await browser?.close();
  if (child.exitCode === null && !child.signalCode) {
    const closed = once(child, 'close');
    child.kill();
    await closed;
  }
  fixture.closeAllConnections();
  fixture.close();
  const pathPrefix = path.join(await fs.realpath(os.tmpdir()), 'relay-browser-');
  const resolved = await fs.realpath(data);
  if (resolved.startsWith(pathPrefix)) await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
