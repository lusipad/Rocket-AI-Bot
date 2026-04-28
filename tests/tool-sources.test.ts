import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createReadFileTool } from '../src/tools/read-file.ts';
import { createRepoSearchTool } from '../src/tools/repo-search.ts';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

test('read_file 工具应返回文件来源', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-read-file-'));
  const fileDir = path.join(root, 'src');
  fs.mkdirSync(fileDir, { recursive: true });
  fs.writeFileSync(
    path.join(fileDir, 'example.ts'),
    ['line1', 'line2', 'line3', 'line4'].join('\n'),
    'utf-8',
  );

  const tool = createReadFileTool([{ name: 'app', path: root }]);
  const result = await tool.execute(
    { file_path: 'src/example.ts', lines: '2-3' },
    createLogger() as never,
  );

  assert.equal(result.success, true);
  assert.deepEqual(result.data.sources, [{
    type: 'file',
    title: 'src/example.ts',
    ref: 'src/example.ts:2-3',
  }]);
});

test('search_code 工具应返回匹配来源', async (t) => {
  if (!(await hasRipgrep())) {
    t.skip('rg 未安装，跳过 search_code 来源测试');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-search-code-'));
  const fileDir = path.join(root, 'src');
  fs.mkdirSync(fileDir, { recursive: true });
  fs.writeFileSync(
    path.join(fileDir, 'example.ts'),
    ['export const alpha = 1;', 'export const needleToken = alpha + 1;'].join('\n'),
    'utf-8',
  );

  const tool = createRepoSearchTool([{ name: 'app', path: root }]);
  const result = await tool.execute(
    { query: 'needleToken' },
    createLogger() as never,
  );

  assert.equal(result.success, true);
  assert.ok(Array.isArray(result.data.sources));
  assert.match(JSON.stringify(result.data.sources), /src\/example\.ts:2/);
});

function hasRipgrep(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile('rg', ['--version'], (error) => {
        resolve(!error);
      });
    } catch {
      resolve(false);
    }
  });
}
