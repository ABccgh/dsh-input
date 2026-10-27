/**
 * 配置归一化与默认路径。
 *
 * 本插件不导出 Cordis `Config`（包住在 DSH 安装作用域之外，不能 import `@deepseek-ai/*`），
 * 由这里的 `normalizeConfig` 兜底：写错的字段回退默认值，而不是让整个插件装不上。
 *
 * @module @local/input/config
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 必须与 `lib/helper/PROTOCOL.md` 和 helper 脚本里的常量一致。 */
export const HELPER_VERSION = '1.0.0';
/** 线路协议版本。 */
export const PROTOCOL_VERSION = 1;
/** 插件版本（与 package.json 保持一致，`test/package.test.js` 会校验）。 */
export const PLUGIN_VERSION = '0.1.0';

const COORDINATE_SPACES = new Set(['physical', 'logical']);
const DEFAULT_SELF_TITLES = ['DeepSeek Harness'];

/** 只保留非空字符串。 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 取非空字符串，否则回退。 */
function textOr(value, fallback) {
  const text = trimmed(value);
  return text === '' ? fallback : text;
}

/** 取布尔值，否则回退。 */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 取有界整数，非法值回退。 */
function intIn(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/** 取字符串数组（去空、去重），空数组回退。 */
function listOr(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const list = [];
  for (const entry of value) {
    const text = trimmed(entry);
    if (text !== '' && !list.includes(text)) list.push(text);
  }
  return list.length > 0 ? list : [...fallback];
}

/** 默认暂停文件：`%TEMP%\dsh-input-pause`。 */
export function defaultPauseFile() {
  return path.join(os.tmpdir(), 'dsh-input-pause');
}

/** 默认审计文件：`%LOCALAPPDATA%\dsh-input\audit.jsonl`。 */
export function defaultAuditFile() {
  const base = trimmed(process.env.LOCALAPPDATA) || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'dsh-input', 'audit.jsonl');
}

/** 默认截图目录：`%TEMP%\dsh-input\shots`。 */
export function defaultScreenshotDir() {
  return path.join(os.tmpdir(), 'dsh-input', 'shots');
}

/** 默认 PowerShell：Windows PowerShell 5.1。 */
export function defaultPowershellPath() {
  const root = trimmed(process.env.SystemRoot) || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** 包内 helper 脚本路径。 */
export function defaultHelperPath() {
  return fileURLToPath(new URL('./helper/input-helper.ps1', import.meta.url));
}

/**
 * 把 loader 传来的配置收进合法范围。
 * @param {Record<string, unknown>} [raw] - loader 透传的配置。
 * @returns {{
 *   powershellPath: string, helperPath: string,
 *   requestTimeoutMs: number, startupTimeoutMs: number, idleTimeoutMs: number,
 *   guardSelfWindow: boolean, selfWindowTitles: string[],
 *   pauseFile: string, auditFile: string, auditEnabled: boolean, dryRun: boolean,
 *   coordinateSpace: 'physical' | 'logical', allowOutOfBounds: boolean,
 *   maxTypedChars: number, maxKeyRepeat: number, maxMoveSteps: number, moveStepDelayMs: number,
 *   screenshotDir: string, maxScreenshots: number,
 * }} 生效配置。
 */
export function normalizeConfig(raw = {}) {
  const base = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const space = typeof base.coordinateSpace === 'string' ? base.coordinateSpace.trim().toLowerCase() : '';
  return {
    powershellPath: trimmed(base.powershellPath),
    helperPath: trimmed(base.helperPath),
    requestTimeoutMs: intIn(base.requestTimeoutMs, 15000, 2000, 120000),
    startupTimeoutMs: intIn(base.startupTimeoutMs, 30000, 5000, 180000),
    idleTimeoutMs: intIn(base.idleTimeoutMs, 300000, 10000, 3600000),
    guardSelfWindow: boolOr(base.guardSelfWindow, true),
    selfWindowTitles: listOr(base.selfWindowTitles, DEFAULT_SELF_TITLES),
    pauseFile: trimmed(base.pauseFile),
    auditFile: trimmed(base.auditFile),
    auditEnabled: boolOr(base.auditEnabled, true),
    dryRun: boolOr(base.dryRun, false),
    coordinateSpace: COORDINATE_SPACES.has(space) ? space : 'physical',
    allowOutOfBounds: boolOr(base.allowOutOfBounds, false),
    maxTypedChars: intIn(base.maxTypedChars, 4000, 1, 50000),
    maxKeyRepeat: intIn(base.maxKeyRepeat, 20, 1, 100),
    maxMoveSteps: intIn(base.maxMoveSteps, 240, 1, 2000),
    moveStepDelayMs: intIn(base.moveStepDelayMs, 8, 0, 100),
    screenshotDir: trimmed(base.screenshotDir),
    maxScreenshots: intIn(base.maxScreenshots, 20, 1, 1000),
  };
}

/**
 * 把配置里的空路径替换成实际默认路径。
 * @param {ReturnType<typeof normalizeConfig>} config - 生效配置。
 * @returns {{ pauseFile: string, auditFile: string, screenshotDir: string, powershellPath: string, helperPath: string }} 绝对路径。
 */
export function resolvePaths(config) {
  return {
    pauseFile: config.pauseFile !== '' ? config.pauseFile : defaultPauseFile(),
    auditFile: config.auditFile !== '' ? config.auditFile : defaultAuditFile(),
    screenshotDir: config.screenshotDir !== '' ? config.screenshotDir : defaultScreenshotDir(),
    powershellPath: config.powershellPath !== '' ? config.powershellPath : defaultPowershellPath(),
    helperPath: config.helperPath !== '' ? config.helperPath : defaultHelperPath(),
  };
}
