/**
 * 审计日志：每次注入/聚焦调用追加一行 JSONL。
 *
 * 写失败绝不影响主流程（日志只是证据链，不是安全边界）；文件超过阈值轮转成 `.1`。
 *
 * @module @local/input/audit
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_PREVIEW = 80;
const ARGS_PREVIEW = 220;

/**
 * 把参数压成可审计的短字符串（文本只留前 80 字符，避免日志过大/泄露）。
 * @param {string} toolName - 工具名。
 * @param {Record<string, unknown>} args - 工具参数。
 * @returns {string} 摘要。
 */
export function summarizeArguments(toolName, args) {
  const safe = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (key === 'text' && typeof value === 'string') {
      safe.text = value.length > TEXT_PREVIEW ? `${value.slice(0, TEXT_PREVIEW)}…(${value.length} chars)` : value;
      continue;
    }
    if (typeof value === 'string' && value.length > TEXT_PREVIEW) {
      safe[key] = `${value.slice(0, TEXT_PREVIEW)}…`;
      continue;
    }
    safe[key] = value;
  }
  const json = JSON.stringify({ tool: toolName, args: safe });
  return json.length > ARGS_PREVIEW ? `${json.slice(0, ARGS_PREVIEW)}…` : json;
}

/**
 * 造一个审计写入器。
 * @param {{ file?: string, enabled?: boolean, maxBytes?: number, logger?: { warn?: Function } }} [options] - 选项。
 * @returns {{ file: string, enabled: boolean, write: (entry: Record<string, unknown>) => boolean }} 写入器。
 */
export function createAuditLog(options = {}) {
  const file = typeof options.file === 'string' ? options.file : '';
  const enabled = options.enabled !== false && file !== '';
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
  const logger = options.logger;
  let directoryReady = false;

  const warn = (message) => {
    try {
      logger?.warn?.(message);
    } catch {
      // 日志不可用不影响审计。
    }
  };

  const prepare = () => {
    if (directoryReady) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    directoryReady = true;
  };

  const rotateIfNeeded = () => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.size < maxBytes) return;
    const previous = `${file}.1`;
    try {
      fs.rmSync(previous, { force: true });
    } catch {
      // 删不掉旧轮转文件也继续，rename 会覆盖/失败由下面兜底。
    }
    fs.renameSync(file, previous);
  };

  return {
    file,
    enabled,
    /**
     * 追加一条审计记录。
     * @param {Record<string, unknown>} entry - 记录。
     * @returns {boolean} 是否写入成功。
     */
    write(entry) {
      if (!enabled) return false;
      try {
        prepare();
        rotateIfNeeded();
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
        return true;
      } catch (error) {
        warn(`[input] 写审计日志失败：${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
  };
}
