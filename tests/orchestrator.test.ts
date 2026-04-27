import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type OpenAI from 'openai';
import { buildSystemPrompt, Orchestrator, resolveRequestedSkills, type OrchestratorTrace } from '../src/agent/orchestrator.ts';
import { ContextBuilder } from '../src/llm/context.ts';
import { SkillRegistry } from '../src/skills/registry.ts';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function createSkillRegistry(skills: Array<{
  name: string;
  description: string;
  allowedTools?: string;
  instructions: string;
}>): SkillRegistry {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbot-skills-'));
  const statePath = path.join(root, '..', `${path.basename(root)}-state.json`);

  for (const skill of skills) {
    const skillDir = path.join(root, skill.name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${skill.name}\ndescription: ${skill.description}\nallowed-tools: ${skill.allowedTools ?? ''}\n---\n${skill.instructions}\n`,
      'utf8',
    );
  }

  return new SkillRegistry(root, undefined, statePath);
}

test('ContextBuilder 应按时间顺序构建消息', () => {
  const context = new ContextBuilder(
    { llm: { contextWindow: 1024 } } as never,
    'system prompt',
  );

  context.add('user', '第一条用户消息');
  context.add('assistant', '第一条助手消息');
  context.add('user', '第二条用户消息');

  assert.deepEqual(context.build(0), [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: '第一条用户消息' },
    { role: 'assistant', content: '第一条助手消息' },
    { role: 'user', content: '第二条用户消息' },
  ]);
});

test('Orchestrator 在工具调用后应保留 tool_calls 并按正确顺序继续请求 LLM', async () => {
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [{
    id: 'call_123',
    type: 'function',
    function: {
      name: 'azure_devops',
      arguments: JSON.stringify({ kind: 'pr' }),
    },
  }];

  class FakeLLM {
    public readonly calls: OpenAI.Chat.Completions.ChatCompletionMessageParam[][] = [];

    async chat(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
      this.calls.push(messages);

      if (this.calls.length === 1) {
        return {
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            logprobs: null,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: toolCalls,
            },
          }],
        } as OpenAI.Chat.Completions.ChatCompletion;
      }

      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: '最新 PR 是 #1',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  const llm = new FakeLLM();
  const registry = {
    getDefinitions() {
      return [{
        type: 'function',
        function: {
          name: 'azure_devops',
          description: '查询 Azure DevOps',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      }];
    },
    async execute(name: string, params: Record<string, unknown>) {
      assert.equal(name, 'azure_devops');
      assert.deepEqual(params, { kind: 'pr' });

      return {
        success: true,
        data: {
          prs: [{ prId: 1, title: 'Skill smoke PR preview' }],
          sources: [{ type: 'azure_devops', title: 'PR #1', ref: 'PR #1' }],
        },
      };
    },
  };

  const orchestrator = new Orchestrator(
    llm as never,
    registry as never,
    {
      llm: { contextWindow: 32768 },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
  );

  const reply = await orchestrator.handle('user-1', 'alice', '帮我看下 PR', []);

  assert.equal(reply, '已使用工具: azure_devops\n\n最新 PR 是 #1');
  assert.equal(llm.calls.length, 2);

  const secondCall = llm.calls[1];
  assert.deepEqual(secondCall.map((message) => message.role), [
    'system',
    'user',
    'assistant',
    'tool',
  ]);

  const assistantMessage = secondCall[2] as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
  assert.deepEqual(assistantMessage.tool_calls, toolCalls);

  const toolMessage = secondCall[3] as OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
  assert.equal(toolMessage.tool_call_id, 'call_123');
  assert.match(String(toolMessage.content), /Skill smoke PR preview/);
  assert.match(String(toolMessage.content), /"sources"/);
});

test('Orchestrator 对 Azure DevOps 文件 URL review 应走直接快路径', async () => {
  const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];

  class FakeLLM {
    public readonly calls: OpenAI.Chat.Completions.ChatCompletionMessageParam[][] = [];
    public readonly toolsByCall: OpenAI.Chat.Completions.ChatCompletionTool[][] = [];

    async chat(
      messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
    ) {
      this.calls.push(messages);
      this.toolsByCall.push(tools);
      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: '没有发现明确问题。',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  const llm = new FakeLLM();
  const orchestrator = new Orchestrator(
    llm as never,
    {
      getDefinitions() {
        return [{
          type: 'function',
          function: {
            name: 'azure_devops_server_rest',
            description: '查询 ADO Server',
            parameters: { type: 'object', properties: {} },
          },
        }];
      },
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
          },
        };
      },
    } as never,
    {
      llm: { contextWindow: 32768 },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
    createSkillRegistry([]),
  );
  const trace: OrchestratorTrace = {
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 0,
    status: 'success',
  };

  const reply = await orchestrator.handle(
    'user-1',
    'alice',
    'http://localhost:8081/DefaultCollection/_git/test?path=/codex-skill-smoke.txt&version=GBfeature/codex-skill-pr-smoke-20260411-165356&_a=contents review下',
    [],
    [],
    undefined,
    { trace },
  );

  assert.equal(reply, '已使用工具: azure_devops_server_rest\n\n没有发现明确问题。');
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].name, 'azure_devops_server_rest');
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
  assert.deepEqual(llm.toolsByCall[0], []);
  assert.match(String(llm.calls[0][1].content), /main 基线内容/);
  assert.match(String(llm.calls[0][1].content), /1: const value = 0;/);
  assert.match(String(llm.calls[0][1].content), /1: const value = 1;/);
  assert.match(String(llm.calls[0][1].content), /版本: feature\/codex-skill-pr-smoke-20260411-165356/);
  assert.deepEqual(trace, {
    activeSkills: [],
    skillSources: {},
    usedTools: ['azure_devops_server_rest'],
    rounds: 1,
    status: 'success',
    finishReason: 'ado_url_fast_path',
    error: undefined,
    webSearchUsed: false,
    modelMode: 'normal',
  });
});

test('Orchestrator 应将最近消息和当前图片作为多模态 user content 发送给 LLM', async () => {
  class FakeLLM {
    public readonly calls: OpenAI.Chat.Completions.ChatCompletionMessageParam[][] = [];

    async chat(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
      this.calls.push(messages);

      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: '我看到图片了',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  const llm = new FakeLLM();
  const orchestrator = new Orchestrator(
    llm as never,
    { getDefinitions() { return []; } } as never,
    {
      llm: { contextWindow: 32768 },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
  );

  const reply = await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot 这张图里是什么',
    [
      { role: 'assistant', username: 'RocketBot', text: '把图发来' },
      {
        role: 'user',
        username: 'alice',
        text: '上一张图',
        images: ['data:image/png;base64,AAAA'],
      } as never,
    ],
    ['data:image/png;base64,BBBB'] as never,
  );

  assert.equal(reply, '我看到图片了');
  assert.equal(llm.calls.length, 1);

  const firstCall = llm.calls[0];
  assert.deepEqual(firstCall.map((message) => message.role), [
    'system',
    'assistant',
    'user',
    'user',
  ]);

  const historyUser = firstCall[2] as OpenAI.Chat.Completions.ChatCompletionUserMessageParam;
  assert.ok(Array.isArray(historyUser.content));
  assert.deepEqual(historyUser.content, [
    { type: 'text', text: '[alice] 上一张图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'auto' } },
  ]);

  const currentUser = firstCall[3] as OpenAI.Chat.Completions.ChatCompletionUserMessageParam;
  assert.ok(Array.isArray(currentUser.content));
  assert.deepEqual(currentUser.content, [
    { type: 'text', text: '@alice: @RocketBot 这张图里是什么' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB', detail: 'auto' } },
  ]);
});

test('Orchestrator 在 responses 模式下应将历史助手消息内联为普通上下文', async () => {
  class FakeLLM {
    public readonly calls: OpenAI.Chat.Completions.ChatCompletionMessageParam[][] = [];

    async chat(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
      this.calls.push(messages);
      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: 'ok',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  const llm = new FakeLLM();
  const orchestrator = new Orchestrator(
    llm as never,
    { getDefinitions() { return []; } } as never,
    {
      llm: { contextWindow: 32768, apiMode: 'responses' },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
  );

  await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot 继续',
    [
      { role: 'assistant', username: 'RocketBot', text: '上一条回答' },
      { role: 'user', username: 'alice', text: '上一条问题' },
    ],
  );

  const firstCall = llm.calls[0];
  assert.deepEqual(firstCall.map((message) => message.role), [
    'system',
    'user',
    'user',
    'user',
  ]);
  assert.equal(firstCall[1].content, '[历史助手消息] [RocketBot] 上一条回答');
});

test('Orchestrator 应保留 synthetic discussion summary，而不是被最近消息裁掉', async () => {
  class FakeLLM {
    public readonly calls: OpenAI.Chat.Completions.ChatCompletionMessageParam[][] = [];

    async chat(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
      this.calls.push(messages);
      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: 'ok',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  const llm = new FakeLLM();
  const orchestrator = new Orchestrator(
    llm as never,
    { getDefinitions() { return []; } } as never,
    {
      llm: { contextWindow: 32768 },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
  );

  const recentMessages = Array.from({ length: 25 }, (_, index) => ({
    role: 'user' as const,
    username: `user-${index + 1}`,
    text: `普通消息 ${index + 1}`,
    images: [],
  }));
  recentMessages.push({
    role: 'assistant',
    username: 'discussion-summary',
    text: '缓存摘要：已经比较过方案 A 和方案 B。',
    images: [],
    isSummary: true,
  });

  await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot 帮我继续梳理',
    recentMessages,
  );

  const firstCall = llm.calls[0];
  const historyMessages = firstCall.slice(1, -1);
  assert.equal(historyMessages.length, 21);
  assert.ok(
    historyMessages.some((message) =>
      message.role === 'assistant' && message.content === '[discussion-summary] 缓存摘要：已经比较过方案 A 和方案 B。'),
  );
  assert.ok(
    historyMessages.some((message) =>
      message.role === 'user' && message.content === '[user-25] 普通消息 25'),
  );
});

test('Orchestrator 应将请求上下文透传给工具执行层', async () => {
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [{
    id: 'call_room_history',
    type: 'function',
    function: {
      name: 'room_history',
      arguments: JSON.stringify({ before_message_id: 'msg-1', limit: 10 }),
    },
  }];

  class FakeLLM {
    async chat(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
      const hasToolResult = messages.some((message) => message.role === 'tool');
      if (!hasToolResult) {
        return {
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            logprobs: null,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: toolCalls,
            },
          }],
        } as OpenAI.Chat.Completions.ChatCompletion;
      }

      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: '总结好了',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  let receivedContext: Record<string, unknown> | undefined;
  const orchestrator = new Orchestrator(
    new FakeLLM() as never,
    {
      getDefinitions() {
        return [{
          type: 'function',
          function: {
            name: 'room_history',
            description: '补拉当前房间历史',
            parameters: { type: 'object', properties: {} },
          },
        }];
      },
      async execute(_name: string, _params: Record<string, unknown>, context: Record<string, unknown>) {
        receivedContext = context;
        return {
          success: true,
          data: { messages: [{ text: '更早讨论' }] },
        };
      },
    } as never,
    {
      llm: { contextWindow: 32768 },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
  );

  const reply = await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot 帮我补一下更早上下文',
    [],
    [],
    {
      roomId: 'GENERAL',
      roomType: 'c',
      threadId: 'thread-1',
      triggerMessageId: 'msg-1',
      timestamp: new Date('2026-04-26T05:00:00.000Z'),
    },
  );

  assert.equal(reply, '已使用工具: room_history\n\n总结好了');
  assert.deepEqual(receivedContext, {
    request: {
      roomId: 'GENERAL',
      roomType: 'c',
      threadId: 'thread-1',
      triggerMessageId: 'msg-1',
      timestamp: new Date('2026-04-26T05:00:00.000Z'),
    },
    requestId: receivedContext?.requestId,
  });
  assert.match(String(receivedContext?.requestId), /^[0-9a-f-]{36}$/i);
});

test('Orchestrator 应把激活 skill、工具和完成状态写入 trace', async () => {
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [
    {
      id: 'call_activate_skill',
      type: 'function',
      function: {
        name: 'activate_skill',
        arguments: JSON.stringify({ name: 'code-lookup' }),
      },
    },
    {
      id: 'call_read_file',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: JSON.stringify({ path: 'src/index.ts' }),
      },
    },
  ];

  class FakeLLM {
    private round = 0;

    async chat() {
      this.round += 1;
      if (this.round === 1) {
        return {
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            logprobs: null,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: toolCalls,
            },
          }],
        } as OpenAI.Chat.Completions.ChatCompletion;
      }

      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: '处理完成',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  const trace: OrchestratorTrace = {
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 0,
    status: 'success',
  };

  const orchestrator = new Orchestrator(
    new FakeLLM() as never,
    {
      getDefinitions() {
        return [{
          type: 'function',
          function: {
            name: 'read_file',
            description: '读取文件',
            parameters: { type: 'object', properties: {} },
          },
        }];
      },
      async execute(name: string) {
        assert.equal(name, 'read_file');
        return {
          success: true,
          data: {
            content: 'index',
          },
        };
      },
    } as never,
    {
      llm: { contextWindow: 32768 },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
    createSkillRegistry([{
      name: 'code-lookup',
      description: '查代码',
      allowedTools: 'read_file',
      instructions: '- 先结论后证据',
    }]),
  );

  const reply = await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot 帮我看看',
    [],
    [],
    undefined,
    {
      requestId: 'req-trace-1',
      trace,
    },
  );

  assert.equal(reply, '已激活 skill: code-lookup\n已使用工具: read_file\n\n处理完成');
  assert.deepEqual(trace, {
    activeSkills: ['code-lookup'],
    skillSources: {
      'code-lookup': 'model',
    },
    usedTools: ['read_file'],
    rounds: 2,
    status: 'success',
    finishReason: 'reply',
    error: undefined,
    webSearchUsed: false,
    modelMode: 'normal',
  });
});

test('Orchestrator 在激活 skill 后应按 allowed-tools 收缩工具集合', async () => {
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [{
    id: 'call_activate_skill',
    type: 'function',
    function: {
      name: 'activate_skill',
      arguments: JSON.stringify({ name: 'code-lookup' }),
    },
  }];

  class FakeLLM {
    public readonly toolNamesByRound: string[][] = [];

    async chat(
      _messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
    ) {
      this.toolNamesByRound.push(tools.map((tool) => tool.function.name));

      if (this.toolNamesByRound.length === 1) {
        return {
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            logprobs: null,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: toolCalls,
            },
          }],
        } as OpenAI.Chat.Completions.ChatCompletion;
      }

      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: '已完成代码检索',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  const llm = new FakeLLM();
  const orchestrator = new Orchestrator(
    llm as never,
    {
      getDefinitions() {
        return [
          {
            type: 'function',
            function: {
              name: 'search_code',
              description: '搜索代码',
              parameters: { type: 'object', properties: {} },
            },
          },
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: '读取文件',
              parameters: { type: 'object', properties: {} },
            },
          },
          {
            type: 'function',
            function: {
              name: 'azure_devops',
              description: '查询 ADO',
              parameters: { type: 'object', properties: {} },
            },
          },
        ];
      },
      async execute() {
        throw new Error('不应执行外部工具');
      },
    } as never,
    {
      llm: { contextWindow: 32768 },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
    createSkillRegistry([{
      name: 'code-lookup',
      description: '查代码',
      allowedTools: 'search_code read_file',
      instructions: '- 先结论后证据',
    }]),
  );

  const reply = await orchestrator.handle('user-1', 'alice', '@RocketBot 帮我处理这个问题', []);

  assert.equal(reply, '已激活 skill: code-lookup\n\n已完成代码检索');
  assert.deepEqual(llm.toolNamesByRound[0], ['activate_skill', 'search_code', 'read_file', 'azure_devops']);
  assert.deepEqual(llm.toolNamesByRound[1], ['activate_skill', 'search_code', 'read_file']);
});

test('Orchestrator 在深度模式下应切换深度模型并使用深度提示', async () => {
  class FakeLLM {
    public readonly models: Array<string | undefined> = [];
    public readonly systemPrompts: string[] = [];

    async chat(
      messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      _tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
      options: { model?: string } = {},
    ) {
      this.models.push(options.model);
      this.systemPrompts.push(String(messages[0]?.content ?? ''));

      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: '深度分析完成',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  const trace: OrchestratorTrace = {
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 0,
    status: 'success',
  };
  const llm = new FakeLLM();
  const orchestrator = new Orchestrator(
    llm as never,
    {
      getDefinitions() {
        return [];
      },
    } as never,
    {
      llm: {
        model: 'gpt-5.5',
        deepModel: 'gpt-5.5-pro',
        contextWindow: 32768,
      },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
    createSkillRegistry([]),
  );

  const reply = await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot |deep 帮我分析这个问题',
    [],
    [],
    undefined,
    { trace },
  );

  assert.equal(reply, '深度分析完成');
  assert.deepEqual(llm.models, ['gpt-5.5-pro']);
  assert.match(llm.systemPrompts[0], /## 深度模式/);
  assert.match(llm.systemPrompts[0], /当前使用深度模式，模型为 gpt-5\.5-pro/);
  assert.match(llm.systemPrompts[0], /约 30 分钟后自动退出/);
  assert.equal(trace.modelMode, 'deep');
  assert.equal(trace.modelUsed, 'gpt-5.5-pro');
});

test('Orchestrator 不应根据普通内容关键词自动进入深度模式', async () => {
  class FakeLLM {
    public readonly models: Array<string | undefined> = [];
    public readonly systemPrompts: string[] = [];

    async chat(
      messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      _tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
      options: { model?: string } = {},
    ) {
      this.models.push(options.model);
      this.systemPrompts.push(String(messages[0]?.content ?? ''));

      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: '普通分析完成',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  const trace: OrchestratorTrace = {
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 0,
    status: 'success',
  };
  const llm = new FakeLLM();
  const orchestrator = new Orchestrator(
    llm as never,
    {
      getDefinitions() {
        return [];
      },
    } as never,
    {
      llm: {
        model: 'gpt-5.5',
        deepModel: 'gpt-5.5-pro',
        contextWindow: 32768,
      },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
    createSkillRegistry([]),
  );

  const reply = await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot 帮我深入分析这个复杂问题',
    [],
    [],
    undefined,
    { trace },
  );

  assert.equal(reply, '普通分析完成');
  assert.deepEqual(llm.models, [undefined]);
  assert.doesNotMatch(llm.systemPrompts[0], /## 深度模式/);
  assert.equal(trace.modelMode, 'normal');
  assert.equal(trace.modelUsed, undefined);
});

test('Orchestrator 应支持进入和退出会话级深度模式', async () => {
  class FakeLLM {
    public readonly models: Array<string | undefined> = [];
    public readonly systemPrompts: string[] = [];

    async chat(
      messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      _tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
      options: { model?: string } = {},
    ) {
      this.models.push(options.model);
      this.systemPrompts.push(String(messages[0]?.content ?? ''));

      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: '处理完成',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  const llm = new FakeLLM();
  const orchestrator = new Orchestrator(
    llm as never,
    {
      getDefinitions() {
        return [];
      },
    } as never,
    {
      llm: {
        model: 'gpt-5.5',
        deepModel: 'gpt-5.5-pro',
        contextWindow: 32768,
      },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
    createSkillRegistry([]),
  );
  const requestContext = {
    roomId: 'GENERAL',
    roomType: 'c',
    triggerMessageId: 'msg-1',
    timestamp: new Date('2026-04-26T08:00:00.000Z'),
  } as const;

  const enterTrace: OrchestratorTrace = {
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 0,
    status: 'success',
  };
  const enterReply = await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot /deep',
    [],
    [],
    requestContext,
    { trace: enterTrace },
  );

  assert.match(enterReply, /已进入深度模式/);
  assert.match(enterReply, /30 分钟后会自动退出/);
  assert.match(enterReply, /\|normal/);
  assert.match(enterReply, /\|deep off/);
  assert.doesNotMatch(enterReply, /5 次/);
  assert.doesNotMatch(enterReply, /说“退出深度模式”/);
  assert.equal(enterTrace.modelMode, 'deep');
  assert.equal(enterTrace.modelUsed, 'gpt-5.5-pro');
  assert.equal(llm.models.length, 0);

  const deepTrace: OrchestratorTrace = {
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 0,
    status: 'success',
  };
  await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot 普通问题',
    [],
    [],
    requestContext,
    { trace: deepTrace },
  );
  assert.deepEqual(llm.models, ['gpt-5.5-pro']);
  assert.match(llm.systemPrompts[0], /当前使用深度模式，模型为 gpt-5\.5-pro/);
  assert.match(llm.systemPrompts[0], /约 30 分钟后自动退出/);
  assert.match(llm.systemPrompts[0], /\|normal/);
  assert.match(llm.systemPrompts[0], /\|deep off/);
  assert.doesNotMatch(llm.systemPrompts[0], /说“退出深度模式”/);
  assert.equal(deepTrace.modelMode, 'deep');
  assert.equal(deepTrace.modelUsed, 'gpt-5.5-pro');

  const exitReply = await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot /normal',
    [],
    [],
    requestContext,
  );
  assert.match(exitReply, /已退出深度模式/);
  assert.deepEqual(llm.models, ['gpt-5.5-pro']);

  const normalTrace: OrchestratorTrace = {
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 0,
    status: 'success',
  };
  await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot 普通问题',
    [],
    [],
    requestContext,
    { trace: normalTrace },
  );
  assert.deepEqual(llm.models, ['gpt-5.5-pro', undefined]);
  assert.equal(normalTrace.modelMode, 'normal');
  assert.equal(normalTrace.modelUsed, undefined);
});

test('Orchestrator 应支持模型自触发多个 skill 并记录正确来源', async () => {
  const scenarios = [
    {
      skillName: 'ado-lookup',
      description: '查 ADO',
      allowedTools: 'azure_devops',
      toolName: 'azure_devops',
      toolResult: { summary: '找到 PR #42' },
      finalReply: 'ADO 结果已整理',
      prompt: '@RocketBot 帮我看一下最近失败的 pipeline',
      expectedToolNamesByRound: [
        ['activate_skill', 'search_code', 'read_file', 'azure_devops'],
        ['activate_skill', 'azure_devops'],
      ],
    },
    {
      skillName: 'pr-review',
      description: '审查 PR',
      allowedTools: 'azure_devops read_file',
      toolName: 'azure_devops',
      toolResult: { summary: 'PR 风险点已列出' },
      finalReply: 'PR 审查已完成',
      prompt: '@RocketBot 帮我审查一下 PR 123',
      expectedToolNamesByRound: [
        ['activate_skill', 'search_code', 'read_file', 'azure_devops'],
        ['activate_skill', 'read_file', 'azure_devops'],
      ],
    },
    {
      skillName: 'artifact-writer',
      description: '生成制品',
      allowedTools: 'read_file',
      toolName: 'read_file',
      toolResult: { content: '原始材料' },
      finalReply: '已整理成可直接发送的文案',
      prompt: '@RocketBot 帮我整理成对外同步文案',
      expectedToolNamesByRound: [
        ['activate_skill', 'search_code', 'read_file', 'azure_devops'],
        ['activate_skill', 'read_file'],
      ],
    },
  ] as const;

  for (const scenario of scenarios) {
    class FakeLLM {
      public readonly toolNamesByRound: string[][] = [];
      private round = 0;

      async chat(
        _messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
      ) {
        this.toolNamesByRound.push(tools.map((tool) => tool.function.name));
        this.round += 1;

        if (this.round === 1) {
          return {
            choices: [{
              index: 0,
              finish_reason: 'tool_calls',
              logprobs: null,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `call_activate_${scenario.skillName}`,
                    type: 'function',
                    function: {
                      name: 'activate_skill',
                      arguments: JSON.stringify({ name: scenario.skillName }),
                    },
                  },
                  {
                    id: `call_tool_${scenario.toolName}`,
                    type: 'function',
                    function: {
                      name: scenario.toolName,
                      arguments: JSON.stringify({ query: scenario.skillName }),
                    },
                  },
                ],
              },
            }],
          } as OpenAI.Chat.Completions.ChatCompletion;
        }

        return {
          choices: [{
            index: 0,
            finish_reason: 'stop',
            logprobs: null,
            message: {
              role: 'assistant',
              content: scenario.finalReply,
            },
          }],
        } as OpenAI.Chat.Completions.ChatCompletion;
      }
    }

    const trace: OrchestratorTrace = {
      activeSkills: [],
      skillSources: {},
      usedTools: [],
      rounds: 0,
      status: 'success',
    };

    const llm = new FakeLLM();
    const orchestrator = new Orchestrator(
      llm as never,
      {
        getDefinitions() {
          return [
            {
              type: 'function',
              function: {
                name: 'search_code',
                description: '搜索代码',
                parameters: { type: 'object', properties: {} },
              },
            },
            {
              type: 'function',
              function: {
                name: 'read_file',
                description: '读取文件',
                parameters: { type: 'object', properties: {} },
              },
            },
            {
              type: 'function',
              function: {
                name: 'azure_devops',
                description: '查询 ADO',
                parameters: { type: 'object', properties: {} },
              },
            },
          ];
        },
        async execute(name: string) {
          assert.equal(name, scenario.toolName);
          return {
            success: true,
            data: scenario.toolResult,
          };
        },
      } as never,
      {
        llm: { contextWindow: 32768 },
        rocketchat: { botUsername: 'RocketBot' },
      } as never,
      createLogger() as never,
      createSkillRegistry([{
        name: scenario.skillName,
        description: scenario.description,
        allowedTools: scenario.allowedTools,
        instructions: '- 按 skill 说明处理',
      }]),
    );

    const reply = await orchestrator.handle(
      'user-1',
      'alice',
      scenario.prompt,
      [],
      [],
      undefined,
      { trace },
    );

    assert.equal(
      reply,
      `已激活 skill: ${scenario.skillName}\n已使用工具: ${scenario.toolName}\n\n${scenario.finalReply}`,
    );
    assert.deepEqual(llm.toolNamesByRound, scenario.expectedToolNamesByRound);
    assert.deepEqual(trace, {
      activeSkills: [scenario.skillName],
      skillSources: {
        [scenario.skillName]: 'model',
      },
      usedTools: [scenario.toolName],
      rounds: 2,
      status: 'success',
      finishReason: 'reply',
      error: undefined,
      webSearchUsed: false,
      modelMode: 'normal',
    });
  }
});

test('Orchestrator 在聊天中显式使用 $skill 时应预激活 skill 并清理消息', async () => {
  class FakeLLM {
    public readonly toolNamesByRound: string[][] = [];
    public readonly calls: OpenAI.Chat.Completions.ChatCompletionMessageParam[][] = [];

    async chat(
      messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
    ) {
      this.calls.push(messages);
      this.toolNamesByRound.push(tools.map((tool) => tool.function.name));

      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: '已按代码检索模式处理',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  const llm = new FakeLLM();
  const orchestrator = new Orchestrator(
    llm as never,
    {
      getDefinitions() {
        return [
          {
            type: 'function',
            function: {
              name: 'search_code',
              description: '搜索代码',
              parameters: { type: 'object', properties: {} },
            },
          },
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: '读取文件',
              parameters: { type: 'object', properties: {} },
            },
          },
          {
            type: 'function',
            function: {
              name: 'azure_devops',
              description: '查询 ADO',
              parameters: { type: 'object', properties: {} },
            },
          },
        ];
      },
      async execute() {
        throw new Error('不应执行外部工具');
      },
    } as never,
    {
      llm: { contextWindow: 32768 },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
    createSkillRegistry([{
      name: 'code-lookup',
      description: '查代码',
      allowedTools: 'search_code read_file',
      instructions: '- 先结论后证据',
    }]),
  );

  const reply = await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot $code-lookup 看下 src/index.ts 在做什么',
    [],
  );

  assert.equal(reply, '已激活 skill: code-lookup\n\n已按代码检索模式处理');
  assert.deepEqual(llm.toolNamesByRound[0], ['activate_skill', 'search_code', 'read_file']);

  const firstCall = llm.calls[0];
  const lastUserMessage = firstCall[firstCall.length - 1] as OpenAI.Chat.Completions.ChatCompletionUserMessageParam;
  assert.equal(lastUserMessage.role, 'user');
  assert.equal(lastUserMessage.content, '@alice: @RocketBot 看下 src/index.ts 在做什么');
});

test('Orchestrator 在显式请求已安装但未启用的 skill 时应直接提示', async () => {
  const registry = createSkillRegistry([{
    name: 'code-lookup',
    description: '查代码',
    allowedTools: 'search_code read_file',
    instructions: '- 先结论后证据',
  }]);
  registry.setEnabled('code-lookup', false);

  const llm = {
    async chat() {
      throw new Error('不应调用 LLM');
    },
  };

  const orchestrator = new Orchestrator(
    llm as never,
    { getDefinitions() { return []; } } as never,
    {
      llm: { contextWindow: 32768 },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
    registry,
  );

  const reply = await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot $code-lookup 看下 src/index.ts',
    [],
  );

  assert.match(reply, /已安装但未启用/);
  assert.match(reply, /code-lookup/);
});

test('Orchestrator 遇到 /skills 时应直接返回 skill 帮助而不调用 LLM', async () => {
  const llm = {
    async chat() {
      throw new Error('不应调用 LLM');
    },
  };

  const orchestrator = new Orchestrator(
    llm as never,
    { getDefinitions() { return []; } } as never,
    {
      llm: { contextWindow: 32768 },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
    createSkillRegistry([
      {
        name: 'code-lookup',
        description: '查代码',
        allowedTools: 'search_code read_file',
        instructions: '- 先结论后证据',
      },
      {
        name: 'ado-lookup',
        description: '查 ADO',
        allowedTools: 'azure_devops',
        instructions: '- 先查 ADO',
      },
    ]),
  );

  const reply = await orchestrator.handle('user-1', 'alice', '@RocketBot |skills', []);

  assert.match(reply, /当前已启用的 skills/);
  assert.match(reply, /code-lookup/);
  assert.match(reply, /\$code-lookup/);
  assert.match(reply, /用 code-lookup/);
});

test('Orchestrator 对普通问题不应在服务端预判推荐 skill', async () => {
  let called = false;
  const llm = {
    async chat() {
      called = true;
      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: '我先直接回答这个问题',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    },
  };

  const orchestrator = new Orchestrator(
    llm as never,
    { getDefinitions() { return []; } } as never,
    {
      llm: { contextWindow: 32768 },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
    createSkillRegistry([{
      name: 'code-lookup',
      description: '查代码',
      allowedTools: 'search_code read_file',
      instructions: '- 先结论后证据',
    }]),
  );

  const reply = await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot 看下 src/index.ts 在做什么',
    [],
  );

  assert.equal(called, true);
  assert.equal(reply, '我先直接回答这个问题');
});

test('Orchestrator 对公开实时新闻请求应走 Responses 联网快路径', async () => {
  class FakeLLM {
    public readonly calls: Array<{
      messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
      tools: OpenAI.Chat.Completions.ChatCompletionTool[];
      options: Record<string, unknown> | undefined;
    }> = [];

    async chat(
      messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
      options?: Record<string, unknown>,
    ) {
      this.calls.push({ messages, tools, options });
      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: '1. OpenAI 发布更新：<https://openai.com/news/>',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  const llm = new FakeLLM();
  let definitionsCalled = false;
  const orchestrator = new Orchestrator(
    llm as never,
    {
      getDefinitions() {
        definitionsCalled = true;
        return [];
      },
    } as never,
    {
      llm: {
        model: 'gpt-5.5',
        apiMode: 'chat_completions',
        contextWindow: 32768,
        nativeWebSearch: {
          enabled: true,
          tools: [{ type: 'web_search' }],
          requestBody: { tool_choice: 'auto' },
        },
      },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
    createSkillRegistry([]),
  );
  const trace: OrchestratorTrace = {
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 0,
    status: 'success',
  };

  const reply = await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot 24小时内的AI新闻',
    [],
    [],
    undefined,
    { trace },
  );

  assert.equal(reply, '1. OpenAI 发布更新：<https://openai.com/news/>');
  assert.equal(definitionsCalled, false);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(llm.calls[0].tools, []);
  assert.equal(llm.calls[0].options?.apiMode, 'responses');
  assert.match(String(llm.calls[0].messages[0].content), /公开互联网实时信息查询/);
  assert.deepEqual(trace, {
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 1,
    status: 'success',
    finishReason: 'web_search_fast_path',
    error: undefined,
    webSearchUsed: true,
    modelMode: 'normal',
  });
});

test('Orchestrator 不应把项目内版本问题误判为公网实时查询', async () => {
  class FakeLLM {
    public options: Record<string, unknown> | undefined;

    async chat(
      _messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      _tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
      options?: Record<string, unknown>,
    ) {
      this.options = options;
      return {
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: '按当前版本边界回答。',
          },
        }],
      } as OpenAI.Chat.Completions.ChatCompletion;
    }
  }

  const llm = new FakeLLM();
  let definitionsCalled = false;
  const orchestrator = new Orchestrator(
    llm as never,
    {
      getDefinitions() {
        definitionsCalled = true;
        return [];
      },
    } as never,
    {
      llm: {
        model: 'gpt-5.5',
        apiMode: 'chat_completions',
        contextWindow: 32768,
        nativeWebSearch: {
          enabled: true,
          tools: [{ type: 'web_search' }],
          requestBody: { tool_choice: 'auto' },
        },
      },
      rocketchat: { botUsername: 'RocketBot' },
    } as never,
    createLogger() as never,
    createSkillRegistry([]),
  );
  const trace: OrchestratorTrace = {
    activeSkills: [],
    skillSources: {},
    usedTools: [],
    rounds: 0,
    status: 'success',
  };

  const reply = await orchestrator.handle(
    'user-1',
    'alice',
    '@RocketBot 这个版本支持 main 分支吗',
    [],
    [],
    undefined,
    { trace },
  );

  assert.equal(reply, '按当前版本边界回答。');
  assert.equal(definitionsCalled, true);
  assert.equal(llm.options?.apiMode, undefined);
  assert.equal(trace.finishReason, 'reply');
});

test('buildSystemPrompt 在启用模型原生联网时应给出明确边界', () => {
  const prompt = buildSystemPrompt({
    llm: {
      nativeWebSearch: {
        enabled: true,
        instruction: '优先参考官方来源',
      },
    },
  } as never);

  assert.match(prompt, /模型原生联网搜索能力/);
  assert.match(prompt, /不要为了联网而调用 exec_codex/);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /room_history/);
  assert.match(prompt, /优先参考官方来源/);
  assert.match(prompt, /sources/);
  assert.match(prompt, /默认像同事一样自然回复/);
  assert.doesNotMatch(prompt, /结尾显式附上“来源”小节/);
});

test('buildSystemPrompt 应明确 Azure DevOps Server 仓库只读边界', () => {
  const prompt = buildSystemPrompt({
    llm: {},
    rocketchat: { botUsername: 'RocketBot' },
  } as never);

  assert.match(prompt, /Azure DevOps Server 代码仓库只读/);
  assert.match(prompt, /默认读取 main/);
  assert.match(prompt, /review 请求可以读取链接引用的分支或提交/);
  assert.match(prompt, /不要修改代码、commit、push、创建或更新 PR/);
});

test('buildSystemPrompt 在激活 artifact skill 后应包含 skill 说明', () => {
  const registry = createSkillRegistry([{
    name: 'artifact-writer',
    description: '生成制品',
    allowedTools: 'search_code read_file',
    instructions: '- 当前请求需要产出一个可复制、可转发、可提交的制品\n- 如果工具返回了 sources，结尾显式附上“来源”小节\n- 本地代码来源优先写成 文件路径:行号',
  }]);
  const prompt = buildSystemPrompt({
    llm: {},
    rocketchat: { botUsername: 'RocketBot' },
  } as never, {
    availableSkills: registry.list(),
    activeSkills: [registry.get('artifact-writer')!],
  });

  assert.match(prompt, /Skills 机制/);
  assert.match(prompt, /artifact-writer/);
  assert.match(prompt, /可复制、可转发、可提交的制品/);
  assert.match(prompt, /结尾显式附上“来源”小节/);
  assert.match(prompt, /文件路径:行号/);
});

test('resolveRequestedSkills 应识别显式 skill 与系统任务 skill', () => {
  const registry = createSkillRegistry([
    {
      name: 'artifact-writer',
      description: '生成制品',
      instructions: '- 输出制品',
    },
    {
      name: 'scheduled-report',
      description: '定时播报',
      instructions: '- 输出播报',
    },
    {
      name: 'code-lookup',
      description: '查代码',
      instructions: '- 查代码',
    },
  ]);

  const explicit = resolveRequestedSkills('user-1', '@RocketBot $code-lookup 看下 src/index.ts', registry);
  assert.deepEqual(explicit.skills.map((skill) => skill.name), ['code-lookup']);
  assert.deepEqual(explicit.skillSources, { 'code-lookup': 'explicit' });
  assert.equal(explicit.cleanedMessage, '@RocketBot 看下 src/index.ts');

  const natural = resolveRequestedSkills('user-1', '@RocketBot 用 code-lookup 看下 src/index.ts', registry);
  assert.deepEqual(natural.skills.map((skill) => skill.name), ['code-lookup']);
  assert.deepEqual(natural.skillSources, { 'code-lookup': 'explicit' });
  assert.equal(natural.cleanedMessage, '@RocketBot 看下 src/index.ts');

  const artifact = resolveRequestedSkills('user-1', '@RocketBot 帮我整理成缺陷单描述', registry);
  assert.deepEqual(artifact.skills, []);
  assert.deepEqual(artifact.skillSources, {});

  const scheduled = resolveRequestedSkills('scheduler', '执行定时任务: 检查主干构建状态', registry);
  assert.deepEqual(scheduled.skills.map((skill) => skill.name), ['scheduled-report']);
  assert.deepEqual(scheduled.skillSources, { 'scheduled-report': 'system' });

  const normal = resolveRequestedSkills('user-1', '@RocketBot 看下 src/index.ts 在做什么', registry);
  assert.deepEqual(normal.skills, []);
  assert.deepEqual(normal.skillSources, {});
});
