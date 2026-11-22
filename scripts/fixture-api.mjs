import http from 'node:http';
import { randomUUID } from 'node:crypto';

const python = process.platform === 'win32' ? 'python' : 'python3';
const code = `import argparse
import csv
import sys
from collections import defaultdict
from decimal import Decimal

def summarize(records, descending=False):
    totals = defaultdict(Decimal)
    for row in records:
        totals[row['category']] += Decimal(row['amount'])
    if descending:
        return sorted(totals.items(), key=lambda item: (-item[1], item[0]))
    return sorted(totals.items())

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('csv_file')
    parser.add_argument('--descending', action='store_true')
    args = parser.parse_args()
    with open(args.csv_file, encoding='utf-8', newline='') as source:
        result = summarize(csv.DictReader(source), args.descending)
    writer = csv.writer(sys.stdout)
    writer.writerow(['category', 'amount'])
    writer.writerows(result)

if __name__ == '__main__':
    main()
`;
const baseTest = `import unittest
from decimal import Decimal
from summary import summarize

class SummaryTests(unittest.TestCase):
    def test_totals(self):
        self.assertEqual(summarize([{'category': 'A', 'amount': '3.2'}, {'category': 'A', 'amount': '0.4'}]), [('A', Decimal('3.6'))])
`;
const extraTest = `
    def test_empty(self):
        self.assertEqual(summarize([], descending=True), [])

    def test_sort(self):
        data = [{'category': 'A', 'amount': '2'}, {'category': 'B', 'amount': '4'}]
        self.assertEqual(summarize(data, descending=True), [('B', Decimal(4)), ('A', Decimal(2))])
`;

function executePython(source, next) {
  const encoded = Buffer.from(source).toString('base64');
  return `${python} -c "import base64; exec(base64.b64decode('${encoded}'))"${next ? `; ${next}` : ''}`;
}

function writePythonFile(filename, contents) {
  return `p.joinpath(${JSON.stringify(filename)}).write_text(${JSON.stringify(contents)}, encoding='utf-8')`;
}

function codeCommand(revise) {
  const source = ['from pathlib import Path', "p=Path('outputs')", "assert p.is_dir()"];
  if (revise) source.push("assert p.joinpath('summary.py').exists()");
  const initialCode = code.replace("    if descending:\n        return sorted(totals.items(), key=lambda item: (-item[1], item[0]))\n", '');
  source.push(writePythonFile('summary.py', revise ? code : initialCode));
  source.push(writePythonFile('test_summary.py', revise ? baseTest + extraTest : baseTest));
  source.push(writePythonFile('sample.csv', 'category,amount\nA,3.5\nB,8\nA,2.5\n'));
  return executePython(source.join('\n'), `${python} -B -m unittest discover -s outputs -v`);
}

function reportCommand(revise) {
  const actionTable = `\n## 行动与待确认项\n\n| 事项 | 负责人 | 截止日 | 待确认 |\n|---|---|---|---|\n| 邮件通知重试 | 林然 | 2026-11-24 | 修复方案 |\n| 工单筛选回归 | 许晴 | 2026-11-25 | 筛选边界条件 |\n| 空状态文案 | 顾舟 | 2026-11-26 | 产品确认及排期 |\n| 批量导入重复记录 | 未约定 | 未约定 | 明确处理方式 |\n`;
  return executePython([
    'from pathlib import Path', 'from collections import Counter', 'import csv',
    "files=list(Path('inputs').glob('*.csv')); notes=list(Path('inputs').glob('*.txt'))",
    'assert len(files) == len(notes) == 1',
    "with files[0].open(encoding='utf-8', newline='') as source: rows=list(csv.DictReader(source))",
    "assert '重复记录' in notes[0].read_text(encoding='utf-8')",
    "priority=Counter(row['priority'] for row in rows); status=Counter(row['status'] for row in rows)",
    "assert len(rows) == 7 and priority == {'P0': 1, 'P1': 3, 'P2': 3}",
    "text=f'# 产品支持周报\\n\\n工单共 {len(rows)} 条。\\n\\n'",
    "for group, counts in [('优先级', priority), ('状态', status)]: text += group + '：' + '、'.join(f'{key} {value} 条' for key, value in sorted(counts.items())) + '。\\n\\n'",
    "text += '优先处理邮件通知重试，关注批量导入重复记录和工单筛选回归。\\n'",
    ...(revise ? ["assert Path('outputs/report.md').is_file()", `text += ${JSON.stringify(actionTable)}`] : []),
    "Path('outputs/report.md').write_text(text, encoding='utf-8')",
    "print('Verified 7 tickets; report.md written')",
  ].join('\n'));
}

function userTexts(items) {
  return items.filter((item) => item.type === 'message' && item.role === 'user').map((item) =>
    item.content.filter((part) => part.type === 'input_text').map((part) => part.text).join('\n'));
}

function respond(response, payload, state) {
  const items = Array.isArray(payload.input) ? payload.input : [];
  const texts = userTexts(items);
  const latest = texts.findLast((text) => text.includes('FIXTURE_')) || '';
  if (latest.includes('FIXTURE_SLOW')) return;
  if (latest.includes('FIXTURE_FAIL')) {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ error: { message: 'Fixture credential rejected for local integration testing', type: 'invalid_request_error' } }));
  }
  const isReport = latest.includes('FIXTURE_REPORT');
  const revise = latest.includes('FIXTURE_REVISE');
  const prior = isReport ? 'FIXTURE_REPORT INITIAL' : 'FIXTURE_CODE INITIAL';
  if (revise && !texts.some((text) => text.includes(prior))) {
    response.writeHead(422, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ error: { message: 'The resume request did not contain the earlier prompt' } }));
  }
  if (revise) state.resumedRequests++;

  const lastUser = items.findLastIndex((item) => item.type === 'message' && item.role === 'user');
  const result = items.slice(lastUser + 1).findLast((item) => item.type === 'function_call_output');
  const id = `resp_${randomUUID()}`;
  const frame = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: payload.model };
  let output;
  if (!result && latest) {
    const tool = payload.tools?.find((candidate) => ['shell_command', 'shell', 'exec_command'].includes(candidate.name));
    if (!tool) throw new Error(`No compatible shell tool: ${payload.tools?.map((candidate) => candidate.name || candidate.type).join(', ')}`);
    const command = isReport ? reportCommand(revise) : codeCommand(revise);
    const args = tool.name === 'exec_command' ? { cmd: command, yield_time_ms: 10_000, login: false }
      : tool.name === 'shell_command' ? { command, timeout_ms: 25_000, login: false }
      : { command: process.platform === 'win32' ? ['powershell.exe', '-NoProfile', '-Command', command] : ['/bin/bash', '-c', command], timeout_ms: 25_000 };
    output = { id: `fc_${randomUUID()}`, type: 'function_call', name: tool.name, call_id: `call_${randomUUID()}`, arguments: JSON.stringify(args), status: 'completed' };
  } else {
    const resultText = typeof result?.output === 'string' ? result.output : JSON.stringify(result?.output || '');
    if (result && !/exit code:?\s*0/i.test(resultText)) state.toolFailure = resultText.slice(0, 4000);
    const answer = isReport ? '周报已写入 outputs/report.md。已核对 7 条工单的分类统计。'
      : 'CSV 汇总工具与测试已写入 outputs/。已运行 unittest。';
    output = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
  }

  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  send('response.created', { response: { ...frame, output: [], status: 'in_progress' } });
  send('response.output_item.added', { output_index: 0, item: { ...output, status: 'in_progress', ...(output.type === 'function_call' ? { arguments: '' } : { content: [] }) } });
  if (output.type === 'function_call') {
    send('response.function_call_arguments.delta', { item_id: output.id, output_index: 0, delta: output.arguments });
    send('response.function_call_arguments.done', { item_id: output.id, output_index: 0, arguments: output.arguments });
  } else {
    send('response.output_text.delta', { item_id: output.id, output_index: 0, content_index: 0, delta: output.content[0].text });
  }
  send('response.output_item.done', { output_index: 0, item: output });
  send('response.completed', { response: { ...frame, output: [output], status: 'completed', usage: { input_tokens: 12, output_tokens: 12, total_tokens: 24 } } });
  response.end();
}

export function fixtureApi() {
  const state = { requests: 0, resumedRequests: 0, toolFailure: null };
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || new URL(request.url, 'http://localhost').pathname !== '/v1/responses') {
      response.writeHead(404);
      return response.end();
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      state.requests++;
      respond(response, JSON.parse(Buffer.concat(chunks)), state);
    } catch (error) {
      state.fixtureError = error.message;
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  return { server, state };
}
