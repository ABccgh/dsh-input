/**
 * 键盘工具：组合键/长按与 Unicode 文本输入。
 *
 * `input_type` 用 `KEYEVENTF_UNICODE` 直接注入字符（绕开输入法），
 * 中文/emoji 都不依赖键盘布局；`\n` 发送 Enter，`\t` 发送 Tab。
 *
 * @module @local/input/tools/keyboard
 */

import { inputError } from '../errors.js';
import { parseKeyChord } from '../keys.js';
import { defineTool } from '../tool-kit.js';
import { TEXT_OUTPUT, clampInteger, dryRunText, integerIn, runTool, text } from './shared.js';

const ACTIONS = new Map([
  ['press', '按下并松开'],
  ['down', '按住'],
  ['up', '松开'],
]);

/**
 * 预览文本（截断换行，避免把整段代码打进工具结果）。
 * @param {string} value - 文本。
 * @returns {string} 预览。
 */
function previewText(value) {
  const single = value.replace(/\r\n/g, '\\n').replace(/\r/g, '\\n').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  return single.length > 120 ? `${single.slice(0, 120)}…` : single;
}

/**
 * 注册 2 个键盘工具。
 * @param {object} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createKeyboardTools(deps) {
  return [
    defineTool({
      name: 'input_key',
      description:
        '按组合键，例如 ["ctrl","shift","s"] 或 ["ctrl+s"]；也支持单键 ["enter"]、["f5"]。'
        + 'action=press 按下并松开（默认）、down 按住不放、up 松开；repeat 连按 1–20 次，holdMs 按住时长，delayMs 每次间隔。'
        + '前台是本应用（DeepSeek Harness）时会被守卫拒绝，先用 input_window_focus 切到目标窗口。',
      parameters: {
        keys: {
          type: 'array',
          required: true,
          description: '键名数组，如 ["ctrl","shift","s"]；单段组合键也可以写成 ["ctrl+s"]',
          items: { type: 'string', description: '键名，如 ctrl、shift、alt、win、enter、esc、f5、a、1、semicolon' },
        },
        action: { type: 'string', enum: ['press', 'down', 'up'], description: 'press（默认）/down/up' },
        repeat: { type: 'integer', description: '重复次数 1–20，默认 1' },
        holdMs: { type: 'integer', description: '每次按住时长 0–2000ms，默认 0' },
        delayMs: { type: 'integer', description: '每次之间的间隔 0–1000ms，默认 0' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      timeoutMs: 40000,
      async execute(args) {
        const chord = parseKeyChord(args.keys);
        const action = args.action === undefined ? 'press' : String(args.action).toLowerCase();
        if (!ACTIONS.has(action)) throw inputError('E_BAD_ARGS', `action 只能是 press/down/up，收到 ${String(args.action)}。`);
        const repeat = args.repeat === undefined ? 1 : integerIn(args.repeat, 'repeat', 1, deps.config.maxKeyRepeat);
        const holdMs = clampInteger(args.holdMs, 0, 0, 2000);
        const delayMs = clampInteger(args.delayMs, 0, 0, 1000);
        const payload = {
          keys: chord.keys.map((key) => ({ vk: key.vk, extended: key.extended })),
          action,
          repeat,
          holdMs,
          delayMs,
        };
        const plan = `${ACTIONS.get(action)}「${chord.label}」${repeat > 1 ? ` ×${repeat}` : ''}（按住 ${holdMs}ms，间隔 ${delayMs}ms）`;

        return runTool(deps, 'input_key', args, async () => {
          if (deps.config.dryRun) return dryRunText(plan);
          await deps.session.ensureStarted();
          await deps.session.request('key', payload, { timeoutMs: 5000 + repeat * (holdMs + delayMs) });
          return text(`已${ACTIONS.get(action)}「${chord.label}」${repeat > 1 ? ` ×${repeat}` : ''}（${chord.keys.length} 个键）。`);
        });
      },
    }),

    defineTool({
      name: 'input_type',
      description:
        '输入一段文本（Unicode 直接注入，中文/emoji 不需要输入法或键盘布局）。\\n 会发送回车，\\t 发送 Tab；submit=true 在末尾再按一次回车。'
        + '前台是本应用（DeepSeek Harness）时会被守卫拒绝——先聚焦目标窗口（input_window_focus）。长文本会被 maxTypedChars 限制。',
      parameters: {
        text: { type: 'string', required: true, description: '要输入的文本（最长由配置 maxTypedChars 决定，默认 4000 字符）' },
        intervalMs: { type: 'integer', description: '字符间隔 0–200ms，默认 0' },
        submit: { type: 'boolean', description: '末尾按一次回车，默认 false' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      timeoutMs: 60000,
      async execute(args) {
        if (typeof args.text !== 'string') throw inputError('E_BAD_ARGS', 'text 必须是字符串。');
        if (args.text.length === 0) throw inputError('E_BAD_ARGS', 'text 不能为空。');
        if (args.text.length > deps.config.maxTypedChars) {
          throw inputError(
            'E_TEXT_TOO_LONG',
            `text 长度 ${args.text.length} 超过上限 ${deps.config.maxTypedChars}；分段输入或调大配置 maxTypedChars。`,
          );
        }
        const intervalMs = clampInteger(args.intervalMs, 0, 0, 200);
        const submit = args.submit === true;
        const plan = `输入 ${args.text.length} 个字符「${previewText(args.text)}」${submit ? '，末尾回车' : ''}（间隔 ${intervalMs}ms）`;

        return runTool(deps, 'input_type', args, async () => {
          if (deps.config.dryRun) return dryRunText(plan);
          await deps.session.ensureStarted();
          const result = await deps.session.request('type', { text: args.text, intervalMs, submit }, {
            timeoutMs: 5000 + Math.min(55000, args.text.length * (intervalMs + 2)),
          });
          return text(
            `已输入 ${result.chars ?? args.text.length} 个字符（发送 ${result.typed ?? '?'} 个 Unicode code unit）`
            + `${result.submitted || submit ? '，并按下回车' : ''}。`,
          );
        });
      },
    }),
  ];
}

/** 导出给测试。 */
export { previewText };
