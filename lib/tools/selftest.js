/**
 * `input_selftest`：真机自检。
 *
 * 检查都在 helper 自己的临时窗口里完成，不会往用户应用里打字；鼠标检查会移动光标并复原。
 * 它是“这套注入链路到底通不通”的唯一可信证据，所以逐项返回 ok/skip/fail。
 *
 * @module @local/input/tools/selftest
 */

import { defineTool } from '../tool-kit.js';
import { TEXT_OUTPUT, dryRunText, runTool, text } from './shared.js';

const STATUS_LABELS = new Map([
  ['ok', '通过'],
  ['skip', '跳过'],
  ['fail', '失败'],
]);

/**
 * 注册 `input_selftest`。
 * @param {object} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createSelftestTools(deps) {
  return [
    defineTool({
      name: 'input_selftest',
      description:
        '真机自检注入链路：DPI 感知、鼠标往返（会移动并复原光标）、按键状态、测试窗口内的点击/文本输入/组合键/滚轮。'
        + '会短暂弹出一个测试窗口并自动关闭，结束后恢复原前台窗口；不会向你的应用打字。用来判断键鼠控制是否正常。',
      parameters: {
        skipMouse: { type: 'boolean', description: '跳过鼠标相关检查' },
        skipKeyboard: { type: 'boolean', description: '跳过键盘相关检查' },
        text: { type: 'string', description: '文本输入检查用的样例文本（默认中英混合）' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      timeoutMs: 120000,
      async execute(args) {
        const payload = {
          skipMouse: args.skipMouse === true,
          skipKeyboard: args.skipKeyboard === true,
          ...(typeof args.text === 'string' && args.text !== '' ? { text: args.text } : {}),
        };
        return runTool(deps, 'input_selftest', args, async () => {
          if (deps.config.dryRun) {
            return dryRunText('运行 input_selftest 的全部检查（会短暂操作光标并弹出一个测试窗口）');
          }
          await deps.session.ensureStarted();
          const result = await deps.session.request('selftest', payload, { timeoutMs: 90000 });
          const checks = Array.isArray(result.checks) ? result.checks : [];
          const fails = checks.filter((check) => check.status === 'fail').length;
          const skips = checks.filter((check) => check.status === 'skip').length;
          const lines = checks.map((check) => {
            const label = STATUS_LABELS.get(check.status) ?? String(check.status ?? '?');
            return `[${label}] ${check.name ?? '?'}${typeof check.detail === 'string' && check.detail !== '' ? ` — ${check.detail}` : ''}`;
          });
          const summary = result.ok === true
            ? `input_selftest：全部通过${skips > 0 ? `（${skips} 项跳过）` : ''}`
            : `input_selftest：${fails} 项失败${skips > 0 ? `，${skips} 项跳过` : ''}`;
          return text([summary, ...lines].join('\n'));
        });
      },
    }),
  ];
}
