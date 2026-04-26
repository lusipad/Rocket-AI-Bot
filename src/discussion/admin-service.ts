import type { ChatMessage, LLMClient } from '../llm/client.js';
import type { Logger } from '../utils/logger.js';
import type { ConversationMessage, RocketChatClient } from '../bot/client.js';
import {
  type ContextPolicy,
  type ContextScope,
  type RoomType,
  ContextPolicyStore,
  resolveContextScope,
  resolvePublicChannelLookbackMs,
  resolveRecentMessageLimit,
} from '../context/policy-store.js';
import { DiscussionSummaryStore, type DiscussionSummaryEntry, type DiscussionSummaryScope } from './summary-store.js';

export interface DiscussionSummaryAdminRebuildResult {
  entry: DiscussionSummaryEntry;
  recentMessageCount: number;
  recentImageCount: number;
  scope: ContextScope;
  publicChannelLookbackMinutes?: number;
}

export class DiscussionSummaryAdminService {
  constructor(
    private readonly store: DiscussionSummaryStore,
    private readonly policyStore: ContextPolicyStore,
    private readonly bot: Pick<RocketChatClient, 'getRecentMessages'>,
    private readonly llm: Pick<LLMClient, 'chat'>,
    private readonly logger?: Logger,
  ) {}

  list(limit = 200): DiscussionSummaryEntry[] {
    return this.store.list(limit);
  }

  clear(scope: DiscussionSummaryScope): boolean {
    return this.store.delete(scope);
  }

  getPolicy(): ContextPolicy {
    return this.policyStore.get();
  }

  setPolicy(input: Partial<ContextPolicy>): ContextPolicy {
    return this.policyStore.set(input);
  }

  async rebuild(scope: DiscussionSummaryScope): Promise<DiscussionSummaryAdminRebuildResult> {
    const policy = this.policyStore.get();
    const resolvedScope = resolveContextScope({
      roomType: scope.roomType,
      threadId: scope.threadId,
    });
    const recentMessageLimit = resolveRecentMessageLimit(policy, resolvedScope, true);
    const publicChannelLookbackMs = resolvePublicChannelLookbackMs(policy, scope.roomType, true);
    const recentMessages = await this.bot.getRecentMessages(
      scope.roomId,
      scope.roomType,
      {
        count: recentMessageLimit,
        threadId: scope.threadId,
        currentTimestamp: new Date(),
        maxLookbackMs: publicChannelLookbackMs,
      },
    );

    if (recentMessages.length === 0) {
      throw new Error('当前房间/线程没有可用于重建摘要的消息');
    }

    const summary = await this.generateSummary(recentMessages, resolvedScope);
    const entry: DiscussionSummaryEntry = {
      roomId: scope.roomId,
      threadId: scope.threadId,
      roomType: scope.roomType,
      summary,
      updatedAt: new Date().toISOString(),
      sourceMessageCount: recentMessages.length,
    };
    this.store.save(entry);

    return {
      entry,
      recentMessageCount: recentMessages.length,
      recentImageCount: recentMessages.reduce((sum, message) => sum + message.images.length, 0),
      scope: resolvedScope,
      publicChannelLookbackMinutes: publicChannelLookbackMs
        ? Math.round(publicChannelLookbackMs / 60_000)
        : undefined,
    };
  }

  private async generateSummary(
    recentMessages: ConversationMessage[],
    scope: ContextScope,
  ): Promise<string> {
    const transcript = recentMessages
      .map((message, index) => {
        const imageNote = message.images.length > 0 ? ` [含图片 ${message.images.length} 张]` : '';
        return `${index + 1}. [${message.username}] ${message.text || '[无文字内容]'}${imageNote}`;
      })
      .join('\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          '你负责为 Rocket.Chat 当前讨论重建摘要。'
          + '直接输出摘要正文，不要写前言，不要写“以下是总结”。'
          + '优先提炼结论、待办、风险和分歧；信息不足时明确说明暂无稳定结论。'
          + '控制在 180 字以内。',
      },
      {
        role: 'user',
        content:
          `请重建${scope === 'thread' ? '当前 thread' : '当前房间'}的讨论摘要。\n`
          + '聊天记录如下：\n'
          + transcript,
      },
    ];

    const response = await this.llm.chat(messages);
    const summary = response.choices[0]?.message?.content?.trim() ?? '';
    if (!summary) {
      this.logger?.warn('重建讨论摘要时拿到空回复');
      return '暂无稳定结论，建议结合最近消息继续确认。';
    }

    return summary;
  }
}
