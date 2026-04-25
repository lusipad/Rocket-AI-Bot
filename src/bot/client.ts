import { Bot } from '@rocket.chat/sdk';
import type { Logger } from '../utils/logger.js';
import type { Config } from '../config/schema.js';

// SDK alpha 版本仅导出 Bot/Rocketchat/Livechat/settings，
// 类型定义在 interfaces/ 目录但不对外 re-export，因此在这里手动声明需要的接口。

export interface IMessage {
  _id?: string;
  rid?: string;
  msg?: string;
  attachments?: Array<{ image_url?: string }>;
  u?: { _id: string; username: string; name?: string };
  ts?: { $date: number } | string;
}

export interface IMessageMeta {
  roomParticipant: boolean;
  roomType: 'c' | 'p' | 'd' | 'l';
  roomName?: string;
}

export type MessageCallback = (err: Error | null, message: IMessage, meta: IMessageMeta) => void;

export interface ConversationMessage {
  role: 'user' | 'assistant';
  username: string;
  text: string;
  images: string[];
}

const CONTEXT_GAP_MS = 10 * 60 * 1000;
const FOCUS_CONTEXT_WINDOW_MS = 5 * 60 * 1000;

export class RocketChatClient {
  private config: Config;
  private logger: Logger;
  private bot: Bot;
  private userId: string | null = null;
  private authToken: string | null = null;
  private connected = false;
  private callback: MessageCallback | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdownFlag = false;
  private attemptCount = 0;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;

    const { host, useSsl } = config.rocketchat;

    this.bot = new Bot({
      host,
      useSsl,
      logger: {
        debug: (msg: string) => logger.debug(msg),
        info: (msg: string) => logger.info(msg),
        warning: (msg: string) => logger.warn(msg),
        warn: (msg: string) => logger.warn(msg),
        error: (msg: string) => logger.error(msg),
      },
    });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get botUserId(): string | null {
    return this.userId;
  }

  async connect(): Promise<void> {
    this.shutdownFlag = false;
    const { host, useSsl, username, password } = this.config.rocketchat;

    try {
      this.logger.info(`正在连接到 Rocket.Chat: ${useSsl ? 'wss' : 'ws'}://${host}`);

      await this.bot.connect({ host, useSsl });
      const result: any = await this.bot.login({ username, password });

      this.userId = this.bot.userId ?? result?.id ?? null;
      this.authToken = result?.token ?? result?.authToken ?? null;
      this.connected = true;
      this.attemptCount = 0;

      this.logger.info(`Rocket.Chat 登录成功, userId: ${this.userId}`);

      await this.subscribeAndListen();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
      this.logger.error('Rocket.Chat 连接失败', { error: errMsg });
      this.connected = false;
      this.scheduleReconnect();
    }
  }

  async sendToRoom(text: string, roomName: string): Promise<void> {
    try {
      await this.bot.sendToRoom(text, roomName);
    } catch (err) {
      this.logger.error('发送消息失败', { roomName, error: String(err) });
    }
  }

  async sendToRoomId(text: string, roomId: string): Promise<void> {
    try {
      await this.bot.sendToRoomId(text, roomId);
    } catch (err) {
      this.logger.error('发送消息失败', { roomId, error: String(err) });
    }
  }

  async sendDirectToUser(text: string, username: string): Promise<void> {
    try {
      await this.bot.sendDirectToUser(text, username);
    } catch (err) {
      this.logger.error('发送私信失败', { username, error: String(err) });
    }
  }

  async getRoomName(roomId: string): Promise<string> {
    return this.bot.getRoomId(roomId);
  }

  async joinRooms(rooms: string[]): Promise<void> {
    try {
      await this.bot.joinRooms(rooms);
      this.logger.info('已加入频道', { rooms });
    } catch (err) {
      this.logger.warn('加入频道失败', { rooms, error: String(err) });
    }
  }

  async getRecentMessages(
    roomId: string,
    roomType?: IMessageMeta['roomType'],
    count = 12,
    excludeMessageId?: string,
    focusUserId?: string,
    currentTimestamp?: Date,
  ): Promise<ConversationMessage[]> {
    const endpoints = this.getHistoryEndpoints(roomType);
    let data: Record<string, unknown> | null = null;
    for (const endpoint of endpoints) {
      try {
        data = await this.apiGet(endpoint, { roomId, count: Math.max(count + 5, count) });
        break;
      } catch {
        continue;
      }
    }
    if (!data) return [];

    const history = Array.isArray(data?.messages) ? data.messages as IMessage[] : [];

    let candidates = history
      .filter((message) => message._id !== excludeMessageId)
      .filter((message) => (message.msg?.trim() ?? '') || this.extractImageUrls(message).length > 0)
      .filter((message) => !(message.u?._id === this.userId && message.msg?.trim() === '正在思考...'));

    if (focusUserId && currentTimestamp) {
      const currentMs = currentTimestamp.getTime();
      const focusIndex = candidates.findIndex((message) => {
        if (message.u?._id !== focusUserId) return false;
        const timestamp = this.getMessageTimestamp(message);
        if (timestamp === null) return false;
        return currentMs - timestamp <= FOCUS_CONTEXT_WINDOW_MS;
      });

      if (focusIndex !== -1) {
        candidates = candidates.slice(0, focusIndex + 1);
      }
    }

    const selected: IMessage[] = [];
    let lastTimestamp: number | null = null;
    for (const message of candidates) {
      if (selected.length >= count) break;

      const timestamp = this.getMessageTimestamp(message);
      if (lastTimestamp !== null && timestamp !== null && lastTimestamp - timestamp > CONTEXT_GAP_MS) {
        break;
      }

      selected.push(message);
      if (timestamp !== null) {
        lastTimestamp = timestamp;
      }
    }

    const messages: ConversationMessage[] = [];
    for (const message of selected.reverse()) {
      messages.push({
        role: message.u?._id === this.userId ? 'assistant' : 'user',
        username: message.u?.username ?? 'unknown',
        text: message.msg?.trim() ?? '',
        images: await this.resolveImageUrls(this.extractImageUrls(message)),
      });
    }

    return messages;
  }

  async resolveImageUrls(urls: string[]): Promise<string[]> {
    const images: string[] = [];
    for (const url of urls) {
      const resolved = await this.resolveImageUrl(url);
      if (resolved) {
        images.push(resolved);
      }
    }
    return images;
  }

  async disconnect(): Promise<void> {
    this.shutdownFlag = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connected) {
      try {
        await this.bot.disconnect();
      } catch { /* ignore */ }
      this.connected = false;
    }
  }

  private get restBaseUrl(): string {
    const host = this.config.rocketchat.host.replace(/\/+$/, '');
    if (/^https?:\/\//i.test(host)) {
      return host;
    }
    return `${this.config.rocketchat.useSsl ? 'https' : 'http'}://${host}`;
  }

  private get authHeaders(): Record<string, string> {
    if (!this.authToken || !this.userId) {
      return {};
    }

    return {
      'X-Auth-Token': this.authToken,
      'X-User-Id': this.userId,
    };
  }

  private async apiGet(endpoint: string, params: Record<string, string | number>): Promise<Record<string, unknown>> {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      searchParams.set(key, String(value));
    }

    const response = await fetch(`${this.restBaseUrl}/api/v1/${endpoint}?${searchParams.toString()}`, {
      headers: this.authHeaders,
    });
    const data = await response.json() as Record<string, unknown>;

    if (!response.ok) {
      throw new Error(`Rocket.Chat API 请求失败: ${endpoint} (${response.status})`);
    }

    return data;
  }

  private getHistoryEndpoints(roomType?: IMessageMeta['roomType']): string[] {
    switch (roomType) {
      case 'c':
        return ['channels.history'];
      case 'p':
        return ['groups.history'];
      case 'd':
        return ['dm.history'];
      default:
        return ['channels.history', 'groups.history', 'dm.history'];
    }
  }

  private extractImageUrls(message: IMessage): string[] {
    return (message.attachments ?? [])
      .map((attachment) => attachment.image_url?.trim())
      .filter((url): url is string => Boolean(url));
  }

  private getMessageTimestamp(message: IMessage): number | null {
    if (!message.ts) return null;

    if (typeof message.ts === 'string') {
      return new Date(message.ts).getTime();
    }

    return new Date(message.ts.$date).getTime();
  }

  private async resolveImageUrl(url: string): Promise<string | null> {
    if (!url) return null;
    if (url.startsWith('data:')) return url;

    const absoluteUrl = this.toAbsoluteUrl(url);
    if (!this.shouldInlineImage(absoluteUrl)) {
      return absoluteUrl;
    }

    try {
      const headers = absoluteUrl.startsWith(this.restBaseUrl) ? this.authHeaders : {};
      const response = await fetch(absoluteUrl, { headers });
      if (!response.ok) {
        throw new Error(`下载图片失败 (${response.status})`);
      }

      const contentType = response.headers.get('content-type') ?? 'image/png';
      const buffer = Buffer.from(await response.arrayBuffer());
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    } catch (err) {
      this.logger.warn('图片转 data URL 失败', { url: absoluteUrl, error: String(err) });
      return null;
    }
  }

  private toAbsoluteUrl(url: string): string {
    return new URL(url, `${this.restBaseUrl}/`).toString();
  }

  private shouldInlineImage(url: string): boolean {
    return url.startsWith(this.restBaseUrl);
  }

  private async subscribeAndListen(): Promise<void> {
    // Bot.reactToMessages 的回调签名: (error, message, meta?)
    await this.bot.reactToMessages((err: any, message?: any, meta?: any) => {
      if (this.shutdownFlag) return;
      if (err) {
        this.logger.error('消息接收错误', { error: String(err) });
        this.connected = false;
        this.scheduleReconnect();
        return;
      }
      if (message && meta) {
        this.callback?.(null, message as IMessage, meta as IMessageMeta);
      }
    });
    this.logger.info('已订阅消息流');
  }

  private scheduleReconnect(): void {
    if (this.shutdownFlag) return;

    this.attemptCount++;
    const baseDelay = 1000;
    const maxDelay = 30000;
    const delay = Math.min(baseDelay * Math.pow(2, this.attemptCount - 1), maxDelay);
    const jitter = delay * (0.8 + Math.random() * 0.4);

    this.logger.info(`计划重连 (第 ${this.attemptCount} 次, ${Math.round(jitter)}ms 后)`);

    this.reconnectTimer = setTimeout(async () => {
      if (this.shutdownFlag) return;
      await this.connect();
    }, jitter);
  }
}
