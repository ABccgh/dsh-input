/**
 * 工具层共用：统一文本输出、暂停检查、审计包装、点位渲染与数值校验。
 *
 * @module @local/input/tools/shared
 */

import fs from 'node:fs';

import { summarizeArguments } from '../audit.js';
import { toLogicalPoint } from '../coordinates.js';
import { inputError, normalizeError } from '../errors.js';

/**
 * 所有 `input_*` 工具的输出形状：一段给模型读的紧凑文本。
 *
 * DSH 的输出值 schema 是简写 spec，嵌套结构一旦写错会在调用时变成校验失败；
 * 模型真正需要的是可读文本，所以统一成 `{ text }`。
 */
export const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true, description: '给模型阅读的文本结果' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: String(value.text) }],
};

/**
 * 包一个文本结果。
 * @param {unknown} value - 文本。
 * @returns {{ text: string }} 工具返回值。
 */
export function text(value) {
  return { text: String(value) };
}

/**
 * 暂停文件是否存在。
 * @param {string} pauseFile - 路径。
 * @returns {boolean} 是否存在。
 */
export function isPaused(pauseFile) {
  if (typeof pauseFile !== 'string' || pauseFile === '') return false;
  try {
    return fs.existsSync(pauseFile);
  } catch {
    return false;
  }
}

/**
 * 人类可读的字节数。
 * @param {number} bytes - 字节数。
 * @returns {string} 文本。
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 同时渲染物理与逻辑坐标。
 * @param {{ scale: number }} screen - 屏幕信息。
 * @param {{ x: number, y: number }} physical - 物理坐标。
 * @returns {string} 文本。
 */
export function describePoint(screen, physical) {
  const logical = toLogicalPoint(physical, screen);
  return `物理 (${physical.x}, ${physical.y}) / 逻辑 (${logical.x}, ${logical.y})`;
}

/**
 * 写一条审计记录（写失败不影响主流程）。
 * @param {object} deps - 依赖。
 * @param {string} toolName - 工具名。
 * @param {Record<string, unknown>} args - 参数。
 * @param {{ ok?: boolean, ms?: number, code?: string }} [outcome] - 结果。
 * @returns {void}
 */
export function auditEntry(deps, toolName, args, outcome = {}) {
  const entry = {
    ts: new Date().toISOString(),
    tool: toolName,
    args: summarizeArguments(toolName, args),
    ok: outcome.ok !== false,
    ms: Number.isFinite(outcome.ms) ? outcome.ms : 0,
  };
  if (deps.config.dryRun) entry.dryRun = true;
  if (typeof outcome.code === 'string') entry.code = outcome.code;
  deps.audit.write(entry);
}

/**
 * 注入类工具的统一外壳：暂停检查 → 执行 → 审计。
 * @param {object} deps - 依赖。
 * @param {string} toolName - 工具名。
 * @param {Record<string, unknown>} args - 参数。
 * @param {() => Promise<{ text: string }>} action - 实际动作。
 * @param {{ pause?: boolean }} [options] - `pause:false` 用于只读工具（截图/窗口列表）。
 * @returns {Promise<{ text: string }>} 工具返回值。
 */
export async function runTool(deps, toolName, args, action, options = {}) {
  const started = Date.now();
  const checkPause = options.pause !== false;
  if (checkPause && isPaused(deps.paths.pauseFile)) {
    const error = inputError(
      'E_PAUSED',
      `输入已暂停：检测到暂停文件 ${deps.paths.pauseFile}。删掉它（Remove-Item "${deps.paths.pauseFile}"）后重试。`,
    );
    auditEntry(deps, toolName, args, { ok: false, code: error.code, ms: Date.now() - started });
    throw error;
  }
  try {
    const value = await action();
    auditEntry(deps, toolName, args, { ok: true, ms: Date.now() - started });
    return value;
  } catch (error) {
    const normalized = normalizeError(error);
    auditEntry(deps, toolName, args, { ok: false, code: normalized.code, ms: Date.now() - started });
    throw normalized;
  }
}

/**
 * dry-run 的统一返回。
 * @param {string} plan - 计划文本。
 * @returns {{ text: string }} 工具返回值。
 */
export function dryRunText(plan) {
  return text(`[dry-run] 未注入任何输入。计划：${plan}\n把配置 dryRun 设为 false 后才会真正执行。`);
}

/**
 * 必填整数并检查范围。
 * @param {unknown} value - 原始值。
 * @param {string} name - 参数名。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @returns {number} 整数。
 */
export function integerIn(value, name, min, max) {
  if (value === undefined || value === null || value === '') throw inputError('E_BAD_ARGS', `缺少参数 ${name}。`);
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) throw inputError('E_BAD_ARGS', `参数 ${name} 必须是数字，收到 ${String(value)}。`);
  const integer = Math.trunc(parsed);
  if (integer < min || integer > max) {
    throw inputError('E_BAD_ARGS', `参数 ${name} 必须在 ${min}..${max} 之间，收到 ${integer}。`);
  }
  return integer;
}

/**
 * 可选整数：缺省用默认值，超出范围夹紧（时长/步数这类）。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 默认值。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @returns {number} 整数。
 */
export function clampInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}
