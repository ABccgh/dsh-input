import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HELPER_VERSION, PLUGIN_VERSION, PROTOCOL_VERSION } from '../lib/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

test('package.json：名称、版本、导出与打包清单', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.name, '@local/input');
  assert.equal(pkg.version, PLUGIN_VERSION);
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.equal(pkg.exports['./icon'], './icon.svg');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  for (const required of ['lib/**/*.js', 'lib/helper/*.ps1', 'locale/*.json', 'icon.svg', 'cordis.patch.yml', 'README.md']) {
    assert.ok(pkg.files.includes(required), `files 缺少 ${required}`);
  }
  assert.equal(typeof pkg.meta.title, 'string');
  assert.ok(pkg.meta.title.length > 0);
  assert.equal(typeof pkg.meta.description, 'string');
});

test('locale 中英文都有 meta.title / meta.description', () => {
  for (const locale of ['en', 'zh']) {
    const data = readJson(`locale/${locale}.json`);
    assert.ok(data.meta, `${locale} 缺少 meta`);
    assert.ok(typeof data.meta.title === 'string' && data.meta.title.length > 0, `${locale} title`);
    assert.ok(typeof data.meta.description === 'string' && data.meta.description.length > 10, `${locale} description`);
  }
});

test('icon.svg 存在、是 SVG、体积在限制内', () => {
  const file = path.join(root, 'icon.svg');
  const bytes = fs.statSync(file).size;
  assert.ok(bytes > 0 && bytes < 256 * 1024, `icon 体积 ${bytes}`);
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /^<svg/);
  assert.match(content, /viewBox/);
});

test('cordis.patch.yml 插入 input 行并带全部配置键', () => {
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /- insert:/);
  assert.match(patch, /id: input/);
  assert.match(patch, /name: '@local\/input'/);
  for (const key of [
    'powershellPath', 'helperPath', 'requestTimeoutMs', 'startupTimeoutMs', 'idleTimeoutMs',
    'guardSelfWindow', 'selfWindowTitles', 'pauseFile', 'auditFile', 'auditEnabled', 'dryRun',
    'coordinateSpace', 'allowOutOfBounds', 'maxTypedChars', 'maxKeyRepeat', 'maxMoveSteps',
    'moveStepDelayMs', 'screenshotDir', 'maxScreenshots',
  ]) {
    assert.match(patch, new RegExp(`${key}:`), `patch 缺少配置键 ${key}`);
  }
});

test('PROTOCOL.md 记录协议版本与全部 op', () => {
  const text = fs.readFileSync(path.join(root, 'lib', 'helper', 'PROTOCOL.md'), 'utf8');
  assert.match(text, /协议 v1/);
  for (const op of ['init', 'status', 'ping', 'move', 'click', 'drag', 'wheel', 'key', 'type', 'windows', 'focus', 'screenshot', 'selftest', 'quit']) {
    assert.match(text, new RegExp(`\\b${op}\\b`), `协议缺少 op ${op}`);
  }
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(HELPER_VERSION, '1.0.0');
});

test('helper 脚本存在、纯 ASCII、包含关键实现', () => {
  const file = path.join(root, 'lib', 'helper', 'input-helper.ps1');
  assert.ok(fs.existsSync(file), '缺少 lib/helper/input-helper.ps1');
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > 2000, `helper 脚本过短：${bytes.length} 字节`);
  const nonAscii = [...bytes].filter((byte) => byte > 127);
  assert.equal(nonAscii.length, 0, `helper 必须纯 ASCII，发现 ${nonAscii.length} 个非 ASCII 字节`);
  const text = bytes.toString('ascii');
  assert.match(text, /Add-Type/);
  assert.match(text, /SendInput/);
  assert.match(text, /SetCursorPos/);
  assert.match(text, /E_PAUSED/);
  assert.match(text, /E_SELF_FOCUS/);
  assert.match(text, /selftest/);
});

test('README 存在且说明安全模型与安装', () => {
  const file = path.join(root, 'README.md');
  assert.ok(fs.existsSync(file), '缺少 README.md');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /安装/);
  assert.match(text, /暂停/);
  assert.match(text, /审计/);
  assert.match(text, /input_status/);
});
