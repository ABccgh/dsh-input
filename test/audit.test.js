import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { createAuditLog, summarizeArguments } from '../lib/audit.js';

const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // 测试清理失败不影响结果。
    }
  }
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-input-audit-'));
  temporaryDirectories.push(directory);
  return directory;
}

test('summarizeArguments 截断文本与长参数', () => {
  const short = summarizeArguments('input_type', { text: 'hi', submit: true });
  assert.match(short, /input_type/);
  assert.match(short, /hi/);

  const longText = 'a'.repeat(200);
  const summary = summarizeArguments('input_type', { text: longText });
  assert.match(summary, /\(200 chars\)/);
  assert.ok(summary.length <= 230, `摘要应被截断，实际 ${summary.length}`);

  const manyKeys = summarizeArguments('input_key', { keys: 'x'.repeat(150) });
  assert.ok(manyKeys.length <= 230);
  assert.match(manyKeys, /…/);
});

test('createAuditLog 追加 JSONL 并保留参数摘要', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'audit.jsonl');
  const audit = createAuditLog({ file, logger: { warn() {} } });
  assert.equal(audit.enabled, true);
  assert.equal(audit.write({ ts: '2026-01-01T00:00:00.000Z', tool: 'input_mouse_move', args: '{"x":1}', ok: true, ms: 3 }), true);
  assert.equal(audit.write({ ts: '2026-01-01T00:00:01.000Z', tool: 'input_type', args: '{"text":"hi"}', ok: false, code: 'E_SELF_FOCUS', ms: 5 }), true);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.tool, 'input_mouse_move');
  assert.equal(first.ok, true);
  assert.equal(JSON.parse(lines[1]).code, 'E_SELF_FOCUS');
});

test('auditEnabled=false 时不写文件', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'audit.jsonl');
  const audit = createAuditLog({ file, enabled: false });
  assert.equal(audit.enabled, false);
  assert.equal(audit.write({ tool: 'x' }), false);
  assert.equal(fs.existsSync(file), false);
});

test('超过 maxBytes 时轮转到 .1，旧文件被替换', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'audit.jsonl');
  const audit = createAuditLog({ file, maxBytes: 80 });
  audit.write({ tool: 'one', payload: 'x'.repeat(60) });
  audit.write({ tool: 'two', payload: 'x'.repeat(60) });
  const rotated = `${file}.1`;
  assert.equal(fs.existsSync(rotated), true);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
  assert.match(fs.readFileSync(rotated, 'utf8'), /one/);

  audit.write({ tool: 'three', payload: 'x'.repeat(60) });
  assert.match(fs.readFileSync(file, 'utf8'), /two|three/);
  assert.match(fs.readFileSync(rotated, 'utf8'), /one|two/);
});

test('写失败只记 warn，不抛错', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'audit.jsonl');
  fs.mkdirSync(file);
  const warnings = [];
  const audit = createAuditLog({ file, logger: { warn: (message) => warnings.push(message) } });
  assert.equal(audit.write({ tool: 'x' }), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /写审计日志失败/);
});

test('空文件路径时禁用且不建目录', () => {
  const audit = createAuditLog({ file: '' });
  assert.equal(audit.enabled, false);
  assert.equal(audit.write({ tool: 'x' }), false);
});
