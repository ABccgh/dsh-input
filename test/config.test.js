import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  defaultAuditFile,
  defaultHelperPath,
  defaultPauseFile,
  defaultPowershellPath,
  defaultScreenshotDir,
  HELPER_VERSION,
  normalizeConfig,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  resolvePaths,
} from '../lib/config.js';

test('常量与协议版本固定', () => {
  assert.equal(HELPER_VERSION, '1.0.0');
  assert.equal(PROTOCOL_VERSION, 1);
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/);
});

test('默认路径落在系统临时目录 / LOCALAPPDATA / System32', () => {
  assert.equal(defaultPauseFile(), path.join(os.tmpdir(), 'dsh-input-pause'));
  assert.equal(defaultScreenshotDir(), path.join(os.tmpdir(), 'dsh-input', 'shots'));
  assert.match(defaultAuditFile(), /dsh-input[\\/]audit\.jsonl$/);
  assert.match(defaultPowershellPath(), /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.match(defaultHelperPath(), /lib[\\/]helper[\\/]input-helper\.ps1$/);
});

test('normalizeConfig 对空配置给出保守默认值', () => {
  const config = normalizeConfig({});
  assert.equal(config.powershellPath, '');
  assert.equal(config.helperPath, '');
  assert.equal(config.requestTimeoutMs, 15000);
  assert.equal(config.startupTimeoutMs, 30000);
  assert.equal(config.idleTimeoutMs, 300000);
  assert.equal(config.guardSelfWindow, true);
  assert.deepEqual(config.selfWindowTitles, ['DeepSeek Harness']);
  assert.equal(config.pauseFile, '');
  assert.equal(config.auditFile, '');
  assert.equal(config.auditEnabled, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.coordinateSpace, 'physical');
  assert.equal(config.allowOutOfBounds, false);
  assert.equal(config.maxTypedChars, 4000);
  assert.equal(config.maxKeyRepeat, 20);
  assert.equal(config.maxMoveSteps, 240);
  assert.equal(config.moveStepDelayMs, 8);
  assert.equal(config.screenshotDir, '');
  assert.equal(config.maxScreenshots, 20);
});

test('normalizeConfig 对垃圾值回退默认值而不是抛错', () => {
  const config = normalizeConfig({
    powershellPath: '   ',
    requestTimeoutMs: -1,
    startupTimeoutMs: 'abc',
    idleTimeoutMs: 1,
    guardSelfWindow: 'yes',
    selfWindowTitles: ['  ', 42, 'My App', 'My App'],
    auditEnabled: 0,
    dryRun: 'true',
    coordinateSpace: 'LOGICAL',
    allowOutOfBounds: 1,
    maxTypedChars: 0,
    maxKeyRepeat: 9999,
    maxMoveSteps: 999999,
    moveStepDelayMs: -5,
    maxScreenshots: Number.NaN,
  });
  assert.equal(config.powershellPath, '');
  assert.equal(config.requestTimeoutMs, 2000);
  assert.equal(config.startupTimeoutMs, 30000);
  assert.equal(config.idleTimeoutMs, 10000);
  assert.equal(config.guardSelfWindow, true);
  assert.deepEqual(config.selfWindowTitles, ['My App']);
  assert.equal(config.auditEnabled, true);
  assert.equal(config.dryRun, false);
  assert.equal(config.coordinateSpace, 'logical');
  assert.equal(config.allowOutOfBounds, false);
  assert.equal(config.maxTypedChars, 1);
  assert.equal(config.maxKeyRepeat, 100);
  assert.equal(config.maxMoveSteps, 2000);
  assert.equal(config.moveStepDelayMs, 0);
  assert.equal(config.maxScreenshots, 20);
});

test('normalizeConfig 接受合法自定义值', () => {
  const config = normalizeConfig({
    powershellPath: 'C:\\x\\powershell.exe',
    helperPath: 'C:\\x\\helper.ps1',
    requestTimeoutMs: 20000,
    startupTimeoutMs: 40000,
    idleTimeoutMs: 60000,
    guardSelfWindow: false,
    selfWindowTitles: ['Foo'],
    pauseFile: 'C:\\p',
    auditFile: 'C:\\a.jsonl',
    auditEnabled: false,
    dryRun: true,
    coordinateSpace: 'logical',
    allowOutOfBounds: true,
    maxTypedChars: 100,
    maxKeyRepeat: 3,
    maxMoveSteps: 10,
    moveStepDelayMs: 1,
    screenshotDir: 'C:\\shots',
    maxScreenshots: 5,
  });
  assert.equal(config.powershellPath, 'C:\\x\\powershell.exe');
  assert.equal(config.helperPath, 'C:\\x\\helper.ps1');
  assert.equal(config.requestTimeoutMs, 20000);
  assert.equal(config.startupTimeoutMs, 40000);
  assert.equal(config.idleTimeoutMs, 60000);
  assert.equal(config.guardSelfWindow, false);
  assert.deepEqual(config.selfWindowTitles, ['Foo']);
  assert.equal(config.pauseFile, 'C:\\p');
  assert.equal(config.auditFile, 'C:\\a.jsonl');
  assert.equal(config.auditEnabled, false);
  assert.equal(config.dryRun, true);
  assert.equal(config.coordinateSpace, 'logical');
  assert.equal(config.allowOutOfBounds, true);
  assert.equal(config.maxTypedChars, 100);
  assert.equal(config.maxKeyRepeat, 3);
  assert.equal(config.maxMoveSteps, 10);
  assert.equal(config.moveStepDelayMs, 1);
  assert.equal(config.screenshotDir, 'C:\\shots');
  assert.equal(config.maxScreenshots, 5);
});

test('normalizeConfig 接受 null / 数组 / 字符串而不炸', () => {
  for (const raw of [null, undefined, [], 'x', 42]) {
    const config = normalizeConfig(raw);
    assert.equal(config.coordinateSpace, 'physical');
    assert.equal(config.guardSelfWindow, true);
  }
});

test('resolvePaths 把空字符串换成默认路径，非空原样保留', () => {
  const defaults = resolvePaths(normalizeConfig({}));
  assert.equal(defaults.pauseFile, defaultPauseFile());
  assert.equal(defaults.auditFile, defaultAuditFile());
  assert.equal(defaults.screenshotDir, defaultScreenshotDir());
  assert.equal(defaults.powershellPath, defaultPowershellPath());
  assert.equal(defaults.helperPath, defaultHelperPath());

  const custom = resolvePaths(normalizeConfig({
    pauseFile: 'D:\\p',
    auditFile: 'D:\\a',
    screenshotDir: 'D:\\s',
    powershellPath: 'D:\\pwsh.exe',
    helperPath: 'D:\\h.ps1',
  }));
  assert.deepEqual(custom, {
    pauseFile: 'D:\\p',
    auditFile: 'D:\\a',
    screenshotDir: 'D:\\s',
    powershellPath: 'D:\\pwsh.exe',
    helperPath: 'D:\\h.ps1',
  });
});
