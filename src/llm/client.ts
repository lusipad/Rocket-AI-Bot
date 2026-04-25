import OpenAI from 'openai';
import type { Logger } from '../utils/logger.js';
import type { Config } from '../config/schema.js';
import { CircuitBreaker } from './circuit-breaker.js';

export type ToolDef = OpenAI.Chat.Completions.ChatCompletionTool;
export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type Choice = OpenAI.Chat.Completions.ChatCompletion.Choice;
export type Completion = OpenAI.Chat.Completions.ChatCompletion;
type ProviderTool = Record<string, unknown>;
type ResponseInputItem = Record<string, unknown>;

const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BACKOFF_MS = 800;

export class LLMClient {
  private client: OpenAI;
  private config: Config;
  private logger: Logger;
  private model: string;
  private breaker: CircuitBreaker;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.model = config.llm.model;

    this.client = new OpenAI({
      baseURL: config.llm.endpoint,
      apiKey: config.llm.apiKey,
    });

    const cb = config.llm.circuitBreaker;
    this.breaker = new CircuitBreaker(cb.failureThreshold, cb.recoveryTimeout);
  }

  get circuitBreaker(): CircuitBreaker {
    return this.breaker;
  }

  async chat(
    messages: ChatMessage[],
    tools?: ToolDef[],
  ): Promise<Completion> {
    if (this.breaker.isOpen) {
      throw new CircuitBreakerOpenError();
    }

    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      try {
        const response = this.config.llm.apiMode === 'responses'
          ? await this.chatWithResponses(messages, tools)
          : await this.chatWithChatCompletions(messages, tools);

        this.breaker.recordSuccess();
        return response;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const canRetry = attempt < MAX_TRANSIENT_RETRIES && isTransientLLMError(err);

        if (canRetry) {
          const delayMs = RETRY_BACKOFF_MS * (attempt + 1);
          this.logger.warn('LLM 调用失败，准备重试', { attempt: attempt + 1, delayMs, error: msg });
          await sleep(delayMs);
          continue;
        }

        this.breaker.recordFailure();
        this.logger.error('LLM 调用失败', { error: msg });
        throw err;
      }
    }

    throw new Error('LLM 调用失败');
  }

  getModel(): string {
    return this.model;
  }

  private async chatWithChatCompletions(
    messages: ChatMessage[],
    tools?: ToolDef[],
  ): Promise<Completion> {
    return this.client.chat.completions.create(
      this.buildChatCompletionsRequest(messages, tools) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    );
  }

  private async chatWithResponses(
    messages: ChatMessage[],
    tools?: ToolDef[],
  ): Promise<Completion> {
    const response = await this.client.responses.create(
      this.buildResponsesRequest(messages, tools) as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming,
    );

    return this.normalizeResponsesCompletion(response);
  }

  private buildChatCompletionsRequest(
    messages: ChatMessage[],
    tools?: ToolDef[],
  ): Record<string, unknown> {
    const nativeWebSearch = this.config.llm.nativeWebSearch ?? {
      enabled: false,
      tools: [],
      requestBody: {},
    };
    const nativeWebSearchBody = nativeWebSearch.enabled
      ? nativeWebSearch.requestBody ?? {}
      : {};

    const request: Record<string, unknown> = {
      ...(this.config.llm.extraBody ?? {}),
      ...nativeWebSearchBody,
      model: this.model,
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    };

    const requestTools = this.mergeChatCompletionTools(tools);
    if (requestTools.length > 0) {
      request.tools = requestTools;
    }

    return request;
  }

  private buildResponsesRequest(
    messages: ChatMessage[],
    tools?: ToolDef[],
  ): Record<string, unknown> {
    const nativeWebSearch = this.config.llm.nativeWebSearch ?? {
      enabled: false,
      tools: [],
      requestBody: {},
    };
    const nativeWebSearchBody = nativeWebSearch.enabled
      ? nativeWebSearch.requestBody ?? {}
      : {};

    const request: Record<string, unknown> = {
      ...(this.config.llm.extraBody ?? {}),
      ...nativeWebSearchBody,
      model: this.model,
      input: this.buildResponseInput(messages),
      temperature: 0.7,
      max_output_tokens: 4096,
    };

    const requestTools = this.buildResponseTools(tools);
    if (requestTools.length > 0) {
      request.tools = requestTools;
    }

    return request;
  }

  private mergeChatCompletionTools(tools?: ToolDef[]): Array<ToolDef | ProviderTool> {
    const mergedTools: Array<ToolDef | ProviderTool> = [...(tools ?? [])];
    const nativeWebSearch = this.config.llm.nativeWebSearch ?? {
      enabled: false,
      tools: [],
    };

    if (!nativeWebSearch.enabled) {
      return mergedTools;
    }

    for (const tool of nativeWebSearch.tools ?? []) {
      mergedTools.push(tool);
    }

    return mergedTools;
  }

  private buildResponseTools(tools?: ToolDef[]): ProviderTool[] {
    const responseTools: ProviderTool[] = [];
    for (const tool of tools ?? []) {
      if (tool.type === 'function') {
        responseTools.push({
          type: 'function',
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
          strict: false,
        });
        continue;
      }

      responseTools.push(tool as unknown as ProviderTool);
    }

    const nativeWebSearch = this.config.llm.nativeWebSearch ?? {
      enabled: false,
      tools: [],
    };
    if (nativeWebSearch.enabled) {
      responseTools.push(...(nativeWebSearch.tools ?? []));
    }

    return responseTools;
  }

  private buildResponseInput(messages: ChatMessage[]): ResponseInputItem[] {
    const input: ResponseInputItem[] = [];

    for (const message of messages) {
      const item = message as ChatMessage & {
        tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
        tool_call_id?: string;
      };

      if (item.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: item.tool_call_id,
          output: typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
        });
        continue;
      }

      if (item.role === 'assistant' && item.tool_calls?.length) {
        const assistantContent = this.toResponseContent(item.content);
        if (assistantContent.length > 0) {
          input.push({
            role: 'assistant',
            content: assistantContent,
          });
        }

        for (const toolCall of item.tool_calls) {
          input.push({
            type: 'function_call',
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
            call_id: toolCall.id,
          });
        }
        continue;
      }

      const content = this.toResponseContent(item.content);
      if (content.length === 0) {
        continue;
      }

      input.push({
        role: item.role,
        content,
      });
    }

    return input;
  }

  private toResponseContent(
    content: string | readonly unknown[] | null | undefined,
  ): ResponseInputItem[] {
    if (!content) {
      return [];
    }

    if (typeof content === 'string') {
      return [{ type: 'input_text', text: content }];
    }

    const parts: ResponseInputItem[] = [];
    for (const rawPart of content) {
      const part = rawPart as {
        type?: string;
        text?: string;
        refusal?: string;
        image_url?: { url?: string; detail?: 'auto' | 'low' | 'high' };
      };
      switch (part.type) {
        case 'text':
          parts.push({ type: 'input_text', text: String(part.text ?? '') });
          break;
        case 'image_url':
          parts.push({
            type: 'input_image',
            image_url: typeof part.image_url === 'object' && part.image_url
              ? (part.image_url as { url?: string }).url
              : undefined,
            detail: typeof part.image_url === 'object' && part.image_url
              ? ((part.image_url as { detail?: 'auto' | 'low' | 'high' }).detail ?? 'auto')
              : 'auto',
          });
          break;
        case 'refusal':
          parts.push({ type: 'input_text', text: String(part.refusal ?? '') });
          break;
        case 'input_audio':
          parts.push({ type: 'input_text', text: '[audio omitted]' });
          break;
        case 'file':
          parts.push({ type: 'input_text', text: '[file omitted]' });
          break;
      }
    }

    return parts;
  }

  private normalizeResponsesCompletion(response: OpenAI.Responses.Response): Completion {
    const functionCalls = (response.output ?? []).filter((item) => item.type === 'function_call');
    const content = this.extractResponseText(response);
    const message: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: content || null,
    };

    if (functionCalls.length > 0) {
      message.tool_calls = functionCalls.map((item) => ({
        id: item.call_id ?? item.id ?? item.name,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      }));
    }

    return {
      id: response.id,
      object: 'chat.completion',
      created: typeof response.created_at === 'number'
        ? response.created_at
        : Math.floor(Date.now() / 1000),
      model: response.model ?? this.model,
      choices: [{
        index: 0,
        finish_reason: functionCalls.length > 0 ? 'tool_calls' : 'stop',
        logprobs: null,
        message,
      }],
    } as Completion;
  }

  private extractResponseText(response: OpenAI.Responses.Response): string {
    if (response.output_text?.trim()) {
      return response.output_text.trim();
    }

    const parts: string[] = [];
    for (const item of response.output ?? []) {
      if (item.type !== 'message') {
        continue;
      }

      for (const content of item.content ?? []) {
        if (content.type === 'output_text' && content.text) {
          parts.push(content.text);
        }
      }
    }

    return parts.join('\n').trim();
  }
}

function isTransientLLMError(err: unknown): boolean {
  const status = typeof err === 'object' && err !== null && 'status' in err
    ? Number((err as { status?: unknown }).status)
    : NaN;
  if ([408, 409, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const msg = err instanceof Error ? err.message : String(err);
  return /upstream request failed|timed out|timeout|econnreset|temporarily unavailable|bad gateway/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CircuitBreakerOpenError extends Error {
  constructor() {
    super('AI 服务暂时不可用，请稍后再试');
    this.name = 'CircuitBreakerOpenError';
  }
}
