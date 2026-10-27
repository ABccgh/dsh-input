/**
 * `input_status`：只读诊断。helper 不可用时也返回可读现场，而不是抛错。
 *
 * @module @local/input/tools/status
 */

import fs from 'node:fs';

import { PLUGIN_VERSION } from '../config.js';
import { toLogicalPoint } from '../coordinates.js';
import { describeError } from '../errors.js';
import { describeScreen } from '../protocol.js';
import { defineTool } from '../tool-kit.js';
import { TEXT_OUTPUT, describePoint, formatBytes, isPaused, text } from './shared.js';

/**
 * 渲染前台窗口一行。
 * @param {{ hwnd?: number, pid?: number, title?: string, processName?: string, isSelf?: boolean, minimized?: boolean } | undefined} foreground - helper 报告的前台。
 * @returns {string} 文本。
 */
function describeForeground(foreground) {
  if (foreground === null || foreground === undefined || !Number.isFinite(foreground.hwnd) || foreground.hwnd === 0) {
    return '（没有前台窗口）';
  }
  const title = foreground.title ? `「${foreground.title}」` : '（无标题）';
  const process = foreground.processName ? ` ${foreground.processName}` : '';
  const flags = [foreground.isSelf ? '本应用，键入会被守卫拒绝' : '', foreground.minimized ? '最小化' : '']
    .filter((item) => item !== '')
    .join(' · ');
  return `hwnd ${foreground.hwnd} ${title} pid ${foreground.pid}${process}${flags === '' ? '' : `（${flags}）`}`;
}

/**
 * 审计文件状态。
 * @param {string} file - 路径。
 * @returns {string} 文本。
 */
function describeAuditFile(file) {
  try {
    const stat = fs.statSync(file);
    return `${file}（${formatBytes(stat.size)}，更新于 ${stat.mtime.toISOString()}）`;
  } catch {
    return `${file}（尚未创建）`;
  }
}

/**
 * 正常状态渲染。
 * @param {object} deps - 依赖。
 * @param {Record<string, any>} info - init 结果。
 * @param {Record<string, any>} status - status 结果。
 * @returns {string} 文本。
 */
function renderStatus(deps, info, status) {
  const { config, paths } = deps;
  const screen = info.screen;
  const uptimeSeconds = Number.isFinite(status.uptimeMs) ? Math.round(status.uptimeMs / 1000) : 0;
  const lines = [];
  lines.push(`键鼠控制插件 ${PLUGIN_VERSION} · helper ${info.helperVersion}（pid ${info.pid}，已运行 ${uptimeSeconds}s）`);
  lines.push(`屏幕：${describeScreen(screen)}，显示器 ${info.monitorCount ?? 1}`);
  if (status.cursor && Number.isFinite(status.cursor.x)) {
    lines.push(`光标：${describePoint(screen, { x: status.cursor.x, y: status.cursor.y })}`);
  }
  lines.push(`前台：${describeForeground(status.foreground)}`);
  lines.push(`权限：${info.elevated ? '已提升（可向普通与提升窗口注入）' : '普通用户（无法向提升窗口注入）'}`);
  lines.push(`DPI：${info.dpiAware ? '线程 PMv2，坐标为物理像素' : '非 PMv2，坐标可能被系统虚拟化'}`);
  lines.push(
    status.paused
      ? `暂停：是（${paths.pauseFile} 存在；删掉该文件后恢复）`
      : `暂停：否（${paths.pauseFile} 不存在）`,
  );
  const pressed = Array.isArray(status.pressedKeys) ? status.pressedKeys : [];
  lines.push(`按下的键：${pressed.length === 0 ? '无' : pressed.map((vk) => `0x${Number(vk).toString(16).toUpperCase()}`).join(' ')}`);
  lines.push(
    `配置：coordinateSpace=${config.coordinateSpace}，guardSelfWindow=${config.guardSelfWindow}，`
    + `dryRun=${config.dryRun}，allowOutOfBounds=${config.allowOutOfBounds}，空闲回收 ${Math.round(config.idleTimeoutMs / 1000)}s`,
  );
  lines.push(`审计：${describeAuditFile(paths.auditFile)}`);
  lines.push(`helper：${paths.powershellPath}`);
  return lines.join('\n');
}

/**
 * helper 不可用时的诊断渲染。
 * @param {object} deps - 依赖。
 * @param {unknown} error - 启动/查询错误。
 * @returns {string} 文本。
 */
function renderOffline(deps, error) {
  const { config, paths } = deps;
  const paused = isPaused(paths.pauseFile);
  return [
    `键鼠控制插件 ${PLUGIN_VERSION} · helper 不可用`,
    describeError(error),
    `PowerShell：${paths.powershellPath}`,
    `helper 脚本：${paths.helperPath}`,
    `暂停：${paused ? `是（${paths.pauseFile} 存在）` : `否（${paths.pauseFile} 不存在）`}`,
    `配置：coordinateSpace=${config.coordinateSpace}，guardSelfWindow=${config.guardSelfWindow}，dryRun=${config.dryRun}`,
    `审计：${describeAuditFile(paths.auditFile)}`,
    '排查：确认 PowerShell 路径存在、helper 脚本在安装副本里、没有被安全软件拦截；改完配置后把插件关开一次。',
  ].join('\n');
}

/**
 * 注册 `input_status`。
 * @param {object} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createStatusTools(deps) {
  return [
    defineTool({
      name: 'input_status',
      description:
        '查看键鼠控制插件与本机输入环境：屏幕物理/逻辑尺寸与缩放、光标位置、前台窗口、helper 进程状态、是否暂停、审计文件与权限。只读，不注入任何输入；首次调用会拉起 helper（约 2-3 秒冷启动）。',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute() {
        try {
          const info = await deps.session.ensureStarted();
          const status = await deps.session.request('status', {}, { timeoutMs: deps.config.requestTimeoutMs });
          return text(renderStatus(deps, info, status));
        } catch (error) {
          return text(renderOffline(deps, error));
        }
      },
    }),
  ];
}

/** 导出给测试用。 */
export { describeForeground, describeAuditFile, renderStatus, renderOffline, toLogicalPoint };
