import type { ConversationMessage } from '../agent/orchestrator.js';
import { DiscussionSummaryStore, type DiscussionSummaryScope } from './summary-store.js';

const DISCUSSION_CONTEXT_PATTERN = /(总结|汇总|回顾|梳理|归纳|结论|分歧|待办|继续|上面|刚才|前面)/i;
const DISCUSSION_REFRESH_PATTERN = /(总结|汇总|回顾|梳理|归纳|结论|分歧|待办|纪要)/i;

export class DiscussionSummaryService {
  private store: DiscussionSummaryStore;

  constructor(store: DiscussionSummaryStore) {
    this.store = store;
  }

  prepareContext(text: string, scope: DiscussionSummaryScope): ConversationMessage | null {
    if (!isDiscussionContextRequest(text)) {
      return null;
    }

    const summary = this.store.get(scope);
    if (!summary?.summary) {
      return null;
    }

    return {
      role: 'assistant',
      username: 'discussion-summary',
      text: `[${scope.threadId ? '当前 thread' : '当前房间'} 讨论摘要，更新于 ${summary.updatedAt}]\n${summary.summary}\n如果与最近消息冲突，以最近消息为准。`,
      images: [],
      isSummary: true,
    };
  }

  maybeRefreshFromReply(
    text: string,
    scope: DiscussionSummaryScope,
    recentMessages: ConversationMessage[],
    reply: string,
  ): boolean {
    if (!shouldRefreshDiscussionSummary(text)) {
      return false;
    }

    const cleanedReply = stripReplyDecorations(reply);
    if (!cleanedReply) {
      return false;
    }

    const sourceMessages = recentMessages.filter((message) => !message.isSummary);
    this.store.save({
      roomId: scope.roomId,
      threadId: scope.threadId,
      roomType: scope.roomType,
      summary: cleanedReply,
      updatedAt: new Date().toISOString(),
      sourceMessageCount: sourceMessages.length,
    });
    return true;
  }

  get(scope: DiscussionSummaryScope) {
    return this.store.get(scope);
  }

  list(limit?: number) {
    return this.store.list(limit);
  }

  clear(scope: DiscussionSummaryScope): boolean {
    return this.store.delete(scope);
  }
}

export function isDiscussionContextRequest(text: string): boolean {
  return DISCUSSION_CONTEXT_PATTERN.test(text);
}

function shouldRefreshDiscussionSummary(text: string): boolean {
  return DISCUSSION_REFRESH_PATTERN.test(text);
}

export function stripReplyDecorations(reply: string): string {
  const lines = reply.trim().split(/\r?\n/);
  const cleaned: string[] = [];
  let skippingHeadMetadata = true;

  for (const line of lines) {
    if (
      skippingHeadMetadata
      && (line.trim() === ''
        || line.startsWith('上下文: ')
        || line.startsWith('已激活 skill: ')
        || line.startsWith('已使用工具: '))
    ) {
      continue;
    }

    skippingHeadMetadata = false;
    cleaned.push(line);
  }

  return cleaned.join('\n').trim();
}
