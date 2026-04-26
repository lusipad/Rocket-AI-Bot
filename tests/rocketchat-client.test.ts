import assert from 'node:assert/strict';
import test from 'node:test';
import { RocketChatClient } from '../src/bot/client.ts';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

test('RocketChatClient 应按连接与 LLM 状态同步 Rocket.Chat 状态', async () => {
  const client = new RocketChatClient(
    {
      rocketchat: {
        host: 'http://127.0.0.1:3000',
        useSsl: false,
        username: 'rocketbot',
        password: 'bot_password',
      },
    } as never,
    createLogger() as never,
  );

  (client as never as Record<string, unknown>).userId = 'bot-user-id';
  (client as never as Record<string, unknown>).authToken = 'auth-token';

  const requests: Array<{ url: string; body?: string }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    (client as never as Record<string, unknown>).connected = true;
    await client.syncAvailability('CLOSED');
    await client.syncAvailability('OPEN');

    (client as never as Record<string, unknown>).connected = false;
    await client.syncAvailability('CLOSED');

    assert.deepEqual(
      requests.map((item) => ({ url: item.url, body: JSON.parse(item.body ?? '{}') })),
      [
        {
          url: 'http://127.0.0.1:3000/api/v1/users.setStatus',
          body: { status: 'online', message: '' },
        },
        {
          url: 'http://127.0.0.1:3000/api/v1/users.setStatus',
          body: { status: 'busy', message: 'AI 暂时不可用' },
        },
        {
          url: 'http://127.0.0.1:3000/api/v1/users.setStatus',
          body: { status: 'offline', message: 'AI 已离线' },
        },
      ],
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('RocketChatClient 断开连接时应主动同步为离线状态', async () => {
  const client = new RocketChatClient(
    {
      rocketchat: {
        host: 'http://127.0.0.1:3000',
        useSsl: false,
        username: 'rocketbot',
        password: 'bot_password',
      },
    } as never,
    createLogger() as never,
  );

  (client as never as Record<string, unknown>).userId = 'bot-user-id';
  (client as never as Record<string, unknown>).authToken = 'auth-token';
  (client as never as Record<string, unknown>).connected = true;

  let disconnected = false;
  (client as never as Record<string, unknown>).bot = {
    disconnect() {
      disconnected = true;
      return Promise.resolve();
    },
  };

  const requests: Array<{ url: string; body?: string }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await client.disconnect();

    assert.equal(disconnected, true);
    assert.deepEqual(
      requests.map((item) => ({ url: item.url, body: JSON.parse(item.body ?? '{}') })),
      [{
        url: 'http://127.0.0.1:3000/api/v1/users.setStatus',
        body: { status: 'offline', message: 'AI 已离线' },
      }],
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('RocketChatClient 底层 DDP close 后应标记离线并安排重连', async () => {
  const warnings: Array<{ message: string; meta?: unknown }> = [];
  const client = new RocketChatClient(
    {
      rocketchat: {
        host: 'http://127.0.0.1:3000',
        useSsl: false,
        username: 'rocketbot',
        password: 'bot_password',
      },
    } as never,
    {
      ...createLogger(),
      warn(message: string, meta?: unknown) {
        warnings.push({ message, meta });
      },
    } as never,
  );

  (client as never as Record<string, unknown>).userId = 'bot-user-id';
  (client as never as Record<string, unknown>).authToken = 'auth-token';
  (client as never as Record<string, unknown>).connected = true;

  const requests: Array<{ url: string; body?: string }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    (client as never as { handleSocketClose: (event: { code: number; reason: string }) => void })
      .handleSocketClose({ code: 1000, reason: 'disconnect' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(client.isConnected, false);
    assert.equal(warnings[0]?.message, 'Rocket.Chat DDP 连接已关闭，准备重连');
    assert.deepEqual(
      requests.map((item) => ({ url: item.url, body: JSON.parse(item.body ?? '{}') })),
      [{
        url: 'http://127.0.0.1:3000/api/v1/users.setStatus',
        body: { status: 'offline', message: 'AI 已离线' },
      }],
    );
    assert.notEqual((client as never as Record<string, unknown>).reconnectTimer, null);
  } finally {
    const timer = (client as never as Record<string, ReturnType<typeof setTimeout> | null>).reconnectTimer;
    if (timer) {
      clearTimeout(timer);
    }
    (client as never as Record<string, unknown>).reconnectTimer = null;
    global.fetch = originalFetch;
  }
});

test('RocketChatClient 应在 SDK 缺少 meta 时补齐私聊房间类型', async () => {
  const client = new RocketChatClient(
    {
      rocketchat: {
        host: 'http://127.0.0.1:3000',
        useSsl: false,
        username: 'rocketbot',
        password: 'bot_password',
      },
    } as never,
    createLogger() as never,
  );

  (client as never as Record<string, unknown>).userId = 'bot-user-id';
  (client as never as Record<string, unknown>).authToken = 'auth-token';

  let reactHandler: ((err: Error | null, message?: Record<string, unknown>, meta?: Record<string, unknown>) => void) | null = null;
  (client as never as Record<string, unknown>).bot = {
    reactToMessages(handler: typeof reactHandler) {
      reactHandler = handler;
      return Promise.resolve();
    },
  };

  let receivedMeta: Record<string, unknown> | null = null;
  (client as never as Record<string, unknown>).callback = (_err: Error | null, _message: Record<string, unknown>, meta: Record<string, unknown>) => {
    receivedMeta = meta;
  };

  const originalFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.includes('/api/v1/rooms.info')) {
      throw new Error(`Unexpected fetch url: ${url}`);
    }

    return new Response(JSON.stringify({
      room: {
        _id: 'DM1',
        t: 'd',
      },
      success: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await (client as never as { subscribeAndListen: () => Promise<void> }).subscribeAndListen();
    await reactHandler?.(
      null,
      {
        _id: 'msg-dm-1',
        rid: 'DM1',
        msg: '私聊测试',
        u: { _id: 'user-1', username: 'alice' },
      },
      {},
    );

    assert.deepEqual(receivedMeta, {
      roomParticipant: true,
      roomType: 'd',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('RocketChatClient 应获取最近消息并将本地图片转成 data URL', async () => {
  const client = new RocketChatClient(
    {
      rocketchat: {
        host: 'http://127.0.0.1:3000',
        useSsl: false,
        username: 'rocketbot',
        password: 'bot_password',
      },
    } as never,
    createLogger() as never,
  );

  (client as never as Record<string, unknown>).userId = 'bot-user-id';
  (client as never as Record<string, unknown>).authToken = 'auth-token';

  const originalFetch = global.fetch;
  const requests: { url: string; headers?: HeadersInit }[] = [];

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: init?.headers });

    if (url.includes('/api/v1/channels.history')) {
      return new Response(JSON.stringify({
        messages: [
          {
            _id: 'current-id',
            rid: 'GENERAL',
            msg: '@RocketBot 看这个',
            u: { _id: 'user-1', username: 'alice' },
            ts: '2026-04-25T11:00:03.000Z',
          },
          {
            _id: 'thinking-id',
            rid: 'GENERAL',
            msg: '正在思考...',
            u: { _id: 'bot-user-id', username: 'rocketbot' },
            ts: '2026-04-25T11:00:02.000Z',
          },
          {
            _id: 'history-user',
            rid: 'GENERAL',
            msg: '这是图片',
            attachments: [{ image_url: '/file-upload/cat.png' }],
            u: { _id: 'user-1', username: 'alice' },
            ts: '2026-04-25T11:00:01.000Z',
          },
          {
            _id: 'history-bot',
            rid: 'GENERAL',
            msg: '上一条回复',
            u: { _id: 'bot-user-id', username: 'rocketbot' },
            ts: '2026-04-25T11:00:00.000Z',
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url === 'http://127.0.0.1:3000/file-upload/cat.png') {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }

    throw new Error(`Unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const messages = await (client as never as {
      getRecentMessages: (
        roomId: string,
        roomType: 'c' | 'p' | 'd' | 'l',
        options?: Record<string, unknown>,
      ) => Promise<Array<Record<string, unknown>>>;
    }).getRecentMessages('GENERAL', 'c', {
      count: 3,
      excludeMessageId: 'current-id',
    });

    assert.deepEqual(messages, [
      {
        role: 'assistant',
        username: 'rocketbot',
        text: '上一条回复',
        images: [],
      },
      {
        role: 'user',
        username: 'alice',
        text: '这是图片',
        images: ['data:image/png;base64,AQID'],
      },
    ]);

    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /\/api\/v1\/channels\.history/);
    assert.equal((requests[1].headers as Record<string, string>)['X-Auth-Token'], 'auth-token');
  } finally {
    global.fetch = originalFetch;
  }
});

test('RocketChatClient 应通过 REST 发送消息并返回消息 id', async () => {
  const client = new RocketChatClient(
    {
      rocketchat: {
        host: 'http://127.0.0.1:3000',
        useSsl: false,
        username: 'rocketbot',
        password: 'bot_password',
      },
    } as never,
    createLogger() as never,
  );

  (client as never as Record<string, unknown>).userId = 'bot-user-id';
  (client as never as Record<string, unknown>).authToken = 'auth-token';

  const originalFetch = global.fetch;
  const requests: Array<{ url: string; body?: string }> = [];
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    return new Response(JSON.stringify({
      success: true,
      message: {
        _id: 'thinking-message-id',
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const msgId = await client.postToRoomId('正在思考...', 'GENERAL');

    assert.equal(msgId, 'thinking-message-id');
    assert.deepEqual(
      requests.map((item) => ({ url: item.url, body: JSON.parse(item.body ?? '{}') })),
      [{
        url: 'http://127.0.0.1:3000/api/v1/chat.postMessage',
        body: { roomId: 'GENERAL', text: '正在思考...' },
      }],
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('RocketChatClient 应通过 REST 更新已有消息', async () => {
  const client = new RocketChatClient(
    {
      rocketchat: {
        host: 'http://127.0.0.1:3000',
        useSsl: false,
        username: 'rocketbot',
        password: 'bot_password',
      },
    } as never,
    createLogger() as never,
  );

  (client as never as Record<string, unknown>).userId = 'bot-user-id';
  (client as never as Record<string, unknown>).authToken = 'auth-token';

  const originalFetch = global.fetch;
  const requests: Array<{ url: string; body?: string }> = [];
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const updated = await client.updateRoomMessage('GENERAL', 'message-id', '正式回复');

    assert.equal(updated, true);
    assert.deepEqual(
      requests.map((item) => ({ url: item.url, body: JSON.parse(item.body ?? '{}') })),
      [{
        url: 'http://127.0.0.1:3000/api/v1/chat.update',
        body: { roomId: 'GENERAL', msgId: 'message-id', text: '正式回复' },
      }],
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('RocketChatClient 应在明显时间断层处截断无关历史', async () => {
  const client = new RocketChatClient(
    {
      rocketchat: {
        host: 'http://127.0.0.1:3000',
        useSsl: false,
        username: 'rocketbot',
        password: 'bot_password',
      },
    } as never,
    createLogger() as never,
  );

  (client as never as Record<string, unknown>).userId = 'bot-user-id';
  (client as never as Record<string, unknown>).authToken = 'auth-token';

  const originalFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.includes('/api/v1/channels.history')) {
      throw new Error(`Unexpected fetch url: ${url}`);
    }

    return new Response(JSON.stringify({
      messages: [
        {
          _id: 'current-id',
          rid: 'GENERAL',
          msg: '@RocketBot 我刚才说的代号是什么？',
          u: { _id: 'user-1', username: 'alice' },
          ts: '2026-04-25T11:50:54.000Z',
        },
        {
          _id: 'recent-bot',
          rid: 'GENERAL',
          msg: '记住了',
          u: { _id: 'bot-user-id', username: 'rocketbot' },
          ts: '2026-04-25T11:50:50.000Z',
        },
        {
          _id: 'recent-user',
          rid: 'GENERAL',
          msg: '请记住代号：火箭123',
          u: { _id: 'user-1', username: 'alice' },
          ts: '2026-04-25T11:50:47.000Z',
        },
        {
          _id: 'old-bot',
          rid: 'GENERAL',
          msg: '这是十几分钟前的旧对话',
          u: { _id: 'bot-user-id', username: 'rocketbot' },
          ts: '2026-04-25T10:24:53.000Z',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

    try {
      const messages = await client.getRecentMessages('GENERAL', 'c', {
        count: 10,
        excludeMessageId: 'current-id',
        currentTimestamp: new Date('2026-04-25T11:50:54.000Z'),
      });

    assert.deepEqual(messages, [
      {
        role: 'user',
        username: 'alice',
        text: '请记住代号：火箭123',
        images: [],
      },
      {
        role: 'assistant',
        username: 'rocketbot',
        text: '记住了',
        images: [],
      },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('RocketChatClient 应为公共频道保留多人连续讨论的最近切片', async () => {
  const client = new RocketChatClient(
    {
      rocketchat: {
        host: 'http://127.0.0.1:3000',
        useSsl: false,
        username: 'rocketbot',
        password: 'bot_password',
      },
    } as never,
    createLogger() as never,
  );

  (client as never as Record<string, unknown>).userId = 'bot-user-id';
  (client as never as Record<string, unknown>).authToken = 'auth-token';

  const originalFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.includes('/api/v1/channels.history')) {
      throw new Error(`Unexpected fetch url: ${url}`);
    }

    return new Response(JSON.stringify({
      messages: [
        {
          _id: 'current-id',
          rid: 'GENERAL',
          msg: '@RocketBot 我刚才让你记住的代号是什么？',
          u: { _id: 'user-1', username: 'alice' },
          ts: '2026-04-25T12:00:15.000Z',
        },
        {
          _id: 'current-bot',
          rid: 'GENERAL',
          msg: '我先记下两个方案',
          u: { _id: 'bot-user-id', username: 'rocketbot' },
          ts: '2026-04-25T12:00:10.000Z',
        },
        {
          _id: 'recent-bob',
          rid: 'GENERAL',
          msg: '我倾向方案 B，部署最简单',
          u: { _id: 'user-2', username: 'bob' },
          ts: '2026-04-25T11:58:08.000Z',
        },
        {
          _id: 'recent-alice',
          rid: 'GENERAL',
          msg: '方案 A 的维护成本更低',
          u: { _id: 'user-1', username: 'alice' },
          ts: '2026-04-25T11:55:00.000Z',
        },
        {
          _id: 'recent-carol',
          rid: 'GENERAL',
          msg: '我补充下风险点：回滚流程要确认',
          u: { _id: 'user-3', username: 'carol' },
          ts: '2026-04-25T11:50:00.000Z',
        },
        {
          _id: 'old-user',
          rid: 'GENERAL',
          msg: '昨天那个 UI 颜色问题先不讨论了',
          u: { _id: 'user-4', username: 'dave' },
          ts: '2026-04-25T10:30:00.000Z',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const messages = await client.getRecentMessages('GENERAL', 'c', {
      count: 10,
      excludeMessageId: 'current-id',
      currentTimestamp: new Date('2026-04-25T12:00:15.000Z'),
    });

    assert.deepEqual(messages, [
      {
        role: 'user',
        username: 'carol',
        text: '我补充下风险点：回滚流程要确认',
        images: [],
      },
      {
        role: 'user',
        username: 'alice',
        text: '方案 A 的维护成本更低',
        images: [],
      },
      {
        role: 'user',
        username: 'bob',
        text: '我倾向方案 B，部署最简单',
        images: [],
      },
      {
        role: 'assistant',
        username: 'rocketbot',
        text: '我先记下两个方案',
        images: [],
      },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('RocketChatClient 在提供 threadId 时应优先返回当前线程消息', async () => {
  const client = new RocketChatClient(
    {
      rocketchat: {
        host: 'http://127.0.0.1:3000',
        useSsl: false,
        username: 'rocketbot',
        password: 'bot_password',
      },
    } as never,
    createLogger() as never,
  );

  (client as never as Record<string, unknown>).userId = 'bot-user-id';
  (client as never as Record<string, unknown>).authToken = 'auth-token';

  const originalFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.includes('/api/v1/channels.history')) {
      throw new Error(`Unexpected fetch url: ${url}`);
    }

    return new Response(JSON.stringify({
      messages: [
        {
          _id: 'current-id',
          rid: 'GENERAL',
          tmid: 'thread-root',
          msg: '@RocketBot 帮总结这个 thread',
          u: { _id: 'user-1', username: 'alice' },
          ts: '2026-04-25T12:10:15.000Z',
        },
        {
          _id: 'thread-reply-2',
          rid: 'GENERAL',
          tmid: 'thread-root',
          msg: 'thread 里的第二条回复',
          u: { _id: 'user-2', username: 'bob' },
          ts: '2026-04-25T12:09:00.000Z',
        },
        {
          _id: 'room-message',
          rid: 'GENERAL',
          msg: '房间里的其他讨论',
          u: { _id: 'user-3', username: 'carol' },
          ts: '2026-04-25T12:08:30.000Z',
        },
        {
          _id: 'thread-root',
          rid: 'GENERAL',
          msg: 'thread 的根消息',
          u: { _id: 'user-1', username: 'alice' },
          ts: '2026-04-25T12:08:00.000Z',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const messages = await client.getRecentMessages('GENERAL', 'c', {
      count: 10,
      excludeMessageId: 'current-id',
      currentTimestamp: new Date('2026-04-25T12:10:15.000Z'),
      threadId: 'thread-root',
    });

    assert.deepEqual(messages, [
      {
        role: 'user',
        username: 'alice',
        text: 'thread 的根消息',
        images: [],
      },
      {
        role: 'user',
        username: 'bob',
        text: 'thread 里的第二条回复',
        images: [],
      },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('RocketChatClient 应返回当前讨论更早一页历史', async () => {
  const client = new RocketChatClient(
    {
      rocketchat: {
        host: 'http://127.0.0.1:3000',
        useSsl: false,
        username: 'rocketbot',
        password: 'bot_password',
      },
    } as never,
    createLogger() as never,
  );

  (client as never as Record<string, unknown>).userId = 'bot-user-id';
  (client as never as Record<string, unknown>).authToken = 'auth-token';

  const originalFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.includes('/api/v1/channels.history')) {
      throw new Error(`Unexpected fetch url: ${url}`);
    }

    return new Response(JSON.stringify({
      messages: [
        {
          _id: 'current-id',
          rid: 'GENERAL',
          msg: '@RocketBot 帮忙继续总结',
          u: { _id: 'user-1', username: 'alice' },
          ts: '2026-04-25T12:10:15.000Z',
        },
        {
          _id: 'recent-bot',
          rid: 'GENERAL',
          msg: '我先总结最近几条',
          u: { _id: 'bot-user-id', username: 'rocketbot' },
          ts: '2026-04-25T12:09:00.000Z',
        },
        {
          _id: 'anchor-id',
          rid: 'GENERAL',
          msg: '这里是当前已知最早的一条',
          u: { _id: 'user-2', username: 'bob' },
          ts: '2026-04-25T12:05:00.000Z',
        },
        {
          _id: 'older-1',
          rid: 'GENERAL',
          msg: '更早的讨论一',
          u: { _id: 'user-3', username: 'carol' },
          ts: '2026-04-25T12:03:00.000Z',
        },
        {
          _id: 'older-2',
          rid: 'GENERAL',
          msg: '更早的讨论二',
          attachments: [{ image_url: '/file-upload/diagram.png' }],
          u: { _id: 'user-1', username: 'alice' },
          ts: '2026-04-25T12:00:00.000Z',
        },
        {
          _id: 'old-gap',
          rid: 'GENERAL',
          msg: '太久以前的话题',
          u: { _id: 'user-4', username: 'dave' },
          ts: '2026-04-25T08:00:00.000Z',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const page = await client.getDiscussionHistoryPage('GENERAL', 'c', {
      beforeMessageId: 'anchor-id',
      limit: 5,
      currentTimestamp: new Date('2026-04-25T12:05:00.000Z'),
      useExtendedWindow: true,
    });

    assert.deepEqual(page, {
      messages: [
        {
          id: 'older-2',
          threadId: undefined,
          role: 'user',
          username: 'alice',
          text: '更早的讨论二',
          imageCount: 1,
          timestamp: '2026-04-25T12:00:00.000Z',
        },
        {
          id: 'older-1',
          threadId: undefined,
          role: 'user',
          username: 'carol',
          text: '更早的讨论一',
          imageCount: 0,
          timestamp: '2026-04-25T12:03:00.000Z',
        },
      ],
      hasMore: true,
      nextBeforeMessageId: 'older-2',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('RocketChatClient 在缺少 roomType 时应回退到可用的 history 接口', async () => {
  const client = new RocketChatClient(
    {
      rocketchat: {
        host: 'http://127.0.0.1:3000',
        useSsl: false,
        username: 'rocketbot',
        password: 'bot_password',
      },
    } as never,
    createLogger() as never,
  );

  (client as never as Record<string, unknown>).userId = 'bot-user-id';
  (client as never as Record<string, unknown>).authToken = 'auth-token';

  const originalFetch = global.fetch;
  const urls: string[] = [];
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);

    if (url.includes('/api/v1/channels.history')) {
      return new Response(JSON.stringify({
        messages: [{
          _id: 'history-user',
          rid: 'GENERAL',
          msg: '回退成功',
          u: { _id: 'user-1', username: 'alice' },
          ts: '2026-04-25T12:00:01.000Z',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: false }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

    try {
      const messages = await client.getRecentMessages('GENERAL', undefined, {
        count: 5,
        excludeMessageId: 'current-id',
      });

    assert.deepEqual(messages, [{
      role: 'user',
      username: 'alice',
      text: '回退成功',
      images: [],
    }]);
    assert.match(urls[0], /\/api\/v1\/channels\.history/);
  } finally {
    global.fetch = originalFetch;
  }
});
