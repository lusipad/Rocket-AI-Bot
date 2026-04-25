import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoomHistoryTool } from '../src/tools/room-history.ts';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

test('room_history 工具应基于当前请求房间与线程补拉历史', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tool = createRoomHistoryTool({
    async getDiscussionHistoryPage(roomId, roomType, options) {
      calls.push({ roomId, roomType, options });
      return {
        messages: [{
          id: 'older-1',
          threadId: 'thread-root',
          role: 'user',
          username: 'alice',
          text: '更早的讨论',
          imageCount: 0,
          timestamp: '2026-04-26T05:10:00.000Z',
        }],
        hasMore: false,
        nextBeforeMessageId: 'older-1',
      };
    },
  } as never);

  const result = await tool.execute(
    { before_message_id: 'anchor-id', limit: 99, purpose: '总结当前讨论' },
    createLogger() as never,
    {
      request: {
        roomId: 'GENERAL',
        roomType: 'c',
        threadId: 'thread-root',
        triggerMessageId: 'current-id',
        timestamp: new Date('2026-04-26T05:20:00.000Z'),
      },
    },
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls, [{
    roomId: 'GENERAL',
    roomType: 'c',
    options: {
      beforeMessageId: 'anchor-id',
      limit: 30,
      currentTimestamp: new Date('2026-04-26T05:20:00.000Z'),
      threadId: 'thread-root',
      useExtendedWindow: true,
    },
  }]);
  assert.deepEqual(result.data, {
    roomId: 'GENERAL',
    threadId: 'thread-root',
    beforeMessageId: 'anchor-id',
    purpose: '总结当前讨论',
    count: 1,
    hasMore: false,
    nextBeforeMessageId: 'older-1',
    messages: [{
      id: 'older-1',
      threadId: 'thread-root',
      role: 'user',
      username: 'alice',
      text: '更早的讨论',
      imageCount: 0,
      timestamp: '2026-04-26T05:10:00.000Z',
    }],
  });
});

test('room_history 工具在没有请求上下文时应拒绝执行', async () => {
  const tool = createRoomHistoryTool({
    async getDiscussionHistoryPage() {
      throw new Error('should not be called');
    },
  } as never);

  const result = await tool.execute({}, createLogger() as never, {});
  assert.equal(result.success, false);
  assert.equal(result.data.error, '当前请求没有房间上下文，无法读取聊天历史');
});
