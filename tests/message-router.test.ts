import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageRouter } from '../src/bot/message-handler.ts';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

class FakeDeduplicator {
  private readonly ids = new Set<string>();

  isProcessed(id: string): boolean {
    return this.ids.has(id);
  }

  markProcessed(id: string): void {
    this.ids.add(id);
  }
}

test('机器人连接后应忽略自己发出的消息', async () => {
  const client = { botUserId: null as string | null };
  const router = new MessageRouter(
    client as never,
    new FakeDeduplicator() as never,
    { rocketchat: { botUsername: 'RocketBot' } } as never,
    createLogger() as never,
  );

  let mentions = 0;
  router.on('mention', async () => {
    mentions += 1;
  });

  client.botUserId = 'bot-user-id';

  await router.handleRawMessage(
    null,
    {
      _id: 'msg-1',
      msg: '@RocketBot 自己发的消息',
      rid: 'room-1',
      u: { _id: 'bot-user-id', username: 'RocketBot' },
    },
    {
      roomParticipant: true,
      roomType: 'c',
      roomName: 'general',
    },
  );

  assert.equal(mentions, 0);
});

test('普通 mention 只处理一次，重复消息会被去重', async () => {
  const router = new MessageRouter(
    { botUserId: 'bot-user-id' } as never,
    new FakeDeduplicator() as never,
    { rocketchat: { botUsername: 'RocketBot' } } as never,
    createLogger() as never,
  );

  let mentions = 0;
  router.on('mention', async () => {
    mentions += 1;
  });

  const rawMessage = {
    _id: 'msg-2',
    msg: '@RocketBot 帮我看下状态',
    rid: 'room-1',
    u: { _id: 'user-1', username: 'alice' },
  };
  const meta = {
    roomParticipant: true as const,
    roomType: 'c' as const,
    roomName: 'general',
  };

  await router.handleRawMessage(null, rawMessage, meta);
  await router.handleRawMessage(null, rawMessage, meta);

  assert.equal(mentions, 1);
});

test('mention 消息应携带图片附件信息', async () => {
  const router = new MessageRouter(
    { botUserId: 'bot-user-id' } as never,
    new FakeDeduplicator() as never,
    { rocketchat: { botUsername: 'RocketBot' } } as never,
    createLogger() as never,
  );

  let received: Record<string, unknown> | null = null;
  router.on('mention', async (msg) => {
    received = msg as unknown as Record<string, unknown>;
  });

  await router.handleRawMessage(
    null,
    {
      _id: 'msg-3',
      msg: '@RocketBot 看下这张图',
      rid: 'room-1',
      attachments: [
        { image_url: 'https://example.com/cat.png' },
        { text: 'no image here' },
      ],
      u: { _id: 'user-1', username: 'alice' },
    } as never,
    {
      roomParticipant: true,
      roomType: 'c',
      roomName: 'general',
    },
  );

  assert.deepEqual(received?.images, [
    { url: 'https://example.com/cat.png' },
  ]);
});
