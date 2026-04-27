import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import { LLMClient } from '../src/llm/client.ts';

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

test('LLMClient 应在启用原生联网时合并 provider tools 和 requestBody', async () => {
  const llm = new LLMClient(
    {
      llm: {
        endpoint: 'https://example.com/v1',
        apiKey: 'test-key',
        model: 'gpt-5.4',
        contextWindow: 32768,
        circuitBreaker: {
          failureThreshold: 3,
          recoveryTimeout: 1000,
        },
        nativeWebSearch: {
          enabled: true,
          tools: [{
            type: 'web_search_preview',
            search_context_size: 'medium',
          }],
          requestBody: {
            tool_choice: 'auto',
            web_search_options: {
              user_location: {
                type: 'approximate',
                country: 'CN',
              },
            },
          },
        },
        extraBody: {
          frequency_penalty: 0,
        },
      },
    } as never,
    createLogger() as never,
  );

  let capturedRequest: Record<string, unknown> | null = null;
  (llm as any).client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          capturedRequest = request;
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
          };
        },
      },
    },
  };

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [{
    type: 'function',
    function: {
      name: 'search_code',
      description: '搜索代码',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  }];

  await llm.chat([
    { role: 'user', content: '帮我查一下今天的发布说明' },
  ], tools);

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.model, 'gpt-5.4');
  assert.equal(capturedRequest.tool_choice, 'auto');
  assert.equal(capturedRequest.frequency_penalty, 0);
  assert.deepEqual(capturedRequest.web_search_options, {
    user_location: {
      type: 'approximate',
      country: 'CN',
    },
  });
  assert.deepEqual(capturedRequest.tools, [
    tools[0],
    {
      type: 'web_search_preview',
      search_context_size: 'medium',
    },
  ]);
});

test('LLMClient 应支持单次请求覆盖模型', async () => {
  const llm = new LLMClient(
    {
      llm: {
        endpoint: 'https://example.com/v1',
        apiKey: 'test-key',
        model: 'gpt-5.5',
        deepModel: 'gpt-5.5-pro',
        contextWindow: 32768,
        circuitBreaker: {
          failureThreshold: 3,
          recoveryTimeout: 1000,
        },
      },
    } as never,
    createLogger() as never,
  );

  let capturedRequest: Record<string, unknown> | null = null;
  (llm as any).client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          capturedRequest = request;
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
          };
        },
      },
    },
  };

  await llm.chat([
    { role: 'user', content: '深入分析' },
  ], [], { model: 'gpt-5.5-pro' });

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.model, 'gpt-5.5-pro');
});

test('LLMClient 在 responses 模式下应构造 Responses 请求并归一化函数调用', async () => {
  const llm = new LLMClient(
    {
      llm: {
        endpoint: 'https://example.com/v1',
        apiKey: 'test-key',
        model: 'chatgpt-4o-latest',
        apiMode: 'responses',
        contextWindow: 32768,
        circuitBreaker: {
          failureThreshold: 3,
          recoveryTimeout: 1000,
        },
        nativeWebSearch: {
          enabled: true,
          tools: [{
            type: 'web_search',
          }],
          requestBody: {
            tool_choice: 'auto',
          },
        },
        extraBody: {
          store: false,
        },
      },
    } as never,
    createLogger() as never,
  );

  let capturedRequest: Record<string, unknown> | null = null;
  (llm as any).client = {
    responses: {
      create: async (request: Record<string, unknown>) => {
        capturedRequest = request;
        return {
          id: 'resp_123',
          model: 'chatgpt-4o-latest',
          output_text: '',
          output: [{
            type: 'function_call',
            name: 'search_code',
            arguments: '{"query":"foo"}',
            call_id: 'call_123',
          }],
        };
      },
    },
  };

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [{
    type: 'function',
    function: {
      name: 'search_code',
      description: '搜索代码',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      },
    },
  }];

  const completion = await llm.chat([
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: '帮我查代码' },
  ], tools);

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.model, 'chatgpt-4o-latest');
  assert.equal('tool_choice' in capturedRequest, false);
  assert.equal(capturedRequest.store, false);
  assert.deepEqual(capturedRequest.tools, [
    {
      type: 'function',
      name: 'search_code',
      description: '搜索代码',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      },
      strict: false,
    },
    {
      type: 'web_search',
    },
  ]);
  assert.deepEqual(capturedRequest.input, [
    {
      role: 'system',
      content: [{ type: 'input_text', text: 'system prompt' }],
    },
    {
      role: 'user',
      content: [{ type: 'input_text', text: '帮我查代码' }],
    },
  ]);

  assert.deepEqual(completion.choices[0].message.tool_calls, [{
    id: 'call_123',
    type: 'function',
    function: {
      name: 'search_code',
      arguments: '{"query":"foo"}',
    },
  }]);
  assert.equal(completion.choices[0].finish_reason, 'tool_calls');
});

test('LLMClient 应支持单次请求覆盖到 Responses 模式', async () => {
  const llm = new LLMClient(
    {
      llm: {
        endpoint: 'https://example.com/v1',
        apiKey: 'test-key',
        model: 'gpt-5.5',
        apiMode: 'chat_completions',
        contextWindow: 32768,
        circuitBreaker: {
          failureThreshold: 3,
          recoveryTimeout: 1000,
        },
        nativeWebSearch: {
          enabled: true,
          tools: [{ type: 'web_search' }],
          requestBody: { tool_choice: 'auto' },
        },
        extraBody: {},
      },
    } as never,
    createLogger() as never,
  );

  let capturedRequest: Record<string, unknown> | null = null;
  let chatCalled = false;
  (llm as any).client = {
    chat: {
      completions: {
        create: async () => {
          chatCalled = true;
          throw new Error('chat should not be called');
        },
      },
    },
    responses: {
      create: async (request: Record<string, unknown>) => {
        capturedRequest = request;
        return {
          id: 'resp_override',
          model: 'gpt-5.5',
          output_text: 'ok',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          }],
        };
      },
    },
  };

  const completion = await llm.chat([
    { role: 'user', content: '查最新新闻' },
  ], [], { apiMode: 'responses' });

  assert.equal(chatCalled, false);
  assert.ok(capturedRequest);
  assert.equal(capturedRequest.model, 'gpt-5.5');
  assert.equal('tool_choice' in capturedRequest, false);
  assert.equal(completion.choices[0].message.content, 'ok');
});

test('LLMClient 在 responses 模式下应转换多模态输入和工具回放消息', async () => {
  const llm = new LLMClient(
    {
      llm: {
        endpoint: 'https://example.com/v1',
        apiKey: 'test-key',
        model: 'chatgpt-4o-latest',
        apiMode: 'responses',
        contextWindow: 32768,
        circuitBreaker: {
          failureThreshold: 3,
          recoveryTimeout: 1000,
        },
        nativeWebSearch: {
          enabled: false,
        },
        extraBody: {},
      },
    } as never,
    createLogger() as never,
  );

  let capturedRequest: Record<string, unknown> | null = null;
  (llm as any).client = {
    responses: {
      create: async (request: Record<string, unknown>) => {
        capturedRequest = request;
        return {
          id: 'resp_456',
          model: 'chatgpt-4o-latest',
          output_text: '我看到图片了',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{
              type: 'output_text',
              text: '我看到图片了',
            }],
          }],
        };
      },
    },
  };

  await llm.chat([
    { role: 'assistant', content: null, tool_calls: [{
      id: 'call_9',
      type: 'function',
      function: {
        name: 'search_code',
        arguments: '{"query":"bar"}',
      },
    }] },
    {
      role: 'tool',
      tool_call_id: 'call_9',
      content: '{"matches":[]}',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'auto' } },
      ],
    },
  ] as OpenAI.Chat.Completions.ChatCompletionMessageParam[]);

  assert.ok(capturedRequest);
  assert.deepEqual(capturedRequest.input, [
    {
      type: 'function_call',
      name: 'search_code',
      arguments: '{"query":"bar"}',
      call_id: 'call_9',
    },
    {
      type: 'function_call_output',
      call_id: 'call_9',
      output: '{"matches":[]}',
    },
    {
      role: 'user',
      content: [
        { type: 'input_text', text: '看这张图' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
      ],
    },
  ]);
});

test('LLMClient 遇到瞬时 502 错误时应自动重试', async () => {
  const llm = new LLMClient(
    {
      llm: {
        endpoint: 'https://example.com/v1',
        apiKey: 'test-key',
        model: 'chatgpt-4o-latest',
        apiMode: 'responses',
        contextWindow: 32768,
        circuitBreaker: {
          failureThreshold: 3,
          recoveryTimeout: 1000,
        },
        nativeWebSearch: {
          enabled: true,
          tools: [{ type: 'web_search' }],
          requestBody: { tool_choice: 'auto' },
        },
        extraBody: {},
      },
    } as never,
    createLogger() as never,
  );

  let attempts = 0;
  (llm as any).client = {
    responses: {
      create: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('502 Upstream request failed');
        }

        return {
          id: 'resp_retry',
          model: 'chatgpt-4o-latest',
          output_text: 'ok',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          }],
        };
      },
    },
  };

  const completion = await llm.chat([
    { role: 'user', content: '只回复ok' },
  ]);

  assert.equal(attempts, 3);
  assert.equal(completion.choices[0].message.content, 'ok');
});
