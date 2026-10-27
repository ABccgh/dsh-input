/**
 * 测试用假 helper 子进程：实现 node:child_process 里会话用到的全部接口。
 *
 * 假进程只做两件事：解码会话写进来的协议行，按测试给的回调回一行响应。
 * 它不产生任何真实输入，也不启动 PowerShell。
 *
 * @module dsh-input/test/fake-helper
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { HELPER_VERSION, PROTOCOL_VERSION } from '../lib/config.js';
import { decodeLine, encodeLine } from '../lib/protocol.js';

/**
 * 造一个合法的 init 结果。
 * @param {Record<string, unknown>} [overrides] - 覆盖字段。
 * @returns {Record<string, any>} init 结果。
 */
export function makeInitResult(overrides = {}) {
  return {
    helperVersion: HELPER_VERSION,
    protocol: PROTOCOL_VERSION,
    pid: 4242,
    psVersion: '5.1.test',
    elevated: true,
    dpiAware: true,
    monitorCount: 1,
    screen: {
      physical: { x: 0, y: 0, width: 1920, height: 1080 },
      logical: { width: 1536, height: 864 },
      scale: 1.25,
    },
    cursor: { x: 100, y: 100 },
    os: { caption: 'Windows test', build: '1' },
    selfPids: [1, 2, 4242],
    ...overrides,
  };
}

/**
 * 往假子进程的 stdout 写一条响应。
 * @param {EventEmitter & { stdout: PassThrough }} child - 假子进程。
 * @param {Record<string, unknown>} message - 响应。
 * @returns {void}
 */
export function reply(child, message) {
  child.stdout.write(`${encodeLine(message)}\n`);
}

/**
 * 造一个假子进程。
 * @param {{ onRequest?: (message: Record<string, any>, child: any) => void }} [options] - 收到请求时的回调。
 * @returns {any} 假子进程。
 */
export function createFakeChild(options = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.written = [];
  child.killed = false;
  child.ended = false;

  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() !== '') {
        const message = decodeLine(line);
        child.written.push(message);
        options.onRequest?.(message, child);
      }
      index = buffer.indexOf('\n');
    }
  });

  const originalEnd = child.stdin.end.bind(child.stdin);
  child.stdin.end = (...args) => {
    child.ended = true;
    return originalEnd(...args);
  };

  child.kill = () => {
    child.killed = true;
    child.emit('exit', null, 'SIGTERM');
  };

  return child;
}

/**
 * 造一个“自动应答”的假子进程。
 *
 * `handler` 返回值约定：`undefined` = 回空 result；`null` = 不回复（用于超时测试）；
 * `Error`（可带 `code`）= 回错误；其它对象 = 回 result。
 * @param {{ init?: Record<string, any>, handler?: (message: Record<string, any>) => any }} [options] - 选项。
 * @returns {any} 假子进程。
 */
export function createAutoChild(options = {}) {
  const init = options.init ?? makeInitResult();
  const handler = options.handler;
  let child;
  child = createFakeChild({
    onRequest(message) {
      if (message.op === 'init') {
        reply(child, { id: message.id, ok: true, result: init });
        return;
      }
      const outcome = handler === undefined ? undefined : handler(message);
      if (outcome === null) return;
      if (outcome instanceof Error) {
        reply(child, {
          id: message.id,
          ok: false,
          error: { code: outcome.code ?? 'E_INPUT_FAILED', message: outcome.message },
        });
        return;
      }
      reply(child, { id: message.id, ok: true, result: outcome ?? {} });
    },
  });
  return child;
}

/**
 * 造一个按顺序返回多个假子进程的 spawn 替身。
 * @param {any[]} children - 依次返回的子进程。
 * @returns {{ spawn: Function, calls: { file: string, args: string[], options: object, child: any }[] }} spawn 与调用记录。
 */
export function createSpawn(children) {
  const calls = [];
  return {
    calls,
    spawn(file, args, options) {
      const child = children[calls.length] ?? createAutoChild();
      calls.push({ file, args, options, child });
      return child;
    },
  };
}
