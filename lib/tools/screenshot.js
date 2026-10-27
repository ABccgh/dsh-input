/**
 * `input_screenshot`：全屏或区域截图到固定目录，返回文件路径供 `read_image` 查看。
 *
 * 截图是鼠标定位的“眼睛”：先截图确认目标位置，再移动/点击。
 * 只读操作，不受暂停开关限制；目录固定在配置的 `screenshotDir`，不支持模型指定任意路径。
 *
 * @module @local/input/tools/screenshot
 */

import fs from 'node:fs';
import path from 'node:path';

import { describeRect, resolveRegion } from '../coordinates.js';
import { defineTool } from '../tool-kit.js';
import { TEXT_OUTPUT, dryRunText, formatBytes, runTool, text } from './shared.js';

/**
 * 生成截图文件名。
 * @param {Date} now - 当前时间。
 * @returns {string} 文件名。
 */
function screenshotName(now = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `shot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}.png`;
}

/**
 * 只保留最近的若干张截图。
 * @param {string} directory - 目录。
 * @param {number} keep - 保留数量。
 * @returns {void}
 */
function pruneScreenshots(directory, keep) {
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return;
  }
  const files = [];
  for (const name of entries) {
    if (!/^shot-.*\.png$/.test(name)) continue;
    const full = path.join(directory, name);
    try {
      files.push({ full, mtime: fs.statSync(full).mtimeMs });
    } catch {
      // 并发删除或权限问题：忽略这一张。
    }
  }
  files.sort((left, right) => right.mtime - left.mtime);
  for (const file of files.slice(Math.max(1, keep))) {
    try {
      fs.rmSync(file.full, { force: true });
    } catch {
      // 删不掉就留着，不影响本次截图。
    }
  }
}

/**
 * 注册 `input_screenshot`。
 * @param {object} deps - 依赖。
 * @returns {object[]} 工具定义。
 */
export function createScreenshotTools(deps) {
  return [
    defineTool({
      name: 'input_screenshot',
      description:
        '截取全屏或指定区域（物理像素）到固定目录，返回 PNG 路径；随后用 read_image 查看该文件。'
        + '用来确认鼠标目标位置、验证操作结果。目录固定为配置 screenshotDir，只保留最近 maxScreenshots 张。',
      parameters: {
        region: {
          type: 'object',
          description: '可选区域 {x,y,width,height}；不给则截全屏',
          properties: {
            x: { type: 'integer', required: true, description: '左上角横坐标' },
            y: { type: 'integer', required: true, description: '左上角纵坐标' },
            width: { type: 'integer', required: true, description: '宽度' },
            height: { type: 'integer', required: true, description: '高度' },
          },
        },
        space: { type: 'string', enum: ['physical', 'logical'], description: '坐标空间，默认取插件配置' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      timeoutMs: 30000,
      async execute(args) {
        return runTool(deps, 'input_screenshot', args, async () => {
          const info = await deps.session.ensureStarted();
          const region = resolveRegion(args, {
            screen: info.screen,
            defaultSpace: deps.config.coordinateSpace,
            allowOutOfBounds: deps.config.allowOutOfBounds,
          });
          const directory = deps.paths.screenshotDir;
          fs.mkdirSync(directory, { recursive: true });
          const file = path.join(directory, screenshotName());
          const plan = `把 ${region ? describeRect(region) : '全屏'} 截图到 ${file}`;
          if (deps.config.dryRun) return dryRunText(plan);
          let result;
          try {
            result = await deps.session.request('screenshot', { path: file, ...(region ? { region } : {}) }, { timeoutMs: 20000 });
          } catch (error) {
            try {
              fs.rmSync(file, { force: true });
            } catch {
              // 失败时留下的半截文件能删就删。
            }
            throw error;
          }
          pruneScreenshots(directory, deps.config.maxScreenshots);
          let bytes = Number.isFinite(result.bytes) ? result.bytes : 0;
          if (!bytes) {
            try {
              bytes = fs.statSync(file).size;
            } catch {
              bytes = 0;
            }
          }
          return text([
            `已截图：${file}`,
            `尺寸 ${result.width ?? '?'}×${result.height ?? '?'}，${formatBytes(bytes)}；区域 ${region ? describeRect(region) : '全屏'}。`,
            '用 read_image 查看这个文件，确认位置后再移动/点击。',
          ].join('\n'));
        }, { pause: false });
      },
    }),
  ];
}

/** 导出给测试。 */
export { pruneScreenshots, screenshotName };
