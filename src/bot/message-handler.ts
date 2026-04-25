import type { Logger } from '../utils/logger.js';
import type { RocketChatClient, IMessage, IMessageMeta } from './client.js';
import type { MessageDeduplicator } from './deduplicator.js';
import type { Config } from '../config/schema.js';

export interface BotMessageImage {
  url: string;
}

export interface RequestContext {
  roomId: string;
  roomType?: IMessageMeta['roomType'];
  threadId?: string;
  triggerMessageId: string;
  timestamp: Date;
}

export interface BotMessage extends RequestContext {
  id: string;
  text: string;
  userId: string;
  username: string;
  roomName: string;
  timestamp: Date;
  images: BotMessageImage[];
}

export type MessageHandler = (msg: BotMessage) => Promise<void>;

export class MessageRouter {
  private client: RocketChatClient;
  private deduplicator: MessageDeduplicator;
  private config: Config;
  private logger: Logger;
  private handlers = new Map<string, MessageHandler>();

  constructor(
    client: RocketChatClient,
    deduplicator: MessageDeduplicator,
    config: Config,
    logger: Logger,
  ) {
    this.client = client;
    this.deduplicator = deduplicator;
    this.config = config;
    this.logger = logger;
  }

  on(type: string, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  async handleRawMessage(rawErr: Error | null, raw: IMessage, meta: IMessageMeta): Promise<void> {
    if (rawErr) return;
    if (!raw.msg) return;

    // 忽略自己发的消息
    if (raw.u?._id && raw.u._id === this.client.botUserId) return;

    // 去重
    const msgId = raw._id;
    if (!msgId) return;
    if (this.deduplicator.isProcessed(msgId)) return;
    this.deduplicator.markProcessed(msgId);

    const text = raw.msg.trim();
    if (!text) return;

    const message: BotMessage = {
      id: msgId,
      text,
      userId: raw.u?._id ?? '',
      username: raw.u?.username ?? 'unknown',
      roomId: raw.rid ?? '',
      roomName: meta.roomName ?? '',
      roomType: meta.roomType,
      threadId: raw.tmid,
      triggerMessageId: msgId,
      timestamp: raw.ts
        ? new Date(typeof raw.ts === 'string' ? raw.ts : raw.ts.$date)
        : new Date(),
      images: (raw.attachments ?? [])
        .map((attachment) => attachment.image_url?.trim())
        .filter((url): url is string => Boolean(url))
        .map((url) => ({ url })),
    };

    this.logger.debug('收到消息', { username: message.username, room: message.roomName });

    // 检测 @mention
    const botName = this.config.rocketchat.botUsername;
    const mentionPattern = new RegExp(`@${botName}\\b`, 'i');
    if (mentionPattern.test(text)) {
      const handler = this.handlers.get('mention');
      if (handler) {
        try {
          await handler(message);
        } catch (error) {
          this.logger.error('mention 处理器异常', { error: String(error), msgId });
        }
      }
    }
  }
}
