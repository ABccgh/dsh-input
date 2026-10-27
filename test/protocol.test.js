import assert from 'node:assert/strict';
import test from 'node:test';

import { HELPER_VERSION, PROTOCOL_VERSION } from '../lib/config.js';
import {
  decodeLine,
  describeScreen,
  encodeLine,
  makeRequest,
  readResult,
  validateInitResult,
} from '../lib/protocol.js';
import { makeInitResult } from './fake-helper.js';

test('encodeLine / decodeLine 中文与 emoji 往返无损', () => {
  const message = { id: 7, op: 'type', args: { text: '你好，世界 DSH 123 🖱️⌨️', n: -1, flag: true } };
  const line = encodeLine(message);
  assert.match(line, /^[A-Za-z0-9+/=]+$/);
  assert.deepEqual(decodeLine(line), message);
});

test('decodeLine 接受首尾空白，拒绝空行/坏 base64/非对象 JSON', () => {
  const line = encodeLine({ a: 1 });
  assert.deepEqual(decodeLine(`  ${line}\n`), { a: 1 });
  assert.throws(() => decodeLine(''), /空协议行/);
  assert.throws(() => decodeLine('  '), /空协议行/);
  assert.throws(() => decodeLine('!!!notbase64!!!'), /JSON/);
  assert.throws(() => decodeLine(Buffer.from('[]', 'utf8').toString('base64')), /JSON 对象/);
  assert.throws(() => decodeLine(Buffer.from('"x"', 'utf8').toString('base64')), /JSON 对象/);
});

test('makeRequest 补空 args，readResult 校验序号与结构', () => {
  assert.deepEqual(makeRequest(3, 'ping'), { id: 3, op: 'ping', args: {} });
  const message = { id: 3, ok: true, result: { pong: true } };
  assert.deepEqual(readResult(message, 3), { pong: true });
  assert.throws(() => readResult(message, 4), /序号不匹配/);
  assert.throws(() => readResult({ id: 3, ok: false, error: {} }, 3), /不是成功状态/);
  assert.throws(() => readResult({ id: 3, ok: true }, 3), /缺少 result/);
  assert.throws(() => readResult({ id: 3, ok: true, result: [] }, 3), /缺少 result/);
});

test('validateInitResult 接受合法 init 结果并校验协议/版本/屏幕', () => {
  const result = makeInitResult();
  assert.equal(validateInitResult(result), result);

  assert.throws(() => validateInitResult({ ...result, protocol: 99 }), /协议版本不匹配/);
  assert.throws(() => validateInitResult({ ...result, helperVersion: '0.0.0' }), /版本不匹配/);
  assert.throws(() => validateInitResult({ ...result, screen: {} }), /物理屏幕尺寸/);
  assert.throws(() => validateInitResult({ ...result, screen: { ...result.screen, physical: { x: 0, y: 0, width: 0, height: 0 } } }), /物理屏幕尺寸/);
  assert.throws(() => validateInitResult({ ...result, screen: { ...result.screen, scale: 0 } }), /缩放比例/);
  assert.equal(HELPER_VERSION, '1.0.0');
  assert.equal(PROTOCOL_VERSION, 1);
});

test('describeScreen 渲染虚拟屏原点与逻辑尺寸', () => {
  const text = describeScreen(makeInitResult().screen);
  assert.match(text, /物理 1920×1080/);
  assert.match(text, /缩放 1\.25×/);
  assert.match(text, /逻辑 1536×864/);
  assert.doesNotMatch(text, /原点/);

  const shifted = describeScreen({
    physical: { x: -1920, y: 0, width: 3840, height: 1080 },
    logical: { width: 3072, height: 864 },
    scale: 1.25,
  });
  assert.match(shifted, /原点 \(-1920, 0\)/);
});
