import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRuntime } from '../src/agent-core/runtime.ts';
import { CapabilityRegistry } from '../src/agent-core/capabilities.ts';
import { createAzureDevOpsFileUrlCapability } from '../src/agent-core/capabilities/azure-devops-file-url.ts';
import { createPublicRealtimeWebSearchCapability } from '../src/agent-core/capabilities/public-realtime-web-search.ts';
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
        options.trace.sources = [{ type: 'file', title: 'src/index.ts', ref: 'src/index.ts:10' }];
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
  assert.equal(response.requestType, 'code_query');
  assert.deepEqual(response.sources, [{ type: 'file', title: 'src/index.ts', ref: 'src/index.ts:10' }]);
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

test('AgentRuntime 应按工具和内容细分 scheduler DevTools 请求类型', async () => {
  const runtime = new AgentRuntime({
    previewModelMode() {
      return { mode: 'normal', model: 'gpt-5.5' };
    },
    async handle(
      _userId: string,
      _username: string,
      _message: string,
      _conversation: unknown[],
      _images: string[],
      _requestContext: unknown,
      options: { trace?: OrchestratorTrace },
    ) {
      if (options.trace) {
        options.trace.status = 'success';
        options.trace.finishReason = 'reply';
        options.trace.rounds = 1;
        options.trace.usedTools = ['azure_devops_server_rest'];
      }
      return 'pipeline ok';
    },
  } as never, {
    getModel() {
      return 'gpt-5.5';
    },
  } as never);

  const response = await runtime.handle(
    toSchedulerAgentRequest('req-pipeline', '检查 main 分支最近的 pipeline/build 状态', 'DEVTOOLS'),
  );

  assert.equal(response.requestType, 'pipeline_monitor');
  assert.equal(response.trace.requestType, 'pipeline_monitor');
});

test('AgentRuntime 应识别 scheduler 工作项风险报告', async () => {
  const runtime = new AgentRuntime({
    previewModelMode() {
      return { mode: 'normal', model: 'gpt-5.5' };
    },
    async handle(
      _userId: string,
      _username: string,
      _message: string,
      _conversation: unknown[],
      _images: string[],
      _requestContext: unknown,
      options: { trace?: OrchestratorTrace },
    ) {
      if (options.trace) {
        options.trace.status = 'success';
        options.trace.finishReason = 'reply';
        options.trace.rounds = 1;
        options.trace.usedTools = ['azure_devops_server_rest'];
      }
      return 'work items ok';
    },
  } as never, {
    getModel() {
      return 'gpt-5.5';
    },
  } as never);

  const response = await runtime.handle(
    toSchedulerAgentRequest('req-work-items', '读取工作项并汇总阻塞、超期和负责人风险', 'DEVTOOLS'),
  );

  assert.equal(response.requestType, 'work_item_report');
  assert.equal(response.trace.requestType, 'work_item_report');
});

test('公开实时查询 capability 应在 AgentRuntime 中绕过 legacy Orchestrator', async () => {
  let orchestratorCalled = false;
  const llm = new FakeWebSearchLLM('1. OpenAI 发布更新：<https://openai.com/news/>');
  const runtime = new AgentRuntime(
    {
      previewModelMode() {
        return { mode: 'normal', model: 'gpt-5.5' };
      },
      async handle() {
        orchestratorCalled = true;
        return 'fallback';
      },
    } as never,
    llm as never,
    [createPublicRealtimeWebSearchCapability({
      config: createWebSearchConfig(),
      llm: llm as never,
      resolveModelMode: () => ({ mode: 'normal', model: 'gpt-5.5' }),
    })],
  );

  const response = await runtime.handle({
    id: 'req-news',
    input: '@RocketBot 24小时内的AI新闻',
    actor: { id: 'u1', username: 'alice', kind: 'human' },
    channel: { kind: 'rocketchat' },
  });

  assert.equal(orchestratorCalled, false);
  assert.equal(response.text, '1. OpenAI 发布更新：<https://openai.com/news/>');
  assert.equal(response.finishReason, 'web_search_fast_path');
  assert.equal(response.requestType, 'public_realtime');
  assert.equal(response.model, 'gpt-5.5');
  assert.equal(response.trace.webSearchUsed, true);
  assert.equal(response.trace.rounds, 1);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].options?.apiMode, 'responses');
  assert.deepEqual(llm.calls[0].tools, []);
  assert.match(String(llm.calls[0].messages[0].content), /公开互联网实时信息查询/);
});

test('公开实时查询 capability 不应接管项目内版本问题', async () => {
  let orchestratorCalled = false;
  const llm = new FakeWebSearchLLM('should not be used');
  const runtime = new AgentRuntime(
    {
      previewModelMode() {
        return { mode: 'normal', model: 'gpt-5.5' };
      },
      async handle(
        _userId: string,
        _username: string,
        _message: string,
        _conversation: unknown[],
        _images: string[],
        _requestContext: unknown,
        options: { trace?: OrchestratorTrace },
      ) {
        orchestratorCalled = true;
        if (options.trace) {
          options.trace.status = 'success';
          options.trace.finishReason = 'reply';
          options.trace.rounds = 1;
        }
        return '按当前版本边界回答。';
      },
    } as never,
    llm as never,
    [createPublicRealtimeWebSearchCapability({
      config: createWebSearchConfig(),
      llm: llm as never,
      resolveModelMode: () => ({ mode: 'normal', model: 'gpt-5.5' }),
    })],
  );

  const response = await runtime.handle({
    id: 'req-version',
    input: '@RocketBot 这个版本支持 main 分支吗',
    actor: { id: 'u1', username: 'alice', kind: 'human' },
    channel: { kind: 'rocketchat' },
  });

  assert.equal(orchestratorCalled, true);
  assert.equal(llm.calls.length, 0);
  assert.equal(response.text, '按当前版本边界回答。');
  assert.equal(response.finishReason, 'reply');
});

test('公开实时查询 capability 应识别上游未联网回复', async () => {
  const llm = new FakeWebSearchLLM('我无法联网搜索实时新闻。', false);
  const runtime = new AgentRuntime(
    {
      previewModelMode() {
        return { mode: 'normal', model: 'gpt-5.5' };
      },
      async handle() {
        return 'fallback';
      },
    } as never,
    llm as never,
    [createPublicRealtimeWebSearchCapability({
      config: createWebSearchConfig(),
      llm: llm as never,
      resolveModelMode: () => ({ mode: 'normal', model: 'gpt-5.5' }),
    })],
  );

  const response = await runtime.handle({
    id: 'req-unavailable',
    input: '今天的AI新闻',
    actor: { id: 'u1', username: 'alice', kind: 'human' },
    channel: { kind: 'cli' },
  });

  assert.equal(response.status, 'error');
  assert.equal(response.finishReason, 'web_search_unavailable');
  assert.equal(response.trace.webSearchUsed, false);
  assert.match(response.text, /上游模型没有返回可用的联网搜索结果/);
});

test('Azure DevOps 文件 URL capability 应在 AgentRuntime 中走只读 review 快路径', async () => {
  let orchestratorCalled = false;
  const llm = new FakeWebSearchLLM('没有发现明确问题。');
  const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const registry = {
    async execute(name: string, params: Record<string, unknown>) {
      toolCalls.push({ name, params });
      const version = (params.query as Record<string, unknown> | undefined)?.['versionDescriptor.version'];
      return {
        success: true,
        data: {
          result: {
            content: version === 'main'
              ? 'const value = 0;'
              : 'const value = 1;\nconsole.log(value);',
          },
          sources: [{
            type: 'azure_devops',
            title: String(version),
            ref: `GET git/repositories/test/items:${String(version)}`,
          }],
        },
      };
    },
  };
  const runtime = new AgentRuntime(
    {
      previewModelMode() {
        return { mode: 'normal', model: 'gpt-5.5' };
      },
      async handle() {
        orchestratorCalled = true;
        return 'fallback';
      },
    } as never,
    llm as never,
    [createAzureDevOpsFileUrlCapability({
      config: createWebSearchConfig(),
      llm: llm as never,
      registry: registry as never,
      resolveModelMode: () => ({ mode: 'normal', model: 'gpt-5.5' }),
    })],
  );

  const response = await runtime.handle({
    id: 'req-ado',
    input: 'http://localhost:8081/DefaultCollection/_git/test?path=/codex-skill-smoke.txt&version=GBfeature/codex-skill-pr-smoke-20260411-165356&_a=contents review下',
    actor: { id: 'u1', username: 'alice', kind: 'human' },
    channel: { kind: 'rocketchat' },
  });

  assert.equal(orchestratorCalled, false);
  assert.equal(response.text, '已使用工具: azure_devops_server_rest\n\n没有发现明确问题。');
  assert.equal(response.finishReason, 'ado_url_fast_path');
  assert.equal(response.requestType, 'ado_file_review');
  assert.deepEqual(response.trace.usedTools, ['azure_devops_server_rest']);
  assert.deepEqual(response.sources, [{
    type: 'azure_devops',
    title: 'feature/codex-skill-pr-smoke-20260411-165356',
    ref: 'GET git/repositories/test/items:feature/codex-skill-pr-smoke-20260411-165356',
  }, {
    type: 'azure_devops',
    title: 'main',
    ref: 'GET git/repositories/test/items:main',
  }]);
  assert.equal(toolCalls.length, 2);
  assert.deepEqual(toolCalls[0].params, {
    method: 'GET',
    area: 'git',
    project: 'test',
    resource: 'repositories/test/items',
    query: {
      path: '/codex-skill-smoke.txt',
      includeContent: 'true',
      'versionDescriptor.version': 'feature/codex-skill-pr-smoke-20260411-165356',
      'versionDescriptor.versionType': 'branch',
    },
  });
  assert.deepEqual(toolCalls[1].params, {
    method: 'GET',
    area: 'git',
    project: 'test',
    resource: 'repositories/test/items',
    query: {
      path: '/codex-skill-smoke.txt',
      includeContent: 'true',
      'versionDescriptor.version': 'main',
      'versionDescriptor.versionType': 'branch',
    },
  });
  assert.equal(llm.calls.length, 1);
  assert.match(String(llm.calls[0].messages[1].content), /main 基线内容/);
  assert.match(String(llm.calls[0].messages[1].content), /1: const value = 0;/);
  assert.match(String(llm.calls[0].messages[1].content), /1: const value = 1;/);
  assert.match(String(llm.calls[0].messages[1].content), /版本: feature\/codex-skill-pr-smoke-20260411-165356/);
});

function createWebSearchConfig() {
  return {
    llm: {
      model: 'gpt-5.5',
      apiMode: 'chat_completions',
      nativeWebSearch: {
        enabled: true,
        tools: [{ type: 'web_search' }],
        requestBody: { tool_choice: 'auto' },
      },
    },
  } as never;
}

class FakeWebSearchLLM {
  public readonly calls: Array<{
    messages: Array<{ role: string; content: unknown }>;
    tools: unknown[];
    options: { apiMode?: string; model?: string } | undefined;
  }> = [];

  constructor(
    private readonly reply: string,
    private readonly webSearchUsed = true,
  ) {}

  getModel() {
    return 'gpt-5.5';
  }

  async chat(
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[] = [],
    options?: { apiMode?: string; model?: string },
  ) {
    this.calls.push({ messages, tools, options });
    return Object.assign({
      choices: [{
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: this.reply,
        },
      }],
    }, {
      __rocketbotMeta: { webSearchUsed: this.webSearchUsed },
    });
  }
}
