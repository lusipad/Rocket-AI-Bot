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
  store.record({
    requestId: 'req-4',
    kind: 'scheduler',
    status: 'success',
    model: 'gpt-5.4',
    startedAt: '2026-04-26T03:00:00.000Z',
    finishedAt: '2026-04-26T03:00:02.000Z',
    durationMs: 2000,
    taskName: 'work-item-risk',
    prompt: '工作项风险摘要',
    requestType: 'work_item_report',
    activeSkills: [],
    skillSources: {},
    usedTools: ['azure_devops_server_rest'],
    rounds: 1,
    sources: [{ type: 'azure_devops', title: 'Work Items', ref: 'wit/wiql' }],
  });

  assert.deepEqual(store.list({ kind: 'chat' }).map((entry) => entry.requestId), ['req-2', 'req-1']);
  assert.deepEqual(store.list({ status: 'error' }).map((entry) => entry.requestId), ['req-3']);
  assert.deepEqual(store.list({ username: 'alice', limit: 1 }).map((entry) => entry.requestId), ['req-2']);
  assert.deepEqual(store.list({ requestType: 'code_query' }).map((entry) => entry.requestId), ['req-1']);
  assert.deepEqual(store.list({ requestType: 'work_item_report' }).map((entry) => entry.requestId), ['req-4']);

  assert.deepEqual(store.summarizeRecent(10), {
    total: 4,
    success: 2,
    error: 1,
    rejected: 1,
    byKind: {
      chat: 2,
      scheduler: 2,
    },
    byRequestType: {
      code_query: 1,
      general: 1,
      scheduler: 1,
      work_item_report: 1,
    },
    sourceCoverage: {
      withSources: 2,
      sourceRate: 0.5,
    },
    lastFinishedAt: '2026-04-26T03:00:02.000Z',
  });

  assert.deepEqual(store.summarizeDevTools(10), {
    total: 4,
    devToolsTotal: 2,
    devToolsRate: 0.5,
    byRequestType: {
      code_query: 1,
      work_item_report: 1,
    },
    byTool: {
      azure_devops_server_rest: 1,
      read_file: 1,
    },
    sourceCoverage: {
      withSources: 2,
      sourceRate: 1,
    },
    lastFinishedAt: '2026-04-26T03:00:02.000Z',
  });

  fs.rmSync(root, { recursive: true, force: true });
});
