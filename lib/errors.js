/**
 * 错误码与用户可见提示。
 *
 * helper 只回英文 `code` + 英文 `message`；中文提示统一由这里生成，
 * 这样 PowerShell 脚本可以保持纯 ASCII（Windows PowerShell 5.1 无 BOM 时按 ANSI 读文件）。
 *
 * @module @local/input/errors
 */

/** 错误码 → 中文默认提示。工具层可以在此基础上追加细节。 */
export const ERROR_MESSAGES = {
  E_PAUSED: '输入已暂停：暂停文件存在时所有注入类操作都会被拒绝。',
  E_SELF_FOCUS: '前台窗口是本应用（DeepSeek Harness），为避免把按键打进自己的聊天框，这次键入已被拒绝。',
  E_BOUNDS: '目标坐标超出屏幕范围。',
  E_BAD_ARGS: '参数不合法。',
  E_BAD_KEY: '无法识别的键名。',
  E_TEXT_TOO_LONG: '文本超过长度上限。',
  E_WINDOW_NOT_FOUND: '找不到目标窗口。',
  E_HELPER_START: '键鼠 helper 启动失败。',
  E_HELPER_TIMEOUT: '键鼠 helper 响应超时，已终止进程；下次调用会自动重启。',
  E_HELPER_EXIT: '键鼠 helper 意外退出。',
  E_HELPER_BUSY: '输入队列已满：同一时间只允许少量排队操作。',
  E_PROTOCOL: '键鼠 helper 协议错误。',
  E_UNSUPPORTED_PLATFORM: '当前平台不支持键鼠控制（仅支持 Windows）。',
  E_INPUT_FAILED: 'Windows 拒绝了这次输入注入。',
  E_SCREENSHOT_FAILED: '截图失败。',
};

/**
 * 带错误码的插件错误。
 */
export class InputError extends Error {
  /**
   * @param {string} code - 错误码（`E_*`）。
   * @param {string} message - 用户可见提示。
   * @param {{ detail?: string, cause?: unknown }} [options] - 诊断细节与底层原因。
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'InputError';
    this.code = code;
    if (typeof options.detail === 'string' && options.detail !== '') this.detail = options.detail;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * 造一个带默认中文提示的错误。
 * @param {string} code - 错误码。
 * @param {string} [message] - 覆盖默认提示。
 * @param {{ detail?: string, cause?: unknown }} [options] - 诊断细节。
 * @returns {InputError} 错误对象。
 */
export function inputError(code, message, options = {}) {
  const fallback = ERROR_MESSAGES[code] ?? code;
  return new InputError(code, typeof message === 'string' && message !== '' ? message : fallback, options);
}

/**
 * 把任意异常收成 InputError（保留原始信息在 detail 里）。
 * @param {unknown} error - 任意异常。
 * @param {string} [fallbackCode] - 没有错误码时使用的码。
 * @returns {InputError} 归一后的错误。
 */
export function normalizeError(error, fallbackCode = 'E_INPUT_FAILED') {
  if (error instanceof InputError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof Error && typeof error.stack === 'string' ? error.stack : undefined;
  return inputError(fallbackCode, message === '' ? undefined : message, { detail, cause: error });
}

/**
 * 把 helper 响应的 `error` 字段转成 InputError。
 * @param {{ code?: string, message?: string }} error - helper 返回的错误。
 * @returns {InputError} 错误对象。
 */
export function fromHelperError(error) {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'E_INPUT_FAILED';
  const message = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.E_INPUT_FAILED;
  const detail = typeof error?.message === 'string' && error.message !== '' ? error.message : undefined;
  return inputError(code, message, { detail });
}

/**
 * 渲染错误为一行文本（状态类工具用，不抛错）。
 * @param {unknown} error - 任意异常。
 * @returns {string} 文本。
 */
export function describeError(error) {
  const normalized = normalizeError(error);
  const parts = [`${normalized.code}：${normalized.message}`];
  if (typeof normalized.detail === 'string' && normalized.detail.trim() !== '') {
    parts.push(`  细节：${normalized.detail.trim().split(/\r?\n/).slice(0, 3).join(' / ')}`);
  }
  return parts.join('\n');
}
