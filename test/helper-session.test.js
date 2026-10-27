import assert from 'node:assert/strict';
import test from 'node:test';

import { createHelperSession } from '../lib/helper-session.js';
import {
  createAutoChild,
  createFakeChild,
  createSpawn,
  makeInitResult,
  reply,
} from './fake-helper.js';

const PATHS = {
  powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  helperPath: 'C:\\bundle\\lib\\helper\\input-helper.ps1',
};

/**
 * 造一个会话。
 * @param {{ spawnState?: ReturnType<typeof createSpawn>, session?: object }} [options] - 选项。
 * @returns {{ session: any, spawnState: any }} 会话与假 spawn。
 */
function makeSession(options = {}) {
  const spawnState = options.spawnState ?? createSpawn([createAutoChild()]);
  const session = createHelperSession({
    ...PATHS,
    startupTimeoutMs: 2000,
    requestTimeoutMs: 2000,
    idleTimeoutMs: 60000,
    initArgs: { pauseFile: 'C:\\pause' },
    spawn: spawnState.spawn,
    logger: { info() {}, warn() {} },
    ...options.session,
  });
  return { session, spawnState };
}

test('init 握手成功后 request 走同一条阻塞队列', async () => {
  const child = createAutoChild({ handler: (message) => (message.op === 'ping' ? { pong: true } : { ok: true }) });
  const spawnState = createSpawn([child]);
  const { session } = makeSession({ spawnState });
  const info = await session.ensureStarted();
  assert.equal(info.pid, 4242);
  assert.equal(info.screen.physical.width, 1920);
  assert.equal(session.isRunning(), true);

  const result = await session.request('ping');
  assert.deepEqual(result, { pong: true });
  assert.equal(child.written[0].op, 'init');
  assert.deepEqual(child.written[0].args, { pauseFile: 'C:\\pause' });
  assert.equal(child.written[1].op, 'ping');
  assert.equal(child.written[1].id, 2);

  const calls = spawnState.calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, PATHS.powershellPath);
  assert.deepEqual(calls[0].args, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', PATHS.helperPath,
  ]);
  assert.equal(calls[0].options.windowsHide, true);
  session.dispose();
  assert.equal(child.ended, true);
});

test('ensureStarted 可并发复用同一个启动 Promise', async () => {
  const spawnState = createSpawn([createAutoChild()]);
  const { session } = makeSession({ spawnState });
  const [first, second] = await Promise.all([session.ensureStarted(), session.ensureStarted()]);
  assert.equal(first, second);
  assert.equal(spawnState.calls.length, 1);
  session.dispose();
});

test('init 期间 helper 回 id=null 的 E_HELPER_START 会拒绝启动', async () => {
  const child = createFakeChild({
    onRequest(message, self) {
      if (message.op === 'init') {
        reply(self, { id: null, ok: false, error: { code: 'E_HELPER_START', message: 'Add-Type failed' } });
      }
    },
  });
  const spawnState = createSpawn([child]);
  const { session } = makeSession({ spawnState });
  await assert.rejects(session.ensureStarted(), (error) => {
    assert.equal(error.code, 'E_HELPER_START');
    assert.match(error.detail ?? '', /Add-Type failed/);
    return true;
  });
  assert.equal(session.isRunning(), false);
});

test('init 版本不匹配按 E_HELPER_START 处理', async () => {
  const child = createAutoChild({ init: makeInitResult({ protocol: 9 }) });
  const { session } = makeSession({ spawnState: createSpawn([child]) });
  await assert.rejects(session.ensureStarted(), (error) => {
    assert.equal(error.code, 'E_HELPER_START');
    assert.match(error.detail ?? '', /协议版本不匹配/);
    return true;
  });
});

test('非 Windows 平台直接拒绝且不启动进程', async () => {
  let spawned = false;
  const { session } = makeSession({
    session: {
      platform: 'linux',
      spawn: () => {
        spawned = true;
        throw new Error('should not spawn');
      },
    },
  });
  await assert.rejects(session.ensureStarted(), (error) => error.code === 'E_UNSUPPORTED_PLATFORM');
  assert.equal(spawned, false);
});

test('启动时 spawn 抛错按 E_HELPER_START 处理', async () => {
  const { session } = makeSession({
    session: {
      spawn: () => {
        throw new Error('ENOENT');
      },
    },
  });
  await assert.rejects(session.ensureStarted(), (error) => {
    assert.equal(error.code, 'E_HELPER_START');
    return true;
  });
});

test('子进程 error 事件拒绝启动', async () => {
  const child = createFakeChild();
  const { session } = makeSession({ spawnState: createSpawn([child]) });
  const pending = session.ensureStarted();
  child.emit('error', new Error('EPERM'));
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'E_HELPER_START');
    assert.match(error.detail ?? '', /EPERM/);
    return true;
  });
});

test('请求超时会杀进程并返回 E_HELPER_TIMEOUT，下次调用自动重启', async () => {
  const first = createAutoChild({ handler: () => null });
  const second = createAutoChild({ handler: () => ({ moved: true }) });
  const spawnState = createSpawn([first, second]);
  const { session } = makeSession({ spawnState });
  await session.ensureStarted();
  await assert.rejects(session.request('move', {}, { timeoutMs: 50 }), (error) => error.code === 'E_HELPER_TIMEOUT');
  assert.equal(first.killed, true);

  const result = await session.request('move', {});
  assert.deepEqual(result, { moved: true });
  assert.equal(spawnState.calls.length, 2);
  session.dispose();
});

test('超时错误带上 stderr 现场', async () => {
  const child = createAutoChild({ handler: () => null });
  const { session } = makeSession({ spawnState: createSpawn([child]) });
  await session.ensureStarted();
  const pending = session.request('move', {}, { timeoutMs: 120 });
  child.stderr.write('fatal: helper exploded\n');
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'E_HELPER_TIMEOUT');
    assert.match(error.detail ?? '', /helper exploded/);
    return true;
  });
  session.dispose();
});

test('helper 意外退出会拒绝在途请求，下一次调用重启', async () => {
  const first = createAutoChild({ handler: () => null });
  const second = createAutoChild({ handler: () => ({ ok: true }) });
  const spawnState = createSpawn([first, second]);
  const { session } = makeSession({ spawnState });
  await session.ensureStarted();
  const pending = session.request('click', {});
  first.emit('exit', 1, null);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'E_HELPER_EXIT');
    return true;
  });
  assert.equal(session.isRunning(), false);
  assert.deepEqual(await session.request('click', {}), { ok: true });
  assert.equal(spawnState.calls.length, 2);
  session.dispose();
});

test('非法协议行会以 E_PROTOCOL 终止进程', async () => {
  const child = createAutoChild({ handler: () => null });
  const { session } = makeSession({ spawnState: createSpawn([child]) });
  await session.ensureStarted();
  const pending = session.request('ping', {}, { timeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write('!!!not-a-protocol-line!!!\n');
  await assert.rejects(pending, (error) => error.code === 'E_PROTOCOL');
  session.dispose();
});

test('helper 业务错误按 code 映射成中文提示', async () => {
  const child = createAutoChild({ handler: () => Object.assign(new Error('foreground is the app'), { code: 'E_SELF_FOCUS' }) });
  const { session } = makeSession({ spawnState: createSpawn([child]) });
  await session.ensureStarted();
  await assert.rejects(session.request('type', { text: 'x' }), (error) => {
    assert.equal(error.code, 'E_SELF_FOCUS');
    assert.match(error.message, /前台窗口/);
    assert.match(error.detail ?? '', /foreground is the app/);
    return true;
  });
  session.dispose();
});

test('队列上限返回 E_HELPER_BUSY', async () => {
  const child = createAutoChild({ handler: () => null });
  const { session } = makeSession({ spawnState: createSpawn([child]) });
  await session.ensureStarted();
  const settled = Array.from({ length: 10 }, () => session.request('move', {}).then(
    () => 'ok',
    (error) => error.code,
  ));
  await new Promise((resolve) => setImmediate(resolve));
  session.dispose();
  const codes = await Promise.all(settled);
  assert.ok(codes.includes('E_HELPER_BUSY'), `应有一条 busy，实际 ${codes.join(',')}`);
  assert.equal(codes.filter((code) => code === 'E_HELPER_BUSY').length, 1);
});

test('dispose 拒绝在途请求并优雅关闭 stdin', async () => {
  const child = createAutoChild({ handler: () => null });
  const { session } = makeSession({ spawnState: createSpawn([child]) });
  await session.ensureStarted();
  const pending = session.request('move', {}, { timeoutMs: 5000 });
  await new Promise((resolve) => setImmediate(resolve));
  session.dispose();
  await assert.rejects(pending, (error) => error.code === 'E_HELPER_EXIT');
  assert.equal(child.ended, true);
  assert.equal(session.isRunning(), false);
  await assert.rejects(session.request('move', {}), (error) => error.code === 'E_HELPER_EXIT');
});
