/**
 * helper 线路协议：一行一个 base64(UTF-8(JSON))。
 *
 * 只做编解码与最小结构校验；生命周期（排队、超时、重启）在 `helper-session.js`。
 * 协议原文见 `lib/helper/PROTOCOL.md`。
 *
 * @module @local/input/protocol
 */

import { HELPER_VERSION, PROTOCOL_VERSION } from './config.js';

export { HELPER_VERSION, PROTOCOL_VERSION };

/**
 * 把消息编码成一行协议文本（不含换行）。
 * @param {Record<string, unknown>} message - 任意可 JSON 序列化的消息。
 * @returns {string} base64 文本。
 */
export function encodeLine(message) {
  const json = JSON.stringify(message);
  if (typeof json !== 'string') throw new TypeError('消息无法序列化');
  return Buffer.from(json, 'utf8').toString('base64');
}

/**
 * 解码一行协议文本。
 * @param {string} line - base64 文本（允许首尾空白）。
 * @returns {Record<string, unknown>} 解析后的消息对象。
 * @throws {Error} 空行、非法 base64 或非法 JSON 时。
 */
export function decodeLine(line) {
  const trimmed = String(line ?? '').trim();
  if (trimmed === '') throw new Error('空协议行');
  const json = Buffer.from(trimmed, 'base64').toString('utf8');
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('协议行不是合法 JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('协议消息必须是 JSON 对象');
  }
  return value;
}

/**
 * 造一个请求对象。
 * @param {number} id - 自增序号。
 * @param {string} op - 操作名。
 * @param {Record<string, unknown>} [args] - 参数。
 * @returns {{ id: number, op: string, args: Record<string, unknown> }} 请求。
 */
export function makeRequest(id, op, args = {}) {
  return { id, op, args: args ?? {} };
}

/**
 * 校验并返回响应里的 `result`。
 * @param {Record<string, unknown>} message - 已解码的响应。
 * @param {number} expectedId - 期望的请求序号。
 * @returns {Record<string, unknown>} result 对象。
 * @throws {Error} 序号不匹配、缺少 result、或 ok 不为 true 时。
 */
export function readResult(message, expectedId) {
  if (typeof message.id !== 'number' || message.id !== expectedId) {
    throw new Error(`响应序号不匹配：期望 ${expectedId}，收到 ${String(message.id)}`);
  }
  if (message.ok !== true) throw new Error('响应不是成功状态');
  const result = message.result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('响应缺少 result 对象');
  }
  return result;
}

/**
 * 校验 init 响应里的 helper 身份与屏幕信息，防止旧版本 helper 混进来。
 * @param {Record<string, unknown>} result - init 的 result。
 * @returns {Record<string, unknown>} 原样返回。
 * @throws {Error} 协议版本或关键字段不合法时。
 */
export function validateInitResult(result) {
  if (result.protocol !== PROTOCOL_VERSION) {
    throw new Error(`helper 协议版本不匹配：期望 ${PROTOCOL_VERSION}，收到 ${String(result.protocol)}`);
  }
  if (typeof result.helperVersion !== 'string' || result.helperVersion !== HELPER_VERSION) {
    throw new Error(`helper 版本不匹配：期望 ${HELPER_VERSION}，收到 ${String(result.helperVersion)}`);
  }
  const screen = result.screen;
  const physical = screen?.physical;
  if (
    physical === null
    || typeof physical !== 'object'
    || !Number.isFinite(physical.width)
    || !Number.isFinite(physical.height)
    || physical.width <= 0
    || physical.height <= 0
  ) {
    throw new Error('helper 没有报告有效的物理屏幕尺寸');
  }
  if (!Number.isFinite(screen?.scale) || screen.scale <= 0) {
    throw new Error('helper 没有报告有效的屏幕缩放比例');
  }
  return result;
}

/**
 * 把屏幕信息渲染成一行文本。
 * @param {{ physical: {x: number, y: number, width: number, height: number}, logical: {width: number, height: number}, scale: number }} screen - 屏幕信息。
 * @returns {string} 文本。
 */
export function describeScreen(screen) {
  const { physical, logical, scale } = screen;
  const origin = physical.x === 0 && physical.y === 0 ? '' : `，原点 (${physical.x}, ${physical.y})`;
  return `物理 ${physical.width}×${physical.height}（缩放 ${scale}×，逻辑 ${logical.width}×${logical.height}${origin}）`;
}
