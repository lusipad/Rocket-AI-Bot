import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import { buildSystemPrompt, Orchestrator } from '../src/agent/orchestrator.ts';
import { ContextBuilder } from '../src/llm/context.ts';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
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

  assert.equal(reply, '最新 PR 是 #1');
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
  assert.match(prompt, /优先参考官方来源/);
});
