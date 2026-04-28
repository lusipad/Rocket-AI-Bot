import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RequestLogStore } from '../src/observability/request-log-store.ts';

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-request-log-'));
  return {
    root,
    store: new RequestLogStore(path.join(root, 'history')),
  };
}

test('RequestLogStore 应记录并按最新优先列出请求', () => {
  const { root, store } = createStore();

  store.record({
    requestId: 'req-1',
    kind: 'chat',
    status: 'success',
    model: 'gpt-4o',
    startedAt: '2026-04-26T01:00:00.000Z',
    finishedAt: '2026-04-26T01:00:01.000Z',
    durationMs: 1000,
    username: 'alice',
    roomId: 'GENERAL',
    prompt: '第一个请求',
    requestType: 'code_query',
    activeSkills: ['code-lookup'],
    skillSources: { 'code-lookup': 'explicit' },
    usedTools: ['read_file'],
    rounds: 1,
    sources: [{ type: 'file', title: 'src/index.ts', ref: 'src/index.ts:10' }],
  });
  store.record({
    requestId: 'req-2',
    kind: 'scheduler',
    status: 'error',
    model: 'gpt-4o',
    startedAt: '2026-04-26T02:00:00.000Z',
    finishedAt: '2026-04-26T02:00:03.000Z',
    durationMs: 3000,
    taskName: 'daily-news',
    prompt: '生成日报',
    requestType: 'scheduler',
    error: 'timeout',
    activeSkills: ['scheduled-report'],
    skillSources: { 'scheduled-report': 'system' },
    usedTools: ['web_search'],
    rounds: 2,
  });

  const entries = store.list({ limit: 10 });
  assert.deepEqual(entries.map((entry) => entry.requestId), ['req-2', 'req-1']);
  assert.equal(store.get('req-1')?.username, 'alice');
  assert.deepEqual(store.get('req-1')?.skillSources, { 'code-lookup': 'explicit' });
  assert.deepEqual(store.get('req-1')?.sources, [{ type: 'file', title: 'src/index.ts', ref: 'src/index.ts:10' }]);
  assert.equal(store.get('missing'), null);

  fs.rmSync(root, { recursive: true, force: true });
});

test('RequestLogStore 应支持筛选与汇总', () => {
  const { root, store } = createStore();

  store.record({
    requestId: 'req-1',
    kind: 'chat',
    status: 'success',
    model: 'gpt-4o',
    startedAt: '2026-04-26T01:00:00.000Z',
    finishedAt: '2026-04-26T01:00:01.000Z',
    durationMs: 1000,
    username: 'alice',
    roomId: 'GENERAL',
    prompt: '成功请求',
    requestType: 'code_query',
    activeSkills: [],
    skillSources: {},
    usedTools: ['read_file'],
    rounds: 1,
    sources: [{ type: 'file', title: 'src/app.ts', ref: 'src/app.ts:1' }],
  });
  store.record({
    requestId: 'req-2',
    kind: 'chat',
    status: 'rejected',
    model: 'gpt-4o',
    startedAt: '2026-04-26T01:05:00.000Z',
    finishedAt: '2026-04-26T01:05:00.100Z',
    durationMs: 100,
    username: 'alice',
    roomId: 'GENERAL',
    prompt: '被限流请求',
    requestType: 'general',
    error: '用户限流',
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 0,
  });
  store.record({
    requestId: 'req-3',
    kind: 'scheduler',
    status: 'error',
    model: 'gpt-4o',
    startedAt: '2026-04-26T02:00:00.000Z',
    finishedAt: '2026-04-26T02:00:03.000Z',
    durationMs: 3000,
    taskName: 'daily-news',
    prompt: '失败任务',
    requestType: 'scheduler',
    error: 'timeout',
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 2,
  });

  assert.deepEqual(store.list({ kind: 'chat' }).map((entry) => entry.requestId), ['req-2', 'req-1']);
  assert.deepEqual(store.list({ status: 'error' }).map((entry) => entry.requestId), ['req-3']);
  assert.deepEqual(store.list({ username: 'alice', limit: 1 }).map((entry) => entry.requestId), ['req-2']);
  assert.deepEqual(store.list({ requestType: 'code_query' }).map((entry) => entry.requestId), ['req-1']);

  assert.deepEqual(store.summarizeRecent(10), {
    total: 3,
    success: 1,
    error: 1,
    rejected: 1,
    byKind: {
      chat: 2,
      scheduler: 1,
    },
    byRequestType: {
      code_query: 1,
      general: 1,
      scheduler: 1,
    },
    sourceCoverage: {
      withSources: 1,
      sourceRate: 0.333,
    },
    lastFinishedAt: '2026-04-26T02:00:03.000Z',
  });

  assert.deepEqual(store.summarizeDevTools(10), {
    total: 3,
    devToolsTotal: 1,
    devToolsRate: 0.333,
    byRequestType: {
      code_query: 1,
    },
    byTool: {
      read_file: 1,
    },
    sourceCoverage: {
      withSources: 1,
      sourceRate: 1,
    },
    lastFinishedAt: '2026-04-26T02:00:03.000Z',
  });

  fs.rmSync(root, { recursive: true, force: true });
});
