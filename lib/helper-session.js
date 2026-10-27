/**
 * 键鼠 helper 的生命周期：启动、串行队列、超时杀进程、崩溃后重启、空闲回收。
 *
 * 设计要点：
 * - 常驻一个 `powershell.exe`（冷启动实测 ~2.7s，不能每次调用都起进程）；
 * - 单请求串行（同一时间只允许一条命令在途），队列上限 8；
 * - 超时/协议错误一律**杀进程**，下次调用透明重启，避免半死状态；
 * - 空闲 `idleTimeoutMs` 后 `stdin.end()`（EOF），helper 自己释放按下的键再退出。
 *
 * `spawn` 可注入，测试用假子进程覆盖全部生命周期分支，不产生真实输入。
 *
 * @module @local/input/helper-session
 */

import { spawn as defaultSpawn } from 'node:child_process';
import path from 'node:path';

import { fromHelperError, inputError, InputError } from './errors.js';
import { decodeLine, encodeLine, makeRequest, readResult, validateInitResult } from './protocol.js';

const MAX_QUEUE = 8;
const QUIT_GRACE_MS = 1500;
const STDERR_TAIL_CHARS = 4096;
const MAX_STDOUT_BUFFER = 4 * 1024 * 1024;

/**
 * 造一个 helper 会话。
 * @param {{
 *   powershellPath: string, helperPath: string,
 *   startupTimeoutMs?: number, requestTimeoutMs?: number, idleTimeoutMs?: number,
 *   initArgs?: Record<string, unknown>, spawn?: Function, logger?: { info?: Function, warn?: Function },
 *   platform?: string,
 * }} options - 选项。
 * @returns {{
 *   ensureStarted: () => Promise<Record<string, any>>,
 *   request: (op: string, args?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<Record<string, any>>,
 *   getInfo: () => Record<string, any> | null,
 *   isRunning: () => boolean,
 *   dispose: () => void,
 * }} 会话。
 */
export function createHelperSession(options) {
  const powershellPath = options?.powershellPath;
  const helperPath = options?.helperPath;
  if (typeof powershellPath !== 'string' || powershellPath === '') throw new TypeError('createHelperSession 需要 powershellPath');
  if (typeof helperPath !== 'string' || helperPath === '') throw new TypeError('createHelperSession 需要 helperPath');

  const startupTimeoutMs = Number.isFinite(options.startupTimeoutMs) ? options.startupTimeoutMs : 30000;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : 15000;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : 300000;
  const initArgs = options.initArgs !== null && typeof options.initArgs === 'object' ? options.initArgs : {};
  const spawn = typeof options.spawn === 'function' ? options.spawn : defaultSpawn;
  const logger = options.logger;
  const platform = typeof options.platform === 'string' ? options.platform : process.platform;

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  /** @type {Promise<Record<string, any>> | null} */
  let startPromise = null;
  /** @type {Record<string, any> | null} */
  let info = null;
  let nextId = 1;
  const queue = [];
  /** @type {null | { id: number, op: string, args: object, timeoutMs: number, resolve: Function, reject: Function, timer: any }} */
  let inflight = null;
  let stdoutBuffer = '';
  let stderrTail = '';
  /** @type {NodeJS.Timeout | null} */
  let idleTimer = null;
  let disposed = false;

  const log = (level, message) => {
    try {
      logger?.[level]?.(`[input] ${message}`);
    } catch {
      // 日志不可用不影响会话。
    }
  };

  const stderrDetail = () => {
    const text = stderrTail.trim();
    return text === '' ? undefined : text.slice(-1200);
  };

  /** 造一个带 stderr 现场与底层原因的 helper 错误。 */
  const failure = (code, message, cause) => {
    const causeText = cause instanceof Error
      ? cause.message
      : typeof cause === 'string' && cause !== ''
        ? cause
        : undefined;
    const detail = [stderrDetail(), causeText].filter((part) => typeof part === 'string' && part !== '').join(' | ');
    return inputError(code, message, { detail: detail === '' ? undefined : detail, cause });
  };

  const clearIdle = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const rejectPending = (error) => {
    if (inflight !== null) {
      clearTimeout(inflight.timer);
      inflight.reject(error);
      inflight = null;
    }
    while (queue.length > 0) {
      const job = queue.shift();
      clearTimeout(job.timer);
      job.reject(error);
    }
  };

  /**
   * 停掉当前子进程并拒绝所有排队工作。
   * @param {{ graceful?: boolean, reason?: string }} [stopOptions] - 停法。
   * @returns {void}
   */
  const stopChild = (stopOptions = {}) => {
    const graceful = stopOptions.graceful !== false;
    const reason = typeof stopOptions.reason === 'string' ? stopOptions.reason : '键鼠 helper 已停止。';
    clearIdle();
    const proc = child;
    child = null;
    info = null;
    startPromise = null;
    rejectPending(inputError('E_HELPER_EXIT', reason));
    if (proc === null) return;
    try {
      proc.stdin?.end?.();
    } catch {
      // 管道可能已经坏了。
    }
    const killTimer = setTimeout(() => {
      try {
        proc.kill?.();
      } catch {
        // 已经退出。
      }
    }, graceful ? QUIT_GRACE_MS : 0);
    if (typeof killTimer.unref === 'function') killTimer.unref();
    if (typeof proc.once === 'function') proc.once('exit', () => clearTimeout(killTimer));
    if (!graceful) {
      try {
        proc.kill?.();
      } catch {
        // 已经退出。
      }
    }
  };

  const scheduleIdle = () => {
    clearIdle();
    if (disposed || child === null || inflight !== null || queue.length > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      log('info', 'helper 空闲回收。');
      stopChild({ graceful: true, reason: '键鼠 helper 空闲退出。' });
    }, idleTimeoutMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };

  const failJob = (job, error) => {
    if (inflight === job) {
      clearTimeout(job.timer);
      inflight = null;
    }
    job.reject(error);
    scheduleIdle();
    pump();
  };

  const breakProtocol = (detail) => {
    log('warn', `协议错误：${detail}`);
    rejectPending(inputError('E_PROTOCOL', undefined, { detail }));
    stopChild({ graceful: false, reason: '键鼠 helper 协议错误，进程已终止。' });
  };

  const handleLine = (proc, line) => {
    if (child !== proc) return;
    let message;
    try {
      message = decodeLine(line);
    } catch (error) {
      breakProtocol(`无法解析 helper 输出：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (typeof message.id === 'number') {
      const job = inflight;
      if (job === null || job.id !== message.id) {
        log('warn', `忽略无法匹配的响应 id=${message.id}`);
        return;
      }
      if (message.ok !== true) {
        failJob(job, fromHelperError(message.error));
        return;
      }
      let result;
      try {
        result = readResult(message, job.id);
      } catch (error) {
        failJob(job, inputError('E_PROTOCOL', undefined, { detail: error instanceof Error ? error.message : String(error) }));
        breakProtocol('响应结构不合法');
        return;
      }
      clearTimeout(job.timer);
      inflight = null;
      job.resolve(result);
      scheduleIdle();
      pump();
      return;
    }
    if (message.ok === false) {
      const error = fromHelperError(message.error);
      if (inflight !== null) {
        failJob(inflight, error);
        return;
      }
      log('warn', `helper 主动报错：${error.code} ${error.message}`);
      return;
    }
    breakProtocol(`无法识别的 helper 消息：${JSON.stringify(message).slice(0, 200)}`);
  };

  const onStdout = (proc, chunk) => {
    if (child !== proc) return;
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.trim() !== '') handleLine(proc, line);
      if (child !== proc) return;
      index = stdoutBuffer.indexOf('\n');
    }
    if (stdoutBuffer.length > MAX_STDOUT_BUFFER) {
      breakProtocol('helper 单行输出异常过长');
    }
  };

  const onExit = (proc, code, signal) => {
    if (child !== proc) return;
    const error = failure(
      'E_HELPER_EXIT',
      `键鼠 helper 意外退出（code=${code === null || code === undefined ? 'null' : code}${signal ? `, signal=${signal}` : ''}）。`,
    );
    child = null;
    info = null;
    startPromise = null;
    rejectPending(error);
  };

  const onError = (proc, error) => {
    if (child !== proc) return;
    const wrapped = failure('E_HELPER_START', `键鼠 helper 进程无法启动：${error instanceof Error ? error.message : String(error)}`, error);
    child = null;
    info = null;
    startPromise = null;
    rejectPending(wrapped);
    try {
      proc.kill?.();
    } catch {
      // 已经退出。
    }
  };

  const pump = () => {
    if (inflight !== null || queue.length === 0) return;
    if (child === null) {
      rejectPending(inputError('E_HELPER_EXIT', '键鼠 helper 未运行。'));
      return;
    }
    const job = queue.shift();
    inflight = job;
    job.timer = setTimeout(() => {
      if (inflight !== job) return;
      inflight = null;
      job.reject(
        inputError('E_HELPER_TIMEOUT', `键鼠 helper 在 ${job.timeoutMs}ms 内没有响应（op=${job.op}）；已终止进程。`, {
          detail: stderrDetail(),
        }),
      );
      stopChild({ graceful: false, reason: '键鼠 helper 响应超时，进程已终止。' });
    }, job.timeoutMs);
    if (typeof job.timer.unref === 'function') job.timer.unref();
    let line;
    try {
      line = encodeLine(makeRequest(job.id, job.op, job.args));
    } catch (error) {
      failJob(job, inputError('E_PROTOCOL', '请求无法编码。', { cause: error }));
      return;
    }
    try {
      child.stdin.write(`${line}\n`, (error) => {
        if (error && inflight === job) {
          failJob(job, inputError('E_HELPER_EXIT', '写入键鼠 helper 失败。', { cause: error }));
        }
      });
    } catch (error) {
      failJob(job, inputError('E_HELPER_EXIT', '写入键鼠 helper 失败。', { cause: error }));
    }
  };

  const enqueue = (op, args, timeoutMs) => new Promise((resolve, reject) => {
    if (disposed) {
      reject(inputError('E_HELPER_EXIT', '插件已卸载，键鼠 helper 已停止。'));
      return;
    }
    if (queue.length >= MAX_QUEUE) {
      reject(inputError('E_HELPER_BUSY', `输入队列已满（上限 ${MAX_QUEUE} 条），等当前操作结束再试。`));
      return;
    }
    queue.push({
      id: nextId,
      op,
      args: args !== null && typeof args === 'object' ? args : {},
      timeoutMs,
      resolve,
      reject,
      timer: null,
    });
    nextId += 1;
    pump();
  });

  const spawnChild = () => {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', helperPath];
    log('info', `启动 helper：${powershellPath} -File <包内 input-helper.ps1>`);
    let proc;
    try {
      proc = spawn(powershellPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: path.dirname(helperPath),
        env: { ...process.env },
      });
    } catch (cause) {
      throw failure('E_HELPER_START', '键鼠 helper 进程无法启动。', cause);
    }
    if (proc === null || typeof proc !== 'object') throw failure('E_HELPER_START', '键鼠 helper 进程无法启动。');
    child = proc;
    stdoutBuffer = '';
    stderrTail = '';
    proc.stdout?.setEncoding?.('utf8');
    proc.stderr?.setEncoding?.('utf8');
    proc.stdout?.on?.('data', (chunk) => onStdout(proc, String(chunk)));
    proc.stderr?.on?.('data', (chunk) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-STDERR_TAIL_CHARS);
    });
    proc.stdin?.on?.('error', () => {
      // 进程已经退出时写管道会报错；真正的失败由 exit 分支处理。
    });
    proc.on?.('error', (error) => onError(proc, error));
    proc.on?.('exit', (code, signal) => onExit(proc, code, signal));
    return proc;
  };

  /**
   * 确保 helper 已启动并完成 init 握手。
   * @returns {Promise<Record<string, any>>} init 结果。
   */
  const ensureStarted = () => {
    if (disposed) return Promise.reject(inputError('E_HELPER_EXIT', '插件已卸载，键鼠 helper 已停止。'));
    if (info !== null && child !== null) return Promise.resolve(info);
    if (startPromise !== null) return startPromise;
    const attempt = (async () => {
      if (platform !== 'win32') throw inputError('E_UNSUPPORTED_PLATFORM');
      spawnChild();
      const result = await enqueue('init', initArgs, startupTimeoutMs);
      let validated;
      try {
        validated = validateInitResult(result);
      } catch (error) {
        throw inputError('E_HELPER_START', '键鼠 helper 版本或协议不匹配。', {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      if (disposed) throw inputError('E_HELPER_EXIT', '插件已卸载，键鼠 helper 已停止。');
      info = validated;
      log('info', `helper 就绪：pid=${validated.pid}，屏幕 ${validated.screen.physical.width}×${validated.screen.physical.height}，缩放 ${validated.screen.scale}×。`);
      scheduleIdle();
      return validated;
    })();
    startPromise = attempt;
    attempt.catch((error) => {
      if (startPromise === attempt) startPromise = null;
      stopChild({ graceful: false, reason: '键鼠 helper 启动失败。' });
      log('warn', `helper 启动失败：${error instanceof Error ? error.message : String(error)}`);
    });
    return attempt;
  };

  /**
   * 发一条命令（自动确保 helper 已启动）。
   * @param {string} op - 操作名。
   * @param {Record<string, unknown>} [args] - 参数。
   * @param {{ timeoutMs?: number }} [requestOptions] - 选项。
   * @returns {Promise<Record<string, any>>} result。
   */
  const request = async (op, args = {}, requestOptions = {}) => {
    await ensureStarted();
    const timeoutMs = Number.isFinite(requestOptions.timeoutMs)
      ? Math.max(1000, Math.trunc(requestOptions.timeoutMs))
      : requestTimeoutMs;
    return enqueue(op, args, timeoutMs);
  };

  return {
    ensureStarted,
    request,
    getInfo: () => info,
    isRunning: () => child !== null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopChild({ graceful: true, reason: '插件已卸载，键鼠 helper 已停止。' });
    },
  };
}

/** 让测试能拿到 `InputError` 类型判断。 */
export { InputError };
