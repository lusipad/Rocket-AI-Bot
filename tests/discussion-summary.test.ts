import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type ConversationMessage } from '../src/agent/orchestrator.ts';
import { DiscussionSummaryService, isDiscussionContextRequest, stripReplyDecorations } from '../src/discussion/summary-service.ts';
import { DiscussionSummaryStore } from '../src/discussion/summary-store.ts';

test('DiscussionSummaryStore 应按 room/thread 维度读写摘要', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-discussion-summary-'));
  const store = new DiscussionSummaryStore(rootDir);

  store.save({
    roomId: 'GENERAL',
    threadId: 'thread-1',
    summary: '这是 thread 摘要',
    updatedAt: '2026-04-26T08:00:00.000Z',
    sourceMessageCount: 6,
  });

  store.save({
    roomId: 'GENERAL',
    summary: '这是房间摘要',
    updatedAt: '2026-04-26T09:00:00.000Z',
    sourceMessageCount: 3,
  });

  assert.deepEqual(store.get({ roomId: 'GENERAL', threadId: 'thread-1' }), {
    roomId: 'GENERAL',
    threadId: 'thread-1',
    summary: '这是 thread 摘要',
    updatedAt: '2026-04-26T08:00:00.000Z',
    sourceMessageCount: 6,
  });
  assert.deepEqual(store.get({ roomId: 'GENERAL' }), {
    roomId: 'GENERAL',
    summary: '这是房间摘要',
    updatedAt: '2026-04-26T09:00:00.000Z',
    sourceMessageCount: 3,
  });
});

test('DiscussionSummaryService 应只在讨论型请求里注入缓存摘要', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-discussion-service-'));
  const store = new DiscussionSummaryStore(rootDir);
  const service = new DiscussionSummaryService(store);

  store.save({
    roomId: 'GENERAL',
    threadId: 'thread-1',
    summary: '方案 A 成本低，方案 B 上线快',
    updatedAt: '2026-04-26T10:00:00.000Z',
    sourceMessageCount: 5,
  });

  const summaryMessage = service.prepareContext('帮我继续梳理刚才讨论', {
    roomId: 'GENERAL',
    threadId: 'thread-1',
  });

  assert.deepEqual(summaryMessage, {
    role: 'assistant',
    username: 'discussion-summary',
    text: '[当前 thread 讨论摘要，更新于 2026-04-26T10:00:00.000Z]\n方案 A 成本低，方案 B 上线快\n如果与最近消息冲突，以最近消息为准。',
    images: [],
    isSummary: true,
  });

  assert.equal(service.prepareContext('你好', { roomId: 'GENERAL', threadId: 'thread-1' }), null);
});

test('DiscussionSummaryService 应只在总结型请求后刷新摘要并忽略 synthetic summary 消息', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-discussion-refresh-'));
  const store = new DiscussionSummaryStore(rootDir);
  const service = new DiscussionSummaryService(store);
  const recentMessages: ConversationMessage[] = [
    {
      role: 'assistant',
      username: 'discussion-summary',
      text: '旧摘要',
      images: [],
      isSummary: true,
    },
    {
      role: 'user',
      username: 'alice',
      text: '方案 A 维护成本更低',
      images: [],
    },
    {
      role: 'user',
      username: 'bob',
      text: '方案 B 上线更快',
      images: [],
    },
  ];

  const refreshed = service.maybeRefreshFromReply(
    '请帮我总结一下',
    { roomId: 'GENERAL' },
    recentMessages,
    '上下文: 当前房间讨论摘要 + 最近 2 条消息\n已激活 skill: artifact-writer\n已使用工具: room_history\n\n结论：先走方案 B，再补回滚预案。',
  );

  assert.equal(refreshed, true);
  assert.deepEqual(store.get({ roomId: 'GENERAL' }), {
    roomId: 'GENERAL',
    summary: '结论：先走方案 B，再补回滚预案。',
    updatedAt: store.get({ roomId: 'GENERAL' })?.updatedAt,
    sourceMessageCount: 2,
  });

  const skipped = service.maybeRefreshFromReply(
    '继续说',
    { roomId: 'GENERAL' },
    recentMessages,
    '不会写入',
  );

  assert.equal(skipped, false);
});

test('discussion summary helper 应识别讨论意图并清洗回复装饰', () => {
  assert.equal(isDiscussionContextRequest('继续总结刚才的讨论'), true);
  assert.equal(isDiscussionContextRequest('你好'), false);
  assert.equal(
    stripReplyDecorations('上下文: 当前 thread 讨论摘要 + 最近 4 条消息\n已使用工具: room_history\n\n这是正式结论'),
    '这是正式结论',
  );
});
