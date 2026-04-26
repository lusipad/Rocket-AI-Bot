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
    activeSkills: ['code-lookup'],
    skillSources: { 'code-lookup': 'explicit' },
    usedTools: ['read_file'],
    rounds: 1,
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
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 1,
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
    error: 'timeout',
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 2,
  });

  assert.deepEqual(store.list({ kind: 'chat' }).map((entry) => entry.requestId), ['req-2', 'req-1']);
  assert.deepEqual(store.list({ status: 'error' }).map((entry) => entry.requestId), ['req-3']);
  assert.deepEqual(store.list({ username: 'alice', limit: 1 }).map((entry) => entry.requestId), ['req-2']);

  assert.deepEqual(store.summarizeRecent(10), {
    total: 3,
    success: 1,
    error: 1,
    rejected: 1,
    byKind: {
      chat: 2,
      scheduler: 1,
    },
    lastFinishedAt: '2026-04-26T02:00:03.000Z',
  });

  fs.rmSync(root, { recursive: true, force: true });
});
