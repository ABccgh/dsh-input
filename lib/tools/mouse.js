/**
 * 鼠标工具：移动、点击、拖拽、滚轮。
 *
 * 所有坐标/时长先校验，再交给 helper；`dryRun` 时只返回计划，不产生输入。
 *
 * @module @local/input/tools/mouse
 */

import { resolveDelta, resolvePoint, toInteger } from '../coordinates.js';
import { inputError } from '../errors.js';
import { defineTool } from '../tool-kit.js';
import {
  TEXT_OUTPUT,
  clampInteger,
  describePoint,
  dryRunText,
  integerIn,
  runTool,
  text,
} from './shared.js';

const BUTTONS = new Map([
  ['left', '左键'],
  ['right', '右键'],
  ['middle', '中键'],
]);

/**
 * 鼠标工具的公共上下文。
 * @param {object} deps - 依赖。
 * @param {Record<string, any>} info - init 结果。
 * @returns {{ screen: object, defaultSpace: string, allowOutOfBounds: boolean, dryRun: boolean }} 选项。
 */
function pointOptions(deps, info) {
  return {
    screen: info.screen,
    defaultSpace: deps.config.coordinateSpace,
    allowOutOfBounds: deps.config.allowOutOfBounds,
    dryRun: deps.config.dryRun,
  };
}

/**
 * 注册 4 个鼠标工具。
 * @param {object} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createMouseTools(deps) {
  return [
    defineTool({
      name: 'input_mouse_move',
      description:
        '移动鼠标。给 x,y 表示移到屏幕绝对坐标，给 dx,dy 表示相对当前位置移动；坐标为物理像素（默认）或逻辑像素（space=logical）。durationMs>0 时平滑移动。'
        + '屏幕尺寸与缩放用 input_status 查。',
      parameters: {
        x: { type: 'integer', description: '绝对横坐标（与 y 同时给）' },
        y: { type: 'integer', description: '绝对纵坐标（与 x 同时给）' },
        dx: { type: 'integer', description: '相对横位移（与 dy 同时给）' },
        dy: { type: 'integer', description: '相对纵位移（与 dx 同时给）' },
        durationMs: { type: 'integer', description: '平滑移动时长，0–5000ms，默认 0（瞬移）' },
        steps: { type: 'integer', description: '平滑移动步数，默认时长>0 时 30' },
        space: { type: 'string', enum: ['physical', 'logical'], description: '坐标空间，默认取插件配置' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      timeoutMs: 30000,
      async execute(args) {
        const hasPoint = args.x !== undefined || args.y !== undefined;
        const hasDelta = args.dx !== undefined || args.dy !== undefined;
        if (hasPoint === hasDelta) throw inputError('E_BAD_ARGS', 'x,y 与 dx,dy 必须二选一。');
        if (hasPoint && (args.x === undefined || args.y === undefined)) throw inputError('E_BAD_ARGS', 'x 与 y 必须同时给。');
        if (hasDelta && (args.dx === undefined || args.dy === undefined)) throw inputError('E_BAD_ARGS', 'dx 与 dy 必须同时给。');
        const durationMs = clampInteger(args.durationMs, 0, 0, 5000);
        const steps = clampInteger(args.steps, durationMs > 0 ? 30 : 1, 1, deps.config.maxMoveSteps);

        return runTool(deps, 'input_mouse_move', args, async () => {
          const info = await deps.session.ensureStarted();
          const options = pointOptions(deps, info);
          let payload;
          let plan;
          if (hasPoint) {
            const point = resolvePoint(args, options);
            payload = { x: point.physical.x, y: point.physical.y, durationMs, steps };
            plan = `把光标移到 ${describePoint(info.screen, point.physical)}`;
          } else {
            const delta = resolveDelta(args);
            payload = { dx: delta.x, dy: delta.y, durationMs, steps };
            plan = `把光标相对移动 (${delta.x}, ${delta.y})`;
          }
          if (options.dryRun) return dryRunText(plan);
          const result = await deps.session.request('move', payload, { timeoutMs: durationMs + 5000 });
          const from = result.from && Number.isFinite(result.from.x) && Number.isFinite(result.from.y) ? result.from : null;
          const actual = result.actual && Number.isFinite(result.actual.x) && Number.isFinite(result.actual.y) ? result.actual : null;
          const head = hasPoint ? '已移动' : `已相对移动 (${payload.dx}, ${payload.dy})`;
          const path = from !== null && actual !== null
            ? `${describePoint(info.screen, from)} → ${describePoint(info.screen, actual)}`
            : actual !== null
              ? describePoint(info.screen, actual)
              : '（helper 未回报落点）';
          return text(`${head}：${path}；${result.steps ?? steps} 步，耗时约 ${durationMs}ms。`);
        });
      },
    }),

    defineTool({
      name: 'input_mouse_click',
      description:
        '点击鼠标。button 支持 left/right/middle，count 1–3（双击/三击）；给 x,y 会先移动到该点再点。不指定坐标就点当前光标位置。'
        + '前台守卫只拦截键盘输入，点击会被审计。',
      parameters: {
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '按键，默认 left' },
        count: { type: 'integer', description: '点击次数 1–3，默认 1' },
        intervalMs: { type: 'integer', description: '多次点击间隔 0–500ms，默认 40' },
        x: { type: 'integer', description: '点击位置横坐标（可选，与 y 同时给）' },
        y: { type: 'integer', description: '点击位置纵坐标（可选）' },
        space: { type: 'string', enum: ['physical', 'logical'], description: '坐标空间，默认取插件配置' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      timeoutMs: 30000,
      async execute(args) {
        const button = args.button === undefined ? 'left' : String(args.button).toLowerCase();
        if (!BUTTONS.has(button)) throw inputError('E_BAD_ARGS', `button 只能是 left/right/middle，收到 ${String(args.button)}。`);
        const count = args.count === undefined ? 1 : integerIn(args.count, 'count', 1, 3);
        const intervalMs = clampInteger(args.intervalMs, 40, 0, 500);
        const hasPoint = args.x !== undefined || args.y !== undefined;
        if (hasPoint && (args.x === undefined || args.y === undefined)) throw inputError('E_BAD_ARGS', 'x 与 y 必须同时给。');

        return runTool(deps, 'input_mouse_click', args, async () => {
          const info = await deps.session.ensureStarted();
          const options = pointOptions(deps, info);
          const payload = { button, count, intervalMs };
          let plan;
          if (hasPoint) {
            const point = resolvePoint(args, options);
            payload.x = point.physical.x;
            payload.y = point.physical.y;
            plan = `在 ${describePoint(info.screen, point.physical)} ${BUTTONS.get(button)}点击 ${count} 次（间隔 ${intervalMs}ms）`;
          } else {
            plan = `在当前光标位置 ${BUTTONS.get(button)}点击 ${count} 次（间隔 ${intervalMs}ms）`;
          }
          if (options.dryRun) return dryRunText(plan);
          const result = await deps.session.request('click', payload, { timeoutMs: 5000 + count * intervalMs });
          const position = result.actual ?? result.position;
          const where = position ? `于 ${describePoint(info.screen, position)}` : '';
          return text(`已${count > 1 ? `连点 ${count} 次` : '点击'}${BUTTONS.get(button)}${where}。`);
        });
      },
    }),

    defineTool({
      name: 'input_mouse_drag',
      description:
        '按住鼠标从一个点拖到另一个点再松开。适合拖动窗口、选中文本、拖拽文件。给起点 (fromX,fromY) 与终点 (toX,toY)，坐标为物理像素（默认）或逻辑像素。',
      parameters: {
        fromX: { type: 'integer', required: true, description: '起点横坐标' },
        fromY: { type: 'integer', required: true, description: '起点纵坐标' },
        toX: { type: 'integer', required: true, description: '终点横坐标' },
        toY: { type: 'integer', required: true, description: '终点纵坐标' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '按键，默认 left' },
        durationMs: { type: 'integer', description: '拖动时长 50–5000ms，默认 300' },
        steps: { type: 'integer', description: '插值步数，默认 40' },
        space: { type: 'string', enum: ['physical', 'logical'], description: '坐标空间，默认取插件配置' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      timeoutMs: 30000,
      async execute(args) {
        const button = args.button === undefined ? 'left' : String(args.button).toLowerCase();
        if (!BUTTONS.has(button)) throw inputError('E_BAD_ARGS', `button 只能是 left/right/middle，收到 ${String(args.button)}。`);
        const durationMs = clampInteger(args.durationMs, 300, 50, 5000);
        const steps = clampInteger(args.steps, 40, 2, deps.config.maxMoveSteps);
        const fromX = toInteger(args.fromX, 'fromX');
        const fromY = toInteger(args.fromY, 'fromY');
        const toX = toInteger(args.toX, 'toX');
        const toY = toInteger(args.toY, 'toY');

        return runTool(deps, 'input_mouse_drag', args, async () => {
          const info = await deps.session.ensureStarted();
          const options = pointOptions(deps, info);
          const from = resolvePoint({ x: fromX, y: fromY, space: args.space }, options);
          const to = resolvePoint({ x: toX, y: toY, space: args.space }, options);
          const plan = `从 ${describePoint(info.screen, from.physical)} 拖到 ${describePoint(info.screen, to.physical)}（${BUTTONS.get(button)}，${durationMs}ms）`;
          if (options.dryRun) return dryRunText(plan);
          const result = await deps.session.request('drag', {
            fromX: from.physical.x,
            fromY: from.physical.y,
            toX: to.physical.x,
            toY: to.physical.y,
            button,
            durationMs,
            steps,
          }, { timeoutMs: durationMs + 5000 });
          const actual = result.actual ?? to.physical;
          return text(`已拖拽：${describePoint(info.screen, from.physical)} → ${describePoint(info.screen, actual)}（${BUTTONS.get(button)}，${result.steps ?? steps} 步）。`);
        });
      },
    }),

    defineTool({
      name: 'input_mouse_scroll',
      description:
        '滚动鼠标滚轮。delta 为格数，正数向上/向右，负数向下/向左，范围 -10..10；horizontal=true 发水平滚轮。可用 x,y 先把光标放到目标位置（例如某个可滚动区域）。',
      parameters: {
        delta: { type: 'integer', required: true, description: '滚轮格数 -10..10（正=上/右）' },
        horizontal: { type: 'boolean', description: '水平滚轮，默认 false' },
        x: { type: 'integer', description: '滚动前把光标移到的横坐标（可选）' },
        y: { type: 'integer', description: '滚动前把光标移到的纵坐标（可选）' },
        space: { type: 'string', enum: ['physical', 'logical'], description: '坐标空间，默认取插件配置' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      timeoutMs: 20000,
      async execute(args) {
        const delta = integerIn(args.delta, 'delta', -10, 10);
        if (delta === 0) throw inputError('E_BAD_ARGS', 'delta 不能为 0。');
        const horizontal = args.horizontal === true;
        const hasPoint = args.x !== undefined || args.y !== undefined;
        if (hasPoint && (args.x === undefined || args.y === undefined)) throw inputError('E_BAD_ARGS', 'x 与 y 必须同时给。');

        return runTool(deps, 'input_mouse_scroll', args, async () => {
          const info = await deps.session.ensureStarted();
          const options = pointOptions(deps, info);
          const payload = { delta, horizontal };
          let plan;
          if (hasPoint) {
            const point = resolvePoint(args, options);
            payload.x = point.physical.x;
            payload.y = point.physical.y;
            plan = `在 ${describePoint(info.screen, point.physical)} ${horizontal ? '水平' : ''}滚动 ${delta} 格`;
          } else {
            plan = `在当前光标位置${horizontal ? '水平' : ''}滚动 ${delta} 格`;
          }
          if (options.dryRun) return dryRunText(plan);
          await deps.session.request('wheel', payload, { timeoutMs: 10000 });
          const direction = horizontal ? (delta > 0 ? '向右' : '向左') : (delta > 0 ? '向上' : '向下');
          return text(`已${horizontal ? '水平' : ''}滚动：${direction} ${Math.abs(delta)} 格${hasPoint ? `（${describePoint(info.screen, { x: payload.x, y: payload.y })}）` : ''}。`);
        });
      },
    }),
  ];
}
