import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRuntime } from '../src/agent-core/runtime.ts';
import { CapabilityRegistry } from '../src/agent-core/capabilities.ts';
import { toRocketChatAgentRequest, toSchedulerAgentRequest } from '../src/adapters/rocketchat/message-normalizer.ts';
import type { BotMessage } from '../src/bot/message-handler.ts';
import type { OrchestratorTrace } from '../src/agent/orchestrator.ts';

test('AgentRuntime 应通过通用 AgentRequest 调用现有 Orchestrator', async () => {
  const captured: Record<string, unknown> = {};
  const orchestrator = {
    previewModelMode(userId: string, message: string, requestContext: unknown) {
      captured.preview = { userId, message, requestContext };
      return { mode: 'normal', model: 'gpt-5.5' };
    },
    async handle(
      userId: string,
      username: string,
      message: string,
      conversation: unknown[],
      images: string[],
      requestContext: unknown,
      options: { requestId?: string; trace?: OrchestratorTrace },
    ) {
      captured.handle = { userId, username, message, conversation, images, requestContext, requestId: options.requestId };
      if (options.trace) {
        options.trace.activeSkills = ['code-lookup'];
        options.trace.skillSources = { 'code-lookup': 'explicit' };
        options.trace.usedTools = ['read_file'];
        options.trace.rounds = 1;
        options.trace.status = 'success';
        options.trace.finishReason = 'reply';
        options.trace.modelMode = 'normal';
      }
      return 'ok';
    },
  };
  const llm = {
    getModel() {
      return 'gpt-5.5';
    },
  };
  const runtime = new AgentRuntime(orchestrator as never, llm as never);
  const request = {
    id: 'req-1',
    input: '看下代码',
    actor: { id: 'u1', username: 'alice', kind: 'human' as const },
    channel: {
      kind: 'rocketchat',
      roomId: 'room-1',
      roomType: 'p' as const,
      threadId: 'thread-1',
    },
    conversation: [{ role: 'user' as const, username: 'bob', text: '前文' }],
    attachments: [{ type: 'image' as const, url: 'data:image/png;base64,AAAA' }],
    metadata: {
      triggerMessageId: 'msg-1',
      timestamp: new Date('2026-04-28T00:00:00.000Z'),
    },
  };

  assert.deepEqual(runtime.previewModelMode(request), { mode: 'normal', model: 'gpt-5.5' });
  const response = await runtime.handle(request);

  assert.equal(response.text, 'ok');
  assert.equal(response.model, 'gpt-5.5');
  assert.equal(response.finishReason, 'reply');
  assert.deepEqual(response.trace.activeSkills, ['code-lookup']);
  assert.deepEqual(response.trace.usedTools, ['read_file']);
  assert.deepEqual(captured.handle, {
    userId: 'u1',
    username: 'alice',
    message: '看下代码',
    conversation: [{ role: 'user', username: 'bob', text: '前文' }],
    images: ['data:image/png;base64,AAAA'],
    requestContext: {
      requestId: 'req-1',
      roomId: 'room-1',
      roomType: 'p',
      threadId: 'thread-1',
      triggerMessageId: 'msg-1',
      timestamp: new Date('2026-04-28T00:00:00.000Z'),
    },
    requestId: 'req-1',
  });
});

test('AgentRuntime 应优先使用已注册 capability，再回退到 Orchestrator', async () => {
  let orchestratorCalled = false;
  const orchestrator = {
    previewModelMode() {
      return { mode: 'normal', model: 'gpt-5.5' };
    },
    async handle() {
      orchestratorCalled = true;
      return 'fallback';
    },
  };
  const runtime = new AgentRuntime(orchestrator as never, {
    getModel() {
      return 'gpt-5.5';
    },
  } as never, [{
    id: 'fast-hello',
    description: 'fast hello capability',
    priority: 100,
    canHandle: (request) => request.input === 'hello',
    async handle(request) {
      return {
        requestId: request.id,
        status: 'success',
        text: 'fast hello',
        messages: [{ type: 'text', text: 'fast hello' }],
        finishReason: 'fast_hello',
        model: 'none',
        trace: {
          activeSkills: [],
          skillSources: {},
          usedTools: [],
          rounds: 0,
          status: 'success',
        },
      };
    },
  }]);

  const response = await runtime.handle({
    id: 'req-fast',
    input: 'hello',
    actor: { id: 'u1', username: 'alice', kind: 'human' },
    channel: { kind: 'cli' },
  });

  assert.equal(response.text, 'fast hello');
  assert.equal(response.finishReason, 'fast_hello');
  assert.equal(orchestratorCalled, false);
});

test('CapabilityRegistry 应拒绝重复 id', () => {
  const registry = new CapabilityRegistry();
  const capability = {
    id: 'dup',
    description: 'duplicate',
    priority: 0,
    canHandle: () => false,
    async handle() {
      throw new Error('not used');
    },
  };

  registry.register(capability);
  assert.throws(() => registry.register(capability), /capability 已注册: dup/);
});

test('Rocket.Chat adapter 应把 BotMessage 转成 AgentRequest', () => {
  const msg: BotMessage = {
    id: 'msg-1',
    requestId: 'old-req',
    text: '@RocketBot 24小时内的AI新闻',
    userId: 'u1',
    username: 'alice',
    roomId: 'room-1',
    roomName: 'general',
    roomType: 'p',
    threadId: 'thread-1',
    triggerMessageId: 'msg-1',
    timestamp: new Date('2026-04-28T00:00:00.000Z'),
    images: [{ url: '/file/image.png' }],
  };

  const request = toRocketChatAgentRequest(
    msg,
    'req-1',
    [{ role: 'assistant', username: 'RocketBot', text: '上一条' }],
    ['data:image/png;base64,AAAA'],
  );

  assert.equal(request.id, 'req-1');
  assert.equal(request.input, msg.text);
  assert.deepEqual(request.actor, { id: 'u1', username: 'alice', kind: 'human' });
  assert.deepEqual(request.channel, {
    kind: 'rocketchat',
    roomId: 'room-1',
    roomName: 'general',
    roomType: 'p',
    threadId: 'thread-1',
  });
  assert.deepEqual(request.attachments, [{ type: 'image', url: 'data:image/png;base64,AAAA' }]);
  assert.equal(request.metadata?.triggerMessageId, 'msg-1');
});

test('scheduler adapter 应复用同一个 AgentRequest 协议', () => {
  const request = toSchedulerAgentRequest('req-2', '生成日报', 'general');

  assert.equal(request.id, 'req-2');
  assert.equal(request.input, '执行定时任务: 生成日报');
  assert.deepEqual(request.actor, { id: 'scheduler', username: '系统', kind: 'system' });
  assert.deepEqual(request.channel, { kind: 'scheduler', roomId: 'general' });
});
