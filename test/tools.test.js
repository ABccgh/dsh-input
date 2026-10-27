import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { normalizeConfig } from '../lib/config.js';
import { inputError } from '../lib/errors.js';
import { createToolDefinitions } from '../lib/index.js';
import { makeInitResult } from './fake-helper.js';

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

const EXPECTED_TOOLS = [
  'input_key',
  'input_mouse_click',
  'input_mouse_drag',
  'input_mouse_move',
  'input_mouse_scroll',
  'input_screenshot',
  'input_selftest',
  'input_status',
  'input_type',
  'input_window_focus',
  'input_window_list',
];

/**
 * 造一套假依赖 + 工具表。
 * @param {{ config?: object, paths?: object, session?: object, info?: object }} [overrides] - 覆盖项。
 * @returns {{ deps: object, tools: Map<string, object>, calls: object[], audit: any, config: any, paths: any, directory: string }} 世界。
 */
function makeWorld(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-input-tools-'));
  temporaryDirectories.push(directory);
  const config = normalizeConfig({ ...(overrides.config ?? {}) });
  const paths = {
    pauseFile: path.join(directory, 'pause'),
    auditFile: path.join(directory, 'audit.jsonl'),
    screenshotDir: path.join(directory, 'shots'),
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    helperPath: path.join(directory, 'input-helper.ps1'),
    ...(overrides.paths ?? {}),
  };
  const info = overrides.info ?? makeInitResult();
  const calls = [];
  const session = overrides.session ?? {
    async ensureStarted() {
      calls.push({ op: 'ensureStarted' });
      return info;
    },
    async request(op, args, options) {
      calls.push({ op, args, options });
      return defaultReply(op, args);
    },
    dispose() {
      calls.push({ op: 'dispose' });
    },
    getInfo() {
      return info;
    },
  };
  const audit = { entries: [], write(entry) { this.entries.push(entry); } };
  const deps = { config, paths, session, audit, logger: { info() {}, warn() {} } };
  const tools = new Map(createToolDefinitions(deps).map((definition) => [definition.name, definition]));
  return { deps, tools, calls, audit, config, paths, info, directory };
}

function defaultReply(op, args) {
  switch (op) {
    case 'status':
      return {
        cursor: { x: 10, y: 20 },
        foreground: { hwnd: 33, pid: 44, title: 'DeepSeek Harness', processName: 'DeepSeek Harness.exe', isSelf: true },
        paused: false,
        pressedKeys: [],
        uptimeMs: 1200,
      };
    case 'move': {
      const from = { x: 100, y: 100 };
      const actual = Number.isFinite(args.x)
        ? { x: args.x, y: args.y }
        : { x: from.x + (args.dx ?? 0), y: from.y + (args.dy ?? 0) };
      return { from, target: actual, actual, steps: args.steps };
    }
    case 'click':
      return { button: args.button, count: args.count, position: { x: args.x ?? 0, y: args.y ?? 0 }, actual: { x: args.x ?? 0, y: args.y ?? 0 } };
    case 'drag':
      return { from: { x: args.fromX, y: args.fromY }, to: { x: args.toX, y: args.toY }, actual: { x: args.toX, y: args.toY }, steps: args.steps };
    case 'wheel':
      return { delta: args.delta, horizontal: args.horizontal, position: { x: 0, y: 0 } };
    case 'key':
      return { keys: args.keys.map((key) => key.vk), action: args.action, repeat: args.repeat };
    case 'type':
      return { chars: args.text.length, typed: args.text.length, submitted: args.submit };
    case 'windows':
      return {
        total: 2,
        windows: [
          { hwnd: 11, title: 'Demo', pid: 22, processName: 'demo.exe', className: 'X', rect: { x: 0, y: 0, width: 800, height: 600 }, foreground: true, minimized: false, self: false },
          { hwnd: 33, title: 'DeepSeek Harness', pid: 44, processName: 'DeepSeek Harness.exe', className: 'Y', rect: { x: 0, y: 0, width: 1920, height: 1080 }, foreground: false, minimized: false, self: true },
        ],
      };
    case 'focus':
      return { ok: true, previous: { hwnd: 1, title: '旧窗口', pid: 2 }, current: { hwnd: 11, title: 'Demo', pid: 22 }, attempts: 1 };
    case 'screenshot':
      return { path: args.path, width: 100, height: 100, bytes: 0, region: args.region };
    case 'selftest':
      return { ok: true, checks: [{ name: 'dpi', status: 'ok' }, { name: 'mouse-click', status: 'skip', detail: 'no focus' }] };
    default:
      return {};
  }
}

/**
 * 断言 promise 以指定错误码失败。
 * @param {Promise<any>} promise - 被测 promise。
 * @param {string} code - 期望错误码。
 * @returns {Promise<any>} 错误对象。
 */
async function expectCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}：${error.message}`);
    return true;
  });
}

test('恰好注册 11 个工具，描述与输出形状齐全', () => {
  const { tools } = makeWorld();
  assert.deepEqual([...tools.keys()].sort(), EXPECTED_TOOLS);
  for (const [toolName, definition] of tools) {
    assert.equal(definition.name, toolName);
    assert.ok(definition.description.length > 20, `${toolName} 描述太短`);
    assert.equal(typeof definition.parameters, 'object');
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.output.schema, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
  }
});

test('并发标记：只读工具安全，注入类工具不安全', () => {
  const { tools } = makeWorld();
  for (const name of ['input_status', 'input_window_list', 'input_screenshot']) {
    assert.equal(tools.get(name).isConcurrencySafe?.(), true, `${name} 应并发安全`);
  }
  for (const name of ['input_mouse_move', 'input_mouse_click', 'input_mouse_drag', 'input_mouse_scroll', 'input_key', 'input_type', 'input_window_focus', 'input_selftest']) {
    assert.equal(tools.get(name).isConcurrencySafe?.(), false, `${name} 不应并发安全`);
  }
});

test('鼠标绝对移动：物理坐标原样下发并渲染结果', async () => {
  const world = makeWorld();
  const result = await world.tools.get('input_mouse_move').execute({ x: 100, y: 200 });
  const move = world.calls.find((call) => call.op === 'move');
  assert.deepEqual(move.args, { x: 100, y: 200, durationMs: 0, steps: 1 });
  assert.match(result.text, /已移动/);
  assert.match(result.text, /物理 \(100, 200\)/);
});

test('鼠标绝对移动：logical 按 1.25 缩放', async () => {
  const world = makeWorld();
  await world.tools.get('input_mouse_move').execute({ x: 960, y: 540, space: 'logical' });
  const move = world.calls.find((call) => call.op === 'move');
  assert.deepEqual(move.args, { x: 1200, y: 675, durationMs: 0, steps: 1 });
});

test('鼠标相对移动与时长/步数', async () => {
  const world = makeWorld();
  const result = await world.tools.get('input_mouse_move').execute({ dx: 5, dy: -3, durationMs: 300, steps: 10 });
  const move = world.calls.find((call) => call.op === 'move');
  assert.deepEqual(move.args, { dx: 5, dy: -3, durationMs: 300, steps: 10 });
  assert.match(result.text, /相对移动/);
});

test('鼠标移动参数互斥与越界', async () => {
  const world = makeWorld();
  await expectCode(world.tools.get('input_mouse_move').execute({}), 'E_BAD_ARGS');
  await expectCode(world.tools.get('input_mouse_move').execute({ x: 1, y: 2, dx: 3 }), 'E_BAD_ARGS');
  await expectCode(world.tools.get('input_mouse_move').execute({ x: 1 }), 'E_BAD_ARGS');
  await expectCode(world.tools.get('input_mouse_move').execute({ dx: 1 }), 'E_BAD_ARGS');
  await expectCode(world.tools.get('input_mouse_move').execute({ x: 5000, y: 10 }), 'E_BOUNDS');
  assert.equal(world.calls.filter((call) => call.op === 'move').length, 0);
});

test('点击：默认左键一次；指定位移与次数', async () => {
  const world = makeWorld();
  const result = await world.tools.get('input_mouse_click').execute({});
  const click = world.calls.find((call) => call.op === 'click');
  assert.deepEqual(click.args, { button: 'left', count: 1, intervalMs: 40 });
  assert.match(result.text, /点击左键/);

  const second = await world.tools.get('input_mouse_click').execute({ button: 'right', count: 2, x: 10, y: 20 });
  const click2 = world.calls.filter((call) => call.op === 'click')[1];
  assert.deepEqual(click2.args, { button: 'right', count: 2, intervalMs: 40, x: 10, y: 20 });
  assert.match(second.text, /连点 2 次右键/);
});

test('点击参数校验：次数 1–3、按钮枚举', async () => {
  const world = makeWorld();
  await expectCode(world.tools.get('input_mouse_click').execute({ count: 4 }), 'E_BAD_ARGS');
  await expectCode(world.tools.get('input_mouse_click').execute({ button: 'side' }), 'E_BAD_ARGS');
});

test('拖拽：两点都换算并下发', async () => {
  const world = makeWorld();
  const result = await world.tools.get('input_mouse_drag').execute({ fromX: 10, fromY: 20, toX: 300, toY: 400, durationMs: 600 });
  const drag = world.calls.find((call) => call.op === 'drag');
  assert.deepEqual(drag.args, { fromX: 10, fromY: 20, toX: 300, toY: 400, button: 'left', durationMs: 600, steps: 40 });
  assert.match(result.text, /已拖拽/);
  await assert.rejects(
    world.tools.get('input_mouse_drag').execute({ fromX: 0, fromY: 0, toX: 0 }),
    /缺少必填参数 toY/,
  );
});

test('滚轮：格数与方向', async () => {
  const world = makeWorld();
  const result = await world.tools.get('input_mouse_scroll').execute({ delta: 3 });
  const wheel = world.calls.find((call) => call.op === 'wheel');
  assert.deepEqual(wheel.args, { delta: 3, horizontal: false });
  assert.match(result.text, /向上 3 格/);

  await world.tools.get('input_mouse_scroll').execute({ delta: -2, horizontal: true, x: 10, y: 10 });
  const wheel2 = world.calls.filter((call) => call.op === 'wheel')[1];
  assert.equal(wheel2.args.horizontal, true);
  assert.equal(wheel2.args.x, 10);
  await expectCode(world.tools.get('input_mouse_scroll').execute({ delta: 0 }), 'E_BAD_ARGS');
  await expectCode(world.tools.get('input_mouse_scroll').execute({ delta: 11 }), 'E_BAD_ARGS');
});

test('组合键：VK 数组、默认 press、修饰键展开', async () => {
  const world = makeWorld();
  const result = await world.tools.get('input_key').execute({ keys: ['ctrl', 'shift', 's'] });
  const key = world.calls.find((call) => call.op === 'key');
  assert.deepEqual(key.args.keys, [
    { vk: 0x11, extended: false },
    { vk: 0x10, extended: false },
    { vk: 0x53, extended: false },
  ]);
  assert.equal(key.args.action, 'press');
  assert.equal(key.args.repeat, 1);
  assert.equal(key.args.holdMs, 0);
  assert.equal(key.args.delayMs, 0);
  assert.match(result.text, /ctrl\+shift\+s/);
});

test('组合键：down/up、重复次数与非法输入', async () => {
  const world = makeWorld();
  await world.tools.get('input_key').execute({ keys: ['ctrl+s'], action: 'down', repeat: 3, holdMs: 50, delayMs: 10 });
  const key = world.calls.find((call) => call.op === 'key');
  assert.equal(key.args.action, 'down');
  assert.equal(key.args.repeat, 3);
  assert.equal(key.args.holdMs, 50);
  assert.equal(key.args.delayMs, 10);

  await expectCode(world.tools.get('input_key').execute({ keys: ['ctrl'], action: 'teleport' }), 'E_BAD_ARGS');
  await expectCode(world.tools.get('input_key').execute({ keys: ['ctrl'], repeat: 21 }), 'E_BAD_ARGS');
  await expectCode(world.tools.get('input_key').execute({ keys: ['nope'] }), 'E_BAD_KEY');
});

test('文本输入：参数下发与结果渲染', async () => {
  const world = makeWorld();
  const result = await world.tools.get('input_type').execute({ text: '你好 DSH', submit: true, intervalMs: 5 });
  const type = world.calls.find((call) => call.op === 'type');
  assert.deepEqual(type.args, { text: '你好 DSH', intervalMs: 5, submit: true });
  assert.match(result.text, /已输入 6 个字符/);
  assert.match(result.text, /并按下回车/);
});

test('文本长度校验：空与超限', async () => {
  const world = makeWorld();
  await expectCode(world.tools.get('input_type').execute({ text: '' }), 'E_BAD_ARGS');
  await expectCode(world.tools.get('input_type').execute({ text: 'x'.repeat(4001) }), 'E_TEXT_TOO_LONG');
});

test('暂停文件会拦截注入类工具，但不拦只读截图', async () => {
  const world = makeWorld();
  fs.writeFileSync(world.paths.pauseFile, '');
  await expectCode(world.tools.get('input_mouse_move').execute({ x: 10, y: 10 }), 'E_PAUSED');
  await expectCode(world.tools.get('input_type').execute({ text: 'x' }), 'E_PAUSED');

  const shot = await world.tools.get('input_screenshot').execute({});
  assert.match(shot.text, /已截图/);
  assert.ok(world.calls.some((call) => call.op === 'screenshot'));
});

test('dryRun 只返回计划，不下发注入命令，审计标记 dryRun', async () => {
  const world = makeWorld({ config: { dryRun: true } });
  const result = await world.tools.get('input_mouse_move').execute({ x: 10, y: 20 });
  assert.match(result.text, /\[dry-run\]/);
  assert.equal(world.calls.filter((call) => call.op === 'move').length, 0);
  const entry = world.audit.entries.at(-1);
  assert.equal(entry.tool, 'input_mouse_move');
  assert.equal(entry.dryRun, true);
  assert.equal(entry.ok, true);
});

test('helper 守卫错误原样映射（E_SELF_FOCUS 中文提示）', async () => {
  const world = makeWorld({
    session: {
      async ensureStarted() {
        return makeInitResult();
      },
      async request() {
        throw inputError('E_SELF_FOCUS');
      },
      dispose() {},
    },
  });
  await assert.rejects(world.tools.get('input_type').execute({ text: 'x' }), (error) => {
    assert.equal(error.code, 'E_SELF_FOCUS');
    assert.match(error.message, /前台窗口/);
    return true;
  });
});

test('窗口列表：过滤参数与渲染', async () => {
  const world = makeWorld();
  const result = await world.tools.get('input_window_list').execute({ filter: 'demo', limit: 5 });
  const windows = world.calls.find((call) => call.op === 'windows');
  assert.deepEqual(windows.args, { filter: 'demo', limit: 5, includeMinimized: true });
  assert.match(result.text, /hwnd 11/);
  assert.match(result.text, /\[前台\]/);
  assert.match(result.text, /本应用/);
});

test('窗口聚焦：成功后渲染前后台', async () => {
  const world = makeWorld();
  const result = await world.tools.get('input_window_focus').execute({ title: 'Demo' });
  const focus = world.calls.find((call) => call.op === 'focus');
  assert.deepEqual(focus.args, { title: 'Demo', exact: false });
  assert.match(result.text, /已切到前台/);
  assert.match(result.text, /上一个前台/);
});

test('窗口聚焦：失败与参数互斥', async () => {
  const world = makeWorld();
  await expectCode(world.tools.get('input_window_focus').execute({ title: 'a', hwnd: 1 }), 'E_BAD_ARGS');
  await expectCode(world.tools.get('input_window_focus').execute({}), 'E_BAD_ARGS');

  world.deps.session.request = async () => ({ ok: false, hint: 'foreground lock' });
  await expectCode(world.tools.get('input_window_focus').execute({ hwnd: 11 }), 'E_INPUT_FAILED');
});

test('自检结果逐项渲染', async () => {
  const world = makeWorld();
  const result = await world.tools.get('input_selftest').execute({});
  assert.match(result.text, /全部通过/);
  assert.match(result.text, /\[通过\] dpi/);
  assert.match(result.text, /\[跳过\] mouse-click/);
});

test('截图：写入配置目录、路径形状正确、只读不拦暂停', async () => {
  const world = makeWorld();
  const result = await world.tools.get('input_screenshot').execute({});
  const shot = world.calls.find((call) => call.op === 'screenshot');
  assert.match(shot.args.path, new RegExp(`^${world.paths.screenshotDir.replace(/\\/g, '\\\\')}[\\\\/]shot-.*\\.png$`));
  assert.ok(fs.existsSync(world.paths.screenshotDir));
  assert.match(result.text, /已截图/);
});

test('截图区域换算：logical 区域放大 1.25', async () => {
  const world = makeWorld();
  await world.tools.get('input_screenshot').execute({ region: { x: 100, y: 100, width: 200, height: 100 }, space: 'logical' });
  const shot = world.calls.find((call) => call.op === 'screenshot');
  assert.deepEqual(shot.args.region, { x: 125, y: 125, width: 250, height: 125 });
});

test('input_status 渲染屏幕/前台/暂停/审计', async () => {
  const world = makeWorld();
  const result = await world.tools.get('input_status').execute({});
  assert.match(result.text, /屏幕：物理 1920×1080/);
  assert.match(result.text, /缩放 1\.25×/);
  assert.match(result.text, /前台：hwnd 33/);
  assert.match(result.text, /本应用/);
  assert.match(result.text, /暂停：否/);
  assert.match(result.text, /审计：/);
});

test('input_status 在 helper 不可用时返回诊断而不是抛错', async () => {
  const world = makeWorld({
    session: {
      async ensureStarted() {
        throw inputError('E_HELPER_START', '键鼠 helper 启动失败。', { detail: 'PowerShell not found' });
      },
      async request() {
        throw inputError('E_HELPER_START');
      },
      dispose() {},
    },
  });
  const result = await world.tools.get('input_status').execute({});
  assert.match(result.text, /helper 不可用/);
  assert.match(result.text, /E_HELPER_START/);
  assert.match(result.text, /PowerShell not found/);
  assert.match(result.text, /排查/);
});

test('审计记录成功与失败，含错误码', async () => {
  const world = makeWorld();
  await world.tools.get('input_mouse_move').execute({ x: 10, y: 10 });
  await expectCode(world.tools.get('input_mouse_move').execute({ x: 9999, y: 10 }), 'E_BOUNDS');
  const entries = world.audit.entries.filter((entry) => entry.tool === 'input_mouse_move');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].ok, true);
  assert.equal(entries[1].ok, false);
  assert.equal(entries[1].code, 'E_BOUNDS');
  assert.ok(entries[0].ms >= 0);
});

test('未知参数被忽略，不会下发到 helper', async () => {
  const world = makeWorld();
  await world.tools.get('input_mouse_move').execute({ x: 1, y: 1, evil: 'rm -rf' });
  const move = world.calls.find((call) => call.op === 'move');
  assert.deepEqual(move.args, { x: 1, y: 1, durationMs: 0, steps: 1 });
});
