/**
 * 坐标换算与边界校验。
 *
 * 约定：helper 报告的 `screen.physical` 是虚拟屏物理像素；逻辑坐标按**主屏**缩放换算。
 * 多显示器且混合 DPI 时逻辑坐标只能近似（写入 README 限制）。
 *
 * @module @local/input/coordinates
 */

import { inputError } from './errors.js';

/**
 * 把参数收成整数；模型偶尔给字符串。
 * @param {unknown} value - 原始值。
 * @param {string} name - 参数名（用于报错）。
 * @returns {number} 整数。
 * @throws {import('./errors.js').InputError} 不是有限数字时。
 */
export function toInteger(value, name) {
  if (value === undefined || value === null || value === '') {
    throw inputError('E_BAD_ARGS', `缺少参数 ${name}。`);
  }
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) throw inputError('E_BAD_ARGS', `参数 ${name} 必须是数字，收到 ${String(value)}。`);
  return Math.trunc(parsed);
}

/**
 * 归一坐标空间。
 * @param {unknown} value - 模型传入的 space。
 * @param {'physical' | 'logical'} fallback - 默认值。
 * @returns {'physical' | 'logical'} 归一后的空间。
 * @throws {import('./errors.js').InputError} 非法取值时。
 */
export function normalizeSpace(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const space = String(value).trim().toLowerCase();
  if (space !== 'physical' && space !== 'logical') {
    throw inputError('E_BAD_ARGS', `space 只能是 physical 或 logical，收到 ${String(value)}。`);
  }
  return space;
}

/**
 * 判断点是否在矩形内（含左上、不含右下）。
 * @param {{ x: number, y: number, width: number, height: number }} rect - 矩形。
 * @param {{ x: number, y: number }} point - 点。
 * @returns {boolean} 是否在内部。
 */
export function containsPoint(rect, point) {
  return point.x >= rect.x
    && point.y >= rect.y
    && point.x < rect.x + rect.width
    && point.y < rect.y + rect.height;
}

/**
 * 矩形渲染成一行。
 * @param {{ x: number, y: number, width: number, height: number }} rect - 矩形。
 * @returns {string} 文本。
 */
export function describeRect(rect) {
  return `(${rect.x}, ${rect.y}) 起 ${rect.width}×${rect.height}`;
}

/**
 * 把物理点换算成逻辑坐标。
 * @param {{ x: number, y: number }} point - 物理坐标。
 * @param {{ scale: number }} screen - 屏幕信息。
 * @returns {{ x: number, y: number }} 逻辑坐标。
 */
export function toLogicalPoint(point, screen) {
  const scale = Number.isFinite(screen?.scale) && screen.scale > 0 ? screen.scale : 1;
  return { x: Math.round(point.x / scale), y: Math.round(point.y / scale) };
}

/**
 * 解析绝对坐标参数并按配置校验边界。
 * @param {{ x?: unknown, y?: unknown, space?: unknown }} args - 工具参数。
 * @param {{ screen: { physical: object, scale: number }, defaultSpace?: 'physical'|'logical', allowOutOfBounds?: boolean }} options - 上下文。
 * @returns {{ space: 'physical'|'logical', requested: {x:number,y:number}, physical: {x:number,y:number} }} 结果。
 * @throws {import('./errors.js').InputError} 缺参数或越界时。
 */
export function resolvePoint(args, options) {
  const { screen, defaultSpace = 'physical', allowOutOfBounds = false } = options;
  const space = normalizeSpace(args.space, defaultSpace);
  const x = toInteger(args.x, 'x');
  const y = toInteger(args.y, 'y');
  const scale = Number.isFinite(screen?.scale) && screen.scale > 0 ? screen.scale : 1;
  const physical = space === 'logical' ? { x: Math.round(x * scale), y: Math.round(y * scale) } : { x, y };
  if (!allowOutOfBounds && !containsPoint(screen.physical, physical)) {
    throw inputError(
      'E_BOUNDS',
      `目标 (${x}, ${y})（${space}）超出屏幕 ${describeRect(screen.physical)}；换坐标或把 allowOutOfBounds 设为 true。`,
    );
  }
  return { space, requested: { x, y }, physical };
}

/**
 * 解析相对位移。
 * @param {{ dx?: unknown, dy?: unknown }} args - 工具参数。
 * @returns {{ x: number, y: number }} 位移。
 * @throws {import('./errors.js').InputError} 缺参数时。
 */
export function resolveDelta(args) {
  return { x: toInteger(args.dx, 'dx'), y: toInteger(args.dy, 'dy') };
}

/**
 * 解析截图区域（可选）。
 * @param {{ region?: unknown, space?: unknown }} args - 工具参数。
 * @param {{ screen: { physical: object, scale: number }, defaultSpace?: 'physical'|'logical', allowOutOfBounds?: boolean }} options - 上下文。
 * @returns {{ x: number, y: number, width: number, height: number } | undefined} 物理区域；未指定时为 undefined。
 * @throws {import('./errors.js').InputError} 区域非法或越界时。
 */
export function resolveRegion(args, options) {
  const { screen, defaultSpace = 'physical', allowOutOfBounds = false } = options;
  const raw = args.region;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw inputError('E_BAD_ARGS', 'region 必须是 {x,y,width,height} 对象。');
  const space = normalizeSpace(args.space, defaultSpace);
  const scale = Number.isFinite(screen?.scale) && screen.scale > 0 ? screen.scale : 1;
  const factor = space === 'logical' ? scale : 1;
  const x = Math.round(toInteger(raw.x, 'region.x') * factor);
  const y = Math.round(toInteger(raw.y, 'region.y') * factor);
  const width = Math.round(toInteger(raw.width, 'region.width') * factor);
  const height = Math.round(toInteger(raw.height, 'region.height') * factor);
  if (width <= 0 || height <= 0) throw inputError('E_BAD_ARGS', 'region 的 width/height 必须大于 0。');
  const region = { x, y, width, height };
  const screenRect = screen.physical;
  const inside = region.x >= screenRect.x
    && region.y >= screenRect.y
    && region.x + region.width <= screenRect.x + screenRect.width
    && region.y + region.height <= screenRect.y + screenRect.height;
  if (!allowOutOfBounds && !inside) {
    throw inputError('E_BOUNDS', `截图区域 ${describeRect(region)} 超出屏幕 ${describeRect(screenRect)}。`);
  }
  return region;
}
