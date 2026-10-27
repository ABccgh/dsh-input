/**
 * 窗口工具：枚举可见顶层窗口、把目标窗口切到前台。
 *
 * 键盘输入落到前台窗口，所以「先聚焦、再键入」是使用 `input_key`/`input_type` 的正确姿势。
 *
 * @module @local/input/tools/window
 */

import { inputError } from '../errors.js';
import { defineTool } from '../tool-kit.js';
import { TEXT_OUTPUT, clampInteger, dryRunText, integerIn, runTool, text } from './shared.js';

/**
 * 渲染一个窗口。
 * @param {{ hwnd: number, title: string, pid: number, processName?: string, rect?: object, foreground?: boolean, minimized?: boolean, self?: boolean }} entry - 窗口。
 * @returns {string} 文本。
 */
function describeWindow(entry) {
  const flags = [
    entry.foreground ? '前台' : '',
    entry.self ? '本应用' : '',
    entry.minimized ? '最小化' : '',
  ].filter((flag) => flag !== '');
  const title = entry.title ? `「${entry.title}」` : '（无标题）';
  const process = entry.processName ? ` — ${entry.processName}` : '';
  const rect = entry.rect ? `(${entry.rect.x},${entry.rect.y}) ${entry.rect.width}×${entry.rect.height}` : '';
  return `hwnd ${entry.hwnd}  pid ${entry.pid}  ${flags.length > 0 ? `[${flags.join('][')}] ` : ''}${title}${process}  ${rect}`.trimEnd();
}

/**
 * 注册 2 个窗口工具。
 * @param {object} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createWindowTools(deps) {
  return [
    defineTool({
      name: 'input_window_list',
      description:
        '列出当前可见的顶层窗口：hwnd、标题、进程、物理矩形、是否前台/最小化/本应用。可按标题子串过滤。只读，用来找聚焦目标或截图区域。',
      parameters: {
        filter: { type: 'string', description: '标题子串（不区分大小写）' },
        limit: { type: 'integer', description: '最多返回几条 1–100，默认 20' },
        includeMinimized: { type: 'boolean', description: '是否包含最小化窗口，默认 true' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      timeoutMs: 20000,
      async execute(args) {
        const limit = clampInteger(args.limit, 20, 1, 100);
        const includeMinimized = args.includeMinimized !== false;
        return runTool(deps, 'input_window_list', args, async () => {
          const result = await deps.session.request('windows', {
            filter: typeof args.filter === 'string' ? args.filter : '',
            limit,
            includeMinimized,
          }, { timeoutMs: 15000 });
          const windows = Array.isArray(result.windows) ? result.windows : [];
          if (windows.length === 0) return text('没有匹配的可见窗口。');
          const total = Number.isFinite(result.total) ? result.total : windows.length;
          return text([
            `窗口：匹配 ${total} 个，显示 ${windows.length} 个`,
            ...windows.map((entry) => `  ${describeWindow(entry)}`),
          ].join('\n'));
        }, { pause: false });
      },
    }),

    defineTool({
      name: 'input_window_focus',
      description:
        '把目标窗口切到前台：title / hwnd / pid 三选一（优先 hwnd）。最小化会先还原；置前失败时会尝试 AttachThreadInput 与 Alt 解锁后重试。'
        + '切到前台后键盘输入才会落到该窗口。',
      parameters: {
        title: { type: 'string', description: '窗口标题（默认子串匹配）' },
        hwnd: { type: 'integer', description: '窗口句柄，来自 input_window_list' },
        pid: { type: 'integer', description: '进程 ID，来自 input_window_list' },
        exact: { type: 'boolean', description: 'title 是否要求全等，默认 false（子串包含）' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      timeoutMs: 30000,
      async execute(args) {
        const hasHwnd = args.hwnd !== undefined && args.hwnd !== null;
        const hasTitle = typeof args.title === 'string' && args.title.trim() !== '';
        const hasPid = args.pid !== undefined && args.pid !== null;
        if ([hasHwnd, hasTitle, hasPid].filter((flag) => flag).length !== 1) {
          throw inputError('E_BAD_ARGS', 'title / hwnd / pid 必须且只能给一个。');
        }
        const payload = hasHwnd
          ? { hwnd: integerIn(args.hwnd, 'hwnd', 1, Number.MAX_SAFE_INTEGER) }
          : hasTitle
            ? { title: args.title.trim(), exact: args.exact === true }
            : { pid: integerIn(args.pid, 'pid', 1, Number.MAX_SAFE_INTEGER) };

        return runTool(deps, 'input_window_focus', args, async () => {
          const plan = hasHwnd
            ? `把 hwnd ${payload.hwnd} 切到前台`
            : hasTitle
              ? `把标题匹配「${payload.title}」的窗口切到前台`
              : `把 pid ${payload.pid} 的窗口切到前台`;
          if (deps.config.dryRun) return dryRunText(plan);
          await deps.session.ensureStarted();
          const result = await deps.session.request('focus', payload, { timeoutMs: 15000 });
          if (result.ok !== true) {
            throw inputError(
              'E_INPUT_FAILED',
              `没能把窗口切到前台（${typeof result.hint === 'string' ? result.hint : '系统拒绝了置前请求'}）。可以再试一次，或手动切换窗口后再输入。`,
            );
          }
          const current = result.current ? describeWindow(result.current) : '（未知）';
          const previous = result.previous ? describeWindow(result.previous) : null;
          return text(`已切到前台：${current}${previous === null ? '' : `\n上一个前台：${previous}`}`);
        });
      },
    }),
  ];
}

/** 导出给测试。 */
export { describeWindow };
