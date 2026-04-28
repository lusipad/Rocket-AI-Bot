import type { BotMessage } from '../../bot/message-handler.js';
import type { AgentConversationMessage, AgentRequest } from '../../agent-core/types.js';

export function toRocketChatAgentRequest(
  msg: BotMessage,
  requestId: string,
  conversation: AgentConversationMessage[] = [],
  currentImageUrls: string[] = [],
): AgentRequest {
  return {
    id: requestId,
    input: msg.text,
    actor: {
      id: msg.userId,
      username: msg.username,
      kind: 'human',
    },
    channel: {
      kind: 'rocketchat',
      roomId: msg.roomId,
      roomName: msg.roomName,
      roomType: msg.roomType,
      threadId: msg.threadId,
    },
    conversation,
    attachments: currentImageUrls.map((url) => ({ type: 'image', url })),
    metadata: {
      triggerMessageId: msg.id,
      timestamp: msg.timestamp,
    },
  };
}

export function toSchedulerAgentRequest(
  requestId: string,
  instruction: string,
  roomId: string,
): AgentRequest {
  return {
    id: requestId,
    input: `执行定时任务: ${instruction}`,
    actor: {
      id: 'scheduler',
      username: '系统',
      kind: 'system',
    },
    channel: {
      kind: 'scheduler',
      roomId,
    },
    conversation: [],
    attachments: [],
  };
}
