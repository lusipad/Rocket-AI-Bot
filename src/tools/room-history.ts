import type { DiscussionHistoryPage, RocketChatClient } from '../bot/client.js';
import type { Tool, ToolExecutionContext, ToolResult } from './registry.js';
import type { Logger } from '../utils/logger.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 30;

export function createRoomHistoryTool(bot: Pick<RocketChatClient, 'getDiscussionHistoryPage'>): Tool {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'room_history',
        description:
          '补充读取当前 Rocket.Chat 房间或当前线程里更早的讨论消息。' +
          '仅能访问当前请求所在的房间/线程，适合在总结、回顾、继续当前讨论时，上下文不够用的情况。',
        parameters: {
          type: 'object',
          properties: {
            before_message_id: {
              type: 'string',
              description: '从这条消息之前继续向前读取更早历史；通常传当前已知最早消息 ID',
            },
            limit: {
              type: 'number',
              description: '本次补充读取的消息条数，建议 10-20，最大 30',
            },
            purpose: {
              type: 'string',
              description: '为什么需要补充更早历史，例如“总结当前讨论”或“确认之前的结论”',
            },
          },
        },
      },
    },
    timeout: 15000,

    async execute(
      params: Record<string, unknown>,
      _logger: Logger,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      const request = context.request;
      if (!request?.roomId) {
        return {
          success: false,
          data: { error: '当前请求没有房间上下文，无法读取聊天历史' },
        };
      }

      const limit = normalizeLimit(params.limit);
      const beforeMessageId = normalizeBeforeMessageId(params.before_message_id, request.triggerMessageId);
      const history = await bot.getDiscussionHistoryPage(
        request.roomId,
        request.roomType,
        {
          beforeMessageId,
          limit,
          currentTimestamp: request.timestamp,
          threadId: request.threadId,
          useExtendedWindow: true,
        },
      );

      return {
        success: true,
        data: buildToolResult(history, request.roomId, request.threadId, beforeMessageId, params.purpose),
      };
    },
  };
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(Math.floor(parsed), MAX_LIMIT));
}

function normalizeBeforeMessageId(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback;
}

function buildToolResult(
  history: DiscussionHistoryPage,
  roomId: string,
  threadId: string | undefined,
  beforeMessageId: string,
  purpose: unknown,
): Record<string, unknown> {
  return {
    roomId,
    threadId: threadId ?? null,
    beforeMessageId,
    purpose: typeof purpose === 'string' && purpose.trim() ? purpose.trim() : null,
    count: history.messages.length,
    hasMore: history.hasMore,
    nextBeforeMessageId: history.nextBeforeMessageId ?? null,
    messages: history.messages,
  };
}
