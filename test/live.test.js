/**
 * 真机 E2E（默认跳过）：`DSH_INPUT_LIVE=1 node --test test/live.test.js`。
 *
 * 会真实拉起 helper、移动光标（之后复原）、截图（之后删除）并跑 selftest。
 * 不向 DSH 自己的窗口输入任何字符。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeConfig, resolvePaths } from '../lib/config.js';
import { createHelperSession } from '../lib/helper-session.js';

const LIVE = process.env.DSH_INPUT_LIVE === '1' && process.platform === 'win32';
const liveTest = LIVE ? test : test.skip;

/**
 * 造一个真机会话。
 * @param {Record<string, unknown>} [initArgs] - init 参数覆盖。
 * @returns {any} 会话。
 */
function createLiveSession(initArgs = {}) {
  const config = normalizeConfig({});
  const paths = resolvePaths(config);
  return createHelperSession({
    powershellPath: paths.powershellPath,
    helperPath: paths.helperPath,
    startupTimeoutMs: 60000,
    requestTimeoutMs: 30000,
    idleTimeoutMs: 60000,
    initArgs: {
      pauseFile: '',
      guardSelf: true,
      selfPids: [process.pid],
      selfTitles: config.selfWindowTitles,
      allowOutOfBounds: false,
      stepDelayMs: 5,
      ...initArgs,
    },
    logger: { info() {}, warn() {} },
  });
}

liveTest('真机：init / status / 光标往返 / 截图 / selftest / 暂停', async () => {
  const session = createLiveSession();
  let original = null;
  try {
    const info = await session.ensureStarted();
    assert.ok(info.screen.physical.width >= 800, JSON.stringify(info.screen));
    assert.ok(info.screen.physical.height >= 600);
    assert.equal(info.dpiAware, true);
    assert.equal(typeof info.helperVersion, 'string');

    const status = await session.request('status');
    assert.ok(Number.isFinite(status.cursor.x) && Number.isFinite(status.cursor.y));
    original = { x: status.cursor.x, y: status.cursor.y };

    const target = {
      x: Math.min(info.screen.physical.x + info.screen.physical.width - 5, original.x + 80),
      y: Math.min(info.screen.physical.y + info.screen.physical.height - 5, original.y + 60),
    };
    const moved = await session.request('move', { x: target.x, y: target.y }, { timeoutMs: 8000 });
    assert.ok(Math.abs(moved.actual.x - target.x) <= 1, `移动落点 x ${moved.actual.x} vs ${target.x}`);
    assert.ok(Math.abs(moved.actual.y - target.y) <= 1, `移动落点 y ${moved.actual.y} vs ${target.y}`);

    const restored = await session.request('move', original, { timeoutMs: 8000 });
    assert.ok(Math.abs(restored.actual.x - original.x) <= 1, `复原 x ${restored.actual.x} vs ${original.x}`);
    assert.ok(Math.abs(restored.actual.y - original.y) <= 1, `复原 y ${restored.actual.y} vs ${original.y}`);

    const shotFile = path.join(os.tmpdir(), `dsh-input-live-${Date.now()}.png`);
    const shot = await session.request('screenshot', { path: shotFile }, { timeoutMs: 20000 });
    assert.ok(fs.existsSync(shotFile), `截图文件不存在：${shotFile}`);
    assert.ok(fs.statSync(shotFile).size > 1000, '截图文件太小');
    assert.equal(shot.width, info.screen.physical.width);
    fs.rmSync(shotFile, { force: true });

    const selftest = await session.request('selftest', {}, { timeoutMs: 90000 });
    const checks = Array.isArray(selftest.checks) ? selftest.checks : [];
    assert.ok(checks.length >= 4, `selftest 检查项过少：${JSON.stringify(selftest)}`);
    const failures = checks.filter((check) => check.status === 'fail');
    assert.equal(failures.length, 0, `selftest 失败：${JSON.stringify(failures)}`);
    assert.ok(checks.some((check) => check.name === 'mouse-move' && check.status === 'ok'), '鼠标往返检查未通过');
    process.stdout.write(`\n[selftest] ${JSON.stringify(selftest)}\n`);
  } finally {
    if (original !== null) {
      try {
        await session.request('move', original, { timeoutMs: 5000 });
      } catch {
        // 复原失败也已经尽力。
      }
    }
    session.dispose();
  }
});

liveTest('真机：暂停文件会拦截注入命令', async () => {
  const pauseFile = path.join(os.tmpdir(), `dsh-input-live-pause-${Date.now()}`);
  const session = createLiveSession({ pauseFile });
  try {
    await session.ensureStarted();
    fs.writeFileSync(pauseFile, '');
    await assert.rejects(session.request('move', { dx: 1, dy: 0 }), (error) => error.code === 'E_PAUSED');
    const status = await session.request('status');
    assert.equal(status.paused, true);
    fs.rmSync(pauseFile, { force: true });
    const moved = await session.request('move', { dx: 0, dy: 0 }, { timeoutMs: 5000 });
    assert.ok(moved.actual);
  } finally {
    try {
      fs.rmSync(pauseFile, { force: true });
    } catch {
      // ignore
    }
    session.dispose();
  }
});
