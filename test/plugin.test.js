import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { normalizeConfig } from '../lib/config.js';
import { makeInitResult } from './fake-helper.js';

const module = await import('../lib/index.js');

const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // 测试清理失败不影响结果。
    }
  }
});

/**
 * 造一个只实现 `tools.register` / `effect` / `logger` 的假 Cordis 上下文。
 * @returns {{ ctx: object, tools: Map<string, object>, cleanups: Function[], logs: { info: string[], warn: string[] } }} 上下文与收集器。
 */
function makeCtx() {
  const tools = new Map();
  const cleanups = [];
  const logs = { info: [], warn: [] };
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`重复注册工具 ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    effect(callback) {
      const cleanup = callback();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
  };
  return { ctx, tools, cleanups, logs };
}

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-input-plugin-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fakePaths(directory) {
  return {
    pauseFile: path.join(directory, 'pause'),
    auditFile: path.join(directory, 'audit.jsonl'),
    screenshotDir: path.join(directory, 'shots'),
    powershellPath: 'C:\\powershell.exe',
    helperPath: path.join(directory, 'input-helper.ps1'),
  };
}

test('导出 name / inject / apply，不导出 Config', () => {
  assert.equal(module.name, 'input');
  assert.deepEqual(module.inject, ['tools']);
  assert.equal(typeof module.apply, 'function');
  assert.equal('Config' in module, false, '没有 Config 时 Cordis 会原样透传配置对象');
});

test('apply 注册 11 个工具、写一行日志、返回 undefined', async () => {
  const { ctx, tools, logs } = makeCtx();
  const directory = temporaryDirectory();
  const session = {
    async ensureStarted() {
      return makeInitResult();
    },
    async request() {
      return {};
    },
    dispose() {},
  };
  const result = await module.apply(ctx, {}, {
    session,
    audit: { write() {} },
    paths: fakePaths(directory),
  });
  assert.equal(result, undefined);
  assert.equal(tools.size, 11);
  assert.equal(logs.info.length, 1);
  assert.match(logs.info[0], /\[input\] 就绪：11 个工具/);
});

test('卸载时执行 cleanup：注销工具并 dispose 会话', async () => {
  const { ctx, tools, cleanups } = makeCtx();
  const directory = temporaryDirectory();
  let disposed = 0;
  const session = {
    async ensureStarted() {
      return makeInitResult();
    },
    async request() {
      return {};
    },
    dispose() {
      disposed += 1;
    },
  };
  await module.apply(ctx, {}, {
    session,
    audit: { write() {} },
    paths: fakePaths(directory),
  });
  assert.equal(tools.size, 11);
  for (const cleanup of cleanups) cleanup();
  assert.equal(tools.size, 0);
  assert.equal(disposed, 1);
});

test('createDeps 使用覆盖路径，并生成 11 个工具定义', () => {
  const directory = temporaryDirectory();
  const deps = module.createDeps(normalizeConfig({}), {
    session: { ensureStarted: async () => makeInitResult(), request: async () => ({}), dispose() {} },
    audit: { write() {} },
    paths: fakePaths(directory),
  });
  assert.equal(deps.paths.pauseFile, path.join(directory, 'pause'));
  assert.equal(deps.config.coordinateSpace, 'physical');
  const definitions = module.createToolDefinitions(deps);
  assert.equal(definitions.length, 11);
  assert.equal(new Set(definitions.map((definition) => definition.name)).size, 11);
});

test('createDeps 在没有覆盖路径时使用默认路径，不启动 helper', () => {
  const deps = module.createDeps(normalizeConfig({}), {
    session: { ensureStarted: async () => makeInitResult(), request: async () => ({}), dispose() {} },
    audit: { write() {} },
  });
  assert.match(deps.paths.pauseFile, /dsh-input-pause$/);
  assert.match(deps.paths.helperPath, /input-helper\.ps1$/);
  assert.equal(deps.session.isRunning, undefined);
});
