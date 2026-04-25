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
        count: number,
        excludeMessageId?: string,
      ) => Promise<Array<Record<string, unknown>>>;
    }).getRecentMessages('GENERAL', 'c', 3, 'current-id');

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

test('RocketChatClient 应在时间断层处截断历史上下文', async () => {
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
          ts: '2026-04-25T11:34:53.000Z',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const messages = await client.getRecentMessages('GENERAL', 'c', 10, 'current-id');

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

test('RocketChatClient 应优先围绕当前用户最近一次发言截取上下文', async () => {
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
          msg: '记住了',
          u: { _id: 'bot-user-id', username: 'rocketbot' },
          ts: '2026-04-25T12:00:10.000Z',
        },
        {
          _id: 'current-user',
          rid: 'GENERAL',
          msg: '请记住代号：火箭123',
          u: { _id: 'user-1', username: 'alice' },
          ts: '2026-04-25T12:00:08.000Z',
        },
        {
          _id: 'old-bot',
          rid: 'GENERAL',
          msg: '我不知道。',
          u: { _id: 'bot-user-id', username: 'rocketbot' },
          ts: '2026-04-25T11:58:00.000Z',
        },
        {
          _id: 'old-user',
          rid: 'GENERAL',
          msg: '我刚才让你记住的代号是什么？',
          u: { _id: 'user-1', username: 'alice' },
          ts: '2026-04-25T11:57:58.000Z',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const messages = await (client as never as {
      getRecentMessages: (
        roomId: string,
        roomType: 'c' | 'p' | 'd' | 'l',
        count: number,
        excludeMessageId?: string,
        focusUserId?: string,
        currentTimestamp?: Date,
      ) => Promise<Array<Record<string, unknown>>>;
    }).getRecentMessages('GENERAL', 'c', 10, 'current-id', 'user-1', new Date('2026-04-25T12:00:15.000Z'));

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
    const messages = await client.getRecentMessages('GENERAL', undefined, 5, 'current-id');

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
