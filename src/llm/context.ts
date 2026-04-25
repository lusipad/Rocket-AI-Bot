import tiktoken from 'tiktoken';
import type OpenAI from 'openai';
import type { Config } from '../config/schema.js';

export interface ContextEntry {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAI.Chat.Completions.ChatCompletionContentPart[];
  tokenCount: number;
  timestamp: number;
  toolCallId?: string;
  toolCalls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
}

export class ContextBuilder {
  private entries: ContextEntry[] = [];
  private encoder: ReturnType<typeof tiktoken.get_encoding>;
  private config: Config;
  private systemPrompt: string;

  constructor(config: Config, systemPrompt: string) {
    this.config = config;
    this.systemPrompt = systemPrompt;
    this.encoder = tiktoken.get_encoding('cl100k_base');

    // 系统提示词作为第一条且不可删除
    const sysTokens = this.count(systemPrompt);
    this.entries.push({
      role: 'system',
      content: systemPrompt,
      tokenCount: sysTokens,
      timestamp: Date.now(),
    });
  }

  count(text: string): number {
    return this.encoder.encode(text).length;
  }

  add(
    role: 'user' | 'assistant' | 'tool',
    content: string | OpenAI.Chat.Completions.ChatCompletionContentPart[],
    toolCallId?: string,
  ): void {
    const tokenCount = this.countContent(content);
    this.entries.push({ role, content, tokenCount, timestamp: Date.now(), toolCallId });
    this.prune();
  }

  addAssistantToolCalls(
    toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
    content: string = '',
  ): void {
    const toolCallText = JSON.stringify(toolCalls);
    const tokenCount = this.countContent(content) + this.count(toolCallText);
    this.entries.push({
      role: 'assistant',
      content,
      tokenCount,
      timestamp: Date.now(),
      toolCalls,
    });
    this.prune();
  }

  /** 构建 LLM 消息数组，控制在 contextWindow 内 */
  build(additionalTokens = 0): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const maxTokens = this.config.llm.contextWindow - additionalTokens;
    let used = 0;
    const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    const selected: ContextEntry[] = [];

    // 系统消息必须保留
    const sys = this.entries[0];
    used += sys.tokenCount;
    result.push({
      role: 'system',
      content: typeof sys.content === 'string' ? sys.content : '',
    });

    // 从最新到最旧添加，直到超出限制
    for (let i = this.entries.length - 1; i >= 1; i--) {
      const entry = this.entries[i];
      if (used + entry.tokenCount > maxTokens) break;
      selected.push(entry);
      used += entry.tokenCount;
    }

    for (const entry of selected.reverse()) {
      switch (entry.role) {
        case 'user':
          result.push({ role: 'user', content: entry.content });
          break;
        case 'assistant':
          if (entry.toolCalls?.length) {
            result.push({
              role: 'assistant',
              content: typeof entry.content === 'string' ? (entry.content || null) : null,
              tool_calls: entry.toolCalls,
            });
            break;
          }
          result.push({
            role: 'assistant',
            content: typeof entry.content === 'string' ? entry.content : '',
          });
          break;
        case 'tool':
          result.push({
            role: 'tool',
            content: typeof entry.content === 'string' ? entry.content : '',
            tool_call_id: entry.toolCallId!,
          });
          break;
      }
    }

    return result;
  }

  /** 丢弃最旧的系统消息以外的条目 */
  private prune(): void {
    const maxTokens = this.config.llm.contextWindow * 0.85;
    let total = this.entries.reduce((sum, e) => sum + e.tokenCount, 0);

    // 从旧到新丢弃
    while (total > maxTokens && this.entries.length > 2) {
      const removed = this.entries.splice(1, 1)[0]; // 跳过系统消息
      total -= removed.tokenCount;
    }
  }

  /** 获取最近 N 条用户/助手消息 */
  recentUserMessages(n: number): ContextEntry[] {
    return this.entries
      .filter((e) => e.role === 'user')
      .slice(-n);
  }

  private countContent(content: string | OpenAI.Chat.Completions.ChatCompletionContentPart[]): number {
    if (typeof content === 'string') {
      return this.count(content);
    }

    let hintText = '';
    let extraTokens = 0;

    for (const part of content) {
      switch (part.type) {
        case 'text':
          hintText += part.text;
          break;
        case 'image_url':
          hintText += '[image]';
          extraTokens += 512;
          break;
        case 'input_audio':
          hintText += '[audio]';
          extraTokens += 512;
          break;
        case 'file':
          hintText += '[file]';
          extraTokens += 256;
          break;
      }
    }

    return this.count(hintText) + extraTokens;
  }
}
