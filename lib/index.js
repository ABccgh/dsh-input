/**
 * `@local/input` 的 Cordis 插件入口。
 *
 * 注册 11 个 `input_*` 工具：状态、鼠标（移动/点击/拖拽/滚轮）、键盘（组合键/文本）、
 * 窗口（列表/聚焦）、截图与真机自检。
 *
 * 注意三件事：
 * 1. **不 import 任何 `@deepseek-ai/*`**。插件是 `link:` 安装的 profile bundle，
 *    代码在 DSH 安装作用域之外，这类 import 会以 `ERR_MODULE_NOT_FOUND` 让插件加载失败。
 * 2. **`apply` 不返回值**。Cordis 会把返回值当 effect 收集，返回数组会让插件激活失败。
 * 3. 所有注册都包在 `ctx.effect` 里，取得 disposer，HMR/卸载时才能干净地回收。
 *
 * @module @local/input
 */

import { createAuditLog } from './audit.js';
import { normalizeConfig, resolvePaths } from './config.js';
import { createHelperSession } from './helper-session.js';
import { createKeyboardTools } from './tools/keyboard.js';
import { createMouseTools } from './tools/mouse.js';
import { createScreenshotTools } from './tools/screenshot.js';
import { createSelftestTools } from './tools/selftest.js';
import { createStatusTools } from './tools/status.js';
import { createWindowTools } from './tools/window.js';

/** 插件名（日志与 Loader 行里的标识）。 */
export const name = 'input';

/** 强依赖：工具注册表。 */
export const inject = ['tools'];

/**
 * 组装运行时依赖。
 *
 * `overrides` 是测试接缝：注入假 `session` / `audit` 就能在不产生真实输入的情况下
 * 覆盖全部工具逻辑。
 * @param {ReturnType<typeof normalizeConfig>} config - 生效配置。
 * @param {{ session?: object, audit?: { write: Function }, paths?: object, logger?: object, platform?: string }} [overrides] - 测试接缝。
 * @returns {{ config: object, paths: object, audit: object, session: object, logger: object | undefined }} 依赖对象。
 */
export function createDeps(config, overrides = {}) {
  const paths = overrides.paths ?? resolvePaths(config);
  const logger = overrides.logger;
  const audit = overrides.audit ?? createAuditLog({ file: paths.auditFile, enabled: config.auditEnabled, logger });
  const session = overrides.session ?? createHelperSession({
    powershellPath: paths.powershellPath,
    helperPath: paths.helperPath,
    startupTimeoutMs: config.startupTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
    initArgs: {
      pauseFile: paths.pauseFile,
      guardSelf: config.guardSelfWindow,
      selfPids: [process.pid, process.ppid].filter((value) => Number.isInteger(value) && value > 0),
      selfTitles: config.selfWindowTitles,
      allowOutOfBounds: config.allowOutOfBounds,
      stepDelayMs: config.moveStepDelayMs,
    },
    logger,
    ...(typeof overrides.platform === 'string' ? { platform: overrides.platform } : {}),
  });
  return { config, paths, audit, session, logger };
}

/**
 * 造全部工具定义（顺序即工具表顺序，status 在最前）。
 * @param {ReturnType<typeof createDeps>} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createToolDefinitions(deps) {
  return [
    ...createStatusTools(deps),
    ...createMouseTools(deps),
    ...createKeyboardTools(deps),
    ...createWindowTools(deps),
    ...createScreenshotTools(deps),
    ...createSelftestTools(deps),
  ];
}

/**
 * 装配插件。
 * @param {any} ctx - Cordis 上下文（硬依赖 `tools`）。
 * @param {Record<string, unknown>} config - loader 校验后的配置。
 * @param {{ session?: object, audit?: object, paths?: object, logger?: object, platform?: string }} [overrides]
 *   测试接缝。
 * @returns {Promise<void>} 无。**不要返回任何值**。
 */
export async function apply(ctx, config, overrides = {}) {
  const effective = normalizeConfig(config);
  const deps = createDeps(effective, { ...overrides, logger: overrides.logger ?? ctx.logger });
  const definitions = createToolDefinitions(deps);
  const effect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : (callback) => callback();

  for (const definition of definitions) effect(() => ctx.tools.register(definition));
  effect(() => () => deps.session.dispose());

  try {
    ctx.logger?.info?.(
      `[input] 就绪：${definitions.length} 个工具（${definitions.map((definition) => definition.name).join(', ')}）；`
      + `helper ${deps.paths.powershellPath}；暂停文件 ${deps.paths.pauseFile}；`
      + `guardSelfWindow=${effective.guardSelfWindow}，dryRun=${effective.dryRun}。`,
    );
  } catch {
    // 日志不可用无所谓。
  }
}
