import { Bot } from '@rocket.chat/sdk';
import type { Logger } from '../utils/logger.js';
import type { Config } from '../config/schema.js';

// SDK alpha 版本仅导出 Bot/Rocketchat/Livechat/settings，
// 类型定义在 interfaces/ 目录但不对外 re-export，因此在这里手动声明需要的接口。

export interface IMessage {
  _id?: string;
  rid?: string;
  tmid?: string;
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

export interface DiscussionHistoryMessage {
  id: string;
  threadId?: string;
  role: 'user' | 'assistant';
  username: string;
  text: string;
  imageCount: number;
  timestamp: string;
}

export interface DiscussionHistoryPage {
  messages: DiscussionHistoryMessage[];
  hasMore: boolean;
  nextBeforeMessageId?: string;
}

const DEFAULT_DISCUSSION_LOOKBACK_MS = 45 * 60 * 1000;
const EXTENDED_DISCUSSION_LOOKBACK_MS = 3 * 60 * 60 * 1000;
const DEFAULT_DISCUSSION_SOFT_GAP_MS = 15 * 60 * 1000;
const EXTENDED_DISCUSSION_SOFT_GAP_MS = 30 * 60 * 1000;
const DEFAULT_DISCUSSION_HARD_GAP_MS = 45 * 60 * 1000;
const EXTENDED_DISCUSSION_HARD_GAP_MS = 2 * 60 * 60 * 1000;
const DISCUSSION_FETCH_BUFFER = 20;
const MAX_DISCUSSION_FETCH_COUNT = 120;

export interface RecentMessageOptions {
  count?: number;
  excludeMessageId?: string;
  currentTimestamp?: Date;
  threadId?: string;
  maxLookbackMs?: number;
}

export interface DiscussionHistoryPageOptions {
  beforeMessageId?: string;
  limit?: number;
  currentTimestamp?: Date;
  threadId?: string;
  useExtendedWindow?: boolean;
  maxLookbackMs?: number;
}

export type PresenceStatus = 'online' | 'busy' | 'away' | 'offline';

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
  private roomMetaCache = new Map<string, IMessageMeta>();
  private lastPresence: { status: PresenceStatus; message: string } | null = null;
  private readonly socketCloseHandler = (event?: { code?: number; reason?: string }) => {
    this.handleSocketClose(event);
  };

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
      await this.attachSocketCloseWatcher();
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

  async postToRoomId(text: string, roomId: string): Promise<string | null> {
    try {
      const data = await this.apiPost('chat.postMessage', { roomId, text });
      const message = typeof data.message === 'object' && data.message !== null
        ? data.message as Record<string, unknown>
        : null;
      return typeof message?._id === 'string' ? message._id : null;
    } catch (err) {
      this.logger.error('发送消息失败', { roomId, error: String(err) });
      return null;
    }
  }

  async updateRoomMessage(roomId: string, msgId: string, text: string): Promise<boolean> {
    try {
      await this.apiPost('chat.update', { roomId, msgId, text });
      return true;
    } catch (err) {
      this.logger.error('更新消息失败', { roomId, msgId, error: String(err) });
      return false;
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
    options: RecentMessageOptions = {},
  ): Promise<ConversationMessage[]> {
    const count = Math.max(1, options.count ?? 12);
    const fetchCount = Math.min(count + DISCUSSION_FETCH_BUFFER, MAX_DISCUSSION_FETCH_COUNT);
    const useExtendedWindow = count > 40;
    const history = await this.fetchHistoryMessages(roomId, roomType, fetchCount);

    let candidates = this.buildHistoryCandidates(history, options.excludeMessageId);
    candidates = this.filterThreadCandidates(candidates, options.threadId);

    const selected = this.sliceDiscussionCandidates(
      candidates,
      count,
      options.currentTimestamp,
      useExtendedWindow,
      options.maxLookbackMs,
    );

    return this.toConversationMessages(selected);
  }

  async getDiscussionHistoryPage(
    roomId: string,
    roomType?: IMessageMeta['roomType'],
    options: DiscussionHistoryPageOptions = {},
  ): Promise<DiscussionHistoryPage> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 30));
    const fetchCount = Math.min(
      Math.max(limit + DISCUSSION_FETCH_BUFFER + 1, 80),
      MAX_DISCUSSION_FETCH_COUNT,
    );
    const history = await this.fetchHistoryMessages(roomId, roomType, fetchCount);
    let candidates = this.buildHistoryCandidates(history);
    candidates = this.filterThreadCandidates(candidates, options.threadId);

    let anchorTimestamp = options.currentTimestamp;
    let olderCandidates = candidates;
    if (options.beforeMessageId) {
      const anchorIndex = candidates.findIndex((message) => message._id === options.beforeMessageId);
      if (anchorIndex !== -1) {
        const timestamp = this.getMessageTimestamp(candidates[anchorIndex]);
        if (timestamp !== null) {
          anchorTimestamp = new Date(timestamp);
        }
        olderCandidates = candidates.slice(anchorIndex + 1);
      }
    }

    const selected = this.sliceDiscussionCandidates(
      olderCandidates,
      limit,
      anchorTimestamp,
      options.useExtendedWindow ?? true,
      options.maxLookbackMs,
    );
    const oldestReturned = selected[selected.length - 1];

    return {
      messages: this.toDiscussionHistoryMessages(selected),
      hasMore: olderCandidates.length > selected.length,
      nextBeforeMessageId: oldestReturned?._id,
    };
  }

  private sliceDiscussionCandidates(
    candidates: IMessage[],
    count: number,
    currentTimestamp?: Date,
    useExtendedWindow = false,
    maxLookbackMsOverride?: number,
  ): IMessage[] {
    if (candidates.length === 0) return [];

    const anchorTimestamp = currentTimestamp?.getTime()
      ?? this.getMessageTimestamp(candidates[0])
      ?? Date.now();
    const maxLookbackMs = maxLookbackMsOverride
      ?? (useExtendedWindow ? EXTENDED_DISCUSSION_LOOKBACK_MS : DEFAULT_DISCUSSION_LOOKBACK_MS);
    const softGapMs = useExtendedWindow
      ? EXTENDED_DISCUSSION_SOFT_GAP_MS
      : DEFAULT_DISCUSSION_SOFT_GAP_MS;
    const hardGapMs = useExtendedWindow
      ? EXTENDED_DISCUSSION_HARD_GAP_MS
      : DEFAULT_DISCUSSION_HARD_GAP_MS;
    const minMessagesBeforeSoftGapStop = Math.min(
      count,
      useExtendedWindow ? 12 : Math.max(3, Math.ceil(count / 2)),
    );

    const selected: IMessage[] = [];
    let previousTimestamp = anchorTimestamp;

    for (const message of candidates) {
      if (selected.length >= count) break;

      const timestamp = this.getMessageTimestamp(message);
      if (timestamp !== null) {
        if (anchorTimestamp - timestamp > maxLookbackMs) {
          break;
        }

        const gapMs = previousTimestamp - timestamp;
        if (selected.length > 0 && gapMs > hardGapMs) {
          break;
        }

        if (selected.length >= minMessagesBeforeSoftGapStop && gapMs > softGapMs) {
          break;
        }

        previousTimestamp = timestamp;
      }

      selected.push(message);
    }

    return selected;
  }

  private async toConversationMessages(candidates: IMessage[]): Promise<ConversationMessage[]> {
    const messages: ConversationMessage[] = [];
    for (const message of [...candidates].reverse()) {
      messages.push({
        role: message.u?._id === this.userId ? 'assistant' : 'user',
        username: message.u?.username ?? 'unknown',
        text: message.msg?.trim() ?? '',
        images: await this.resolveImageUrls(this.extractImageUrls(message)),
      });
    }

    return messages;
  }

  private toDiscussionHistoryMessages(candidates: IMessage[]): DiscussionHistoryMessage[] {
    return [...candidates].reverse().map((message) => ({
      id: message._id ?? '',
      threadId: message.tmid,
      role: message.u?._id === this.userId ? 'assistant' : 'user',
      username: message.u?.username ?? 'unknown',
      text: message.msg?.trim() ?? '',
      imageCount: this.extractImageUrls(message).length,
      timestamp: this.toIsoTimestamp(message),
    }));
  }

  private buildHistoryCandidates(history: IMessage[], excludeMessageId?: string): IMessage[] {
    return history
      .filter((message) => message._id !== excludeMessageId)
      .filter((message) => (message.msg?.trim() ?? '') || this.extractImageUrls(message).length > 0)
      .filter((message) => !(message.u?._id === this.userId && message.msg?.trim() === '正在思考...'));
  }

  private filterThreadCandidates(candidates: IMessage[], threadId?: string): IMessage[] {
    if (!threadId) {
      return candidates;
    }

    const threadMessages = candidates.filter((message) =>
      message._id === threadId || message.tmid === threadId,
    );
    return threadMessages.length > 0 ? threadMessages : candidates;
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
        await this.setPresence('offline', 'AI 已离线');
        await this.bot.disconnect();
      } catch { /* ignore */ }
      this.connected = false;
    }
  }

  async syncAvailability(llmState: string): Promise<void> {
    if (!this.connected) {
      await this.setPresence('offline', 'AI 已离线');
      return;
    }

    if (llmState !== 'CLOSED') {
      await this.setPresence('busy', 'AI 暂时不可用');
      return;
    }

    await this.setPresence('online', '');
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

  private async fetchHistoryMessages(
    roomId: string,
    roomType: IMessageMeta['roomType'] | undefined,
    count: number,
  ): Promise<IMessage[]> {
    const endpoints = this.getHistoryEndpoints(roomType);
    for (const endpoint of endpoints) {
      try {
        const data = await this.apiGet(endpoint, { roomId, count });
        return Array.isArray(data?.messages) ? data.messages as IMessage[] : [];
      } catch {
        continue;
      }
    }

    return [];
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

  private async apiPost(endpoint: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.restBaseUrl}/api/v1/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify(body),
    });
    const data = await response.json() as Record<string, unknown>;

    if (!response.ok) {
      throw new Error(`Rocket.Chat API 请求失败: ${endpoint} (${response.status})`);
    }

    return data;
  }

  private async setPresence(status: PresenceStatus, message: string): Promise<void> {
    if (!this.authToken || !this.userId) {
      return;
    }

    if (this.lastPresence?.status === status && this.lastPresence.message === message) {
      return;
    }

    try {
      await this.apiPost('users.setStatus', { status, message });
      this.lastPresence = { status, message };
    } catch (err) {
      this.logger.warn('同步 Rocket.Chat 状态失败', { status, error: String(err) });
    }
  }

  private async resolveMessageMeta(message: IMessage, meta?: Partial<IMessageMeta>): Promise<IMessageMeta> {
    if (meta?.roomType) {
      return {
        roomParticipant: meta.roomParticipant ?? true,
        roomType: meta.roomType,
        ...(meta.roomName ? { roomName: meta.roomName } : {}),
      };
    }

    const roomId = message.rid?.trim();
    if (!roomId) {
      return {
        roomParticipant: meta?.roomParticipant ?? true,
        roomType: 'c',
        ...(meta?.roomName ? { roomName: meta.roomName } : {}),
      };
    }

    const cached = this.roomMetaCache.get(roomId);
    if (cached) {
      return cached;
    }

    try {
      const data = await this.apiGet('rooms.info', { roomId });
      const rawRoom = typeof data.room === 'object' && data.room !== null
        ? data.room as Record<string, unknown>
        : data;
      const roomType = rawRoom.t;
      if (roomType === 'c' || roomType === 'p' || roomType === 'd' || roomType === 'l') {
        const resolved: IMessageMeta = {
          roomParticipant: true,
          roomType,
          ...(typeof rawRoom.name === 'string'
            ? { roomName: rawRoom.name }
            : (meta?.roomName ? { roomName: meta.roomName } : {})),
        };
        this.roomMetaCache.set(roomId, resolved);
        return resolved;
      }
    } catch (err) {
      this.logger.warn('补充房间元数据失败', { roomId, error: String(err) });
    }

    return {
      roomParticipant: meta?.roomParticipant ?? true,
      roomType: 'c',
      ...(meta?.roomName ? { roomName: meta.roomName } : {}),
    };
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

  private toIsoTimestamp(message: IMessage): string {
    const timestamp = this.getMessageTimestamp(message);
    return timestamp === null ? new Date(0).toISOString() : new Date(timestamp).toISOString();
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
    await this.bot.reactToMessages(async (err: any, message?: any, meta?: any) => {
      if (this.shutdownFlag) return;
      if (err) {
        this.logger.error('消息接收错误', { error: String(err) });
        this.connected = false;
        this.scheduleReconnect();
        return;
      }
      if (message) {
        const resolvedMeta = await this.resolveMessageMeta(
          message as IMessage,
          meta as Partial<IMessageMeta> | undefined,
        );
        this.callback?.(null, message as IMessage, resolvedMeta);
      }
    });
    this.logger.info('已订阅消息流');
  }

  private async attachSocketCloseWatcher(): Promise<void> {
    const botWithSocket = this.bot as unknown as { socket?: Promise<{ ddp?: { off?: (event: string, listener: Function) => unknown; on?: (event: string, listener: Function) => unknown } }> };
    const driver = await botWithSocket.socket;
    const ddp = driver?.ddp;
    if (!ddp?.on) {
      return;
    }

    ddp.off?.('close', this.socketCloseHandler);
    ddp.on('close', this.socketCloseHandler);
  }

  private handleSocketClose(event?: { code?: number; reason?: string }): void {
    if (this.shutdownFlag) {
      return;
    }

    this.connected = false;
    this.logger.warn('Rocket.Chat DDP 连接已关闭，准备重连', {
      code: event?.code,
      reason: event?.reason,
    });
    void this.setPresence('offline', 'AI 已离线');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.shutdownFlag) return;
    if (this.reconnectTimer) return;

    this.attemptCount++;
    const baseDelay = 1000;
    const maxDelay = 30000;
    const delay = Math.min(baseDelay * Math.pow(2, this.attemptCount - 1), maxDelay);
    const jitter = delay * (0.8 + Math.random() * 0.4);

    this.logger.info(`计划重连 (第 ${this.attemptCount} 次, ${Math.round(jitter)}ms 后)`);

    this.reconnectTimer = setTimeout(async () => {
      if (this.shutdownFlag) return;
      this.reconnectTimer = null;
      await this.connect();
    }, jitter);
  }
}
