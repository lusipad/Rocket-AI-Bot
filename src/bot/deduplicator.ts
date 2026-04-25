import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/helpers.js';

/**
 * LRU 消息去重器
 * 存储最近已处理消息的 ID，用于断线重连后跳过重复消息
 */
export class MessageDeduplicator {
  private cache: Map<string, number>;  // msgId -> timestamp
  private readonly maxSize: number;
  private readonly persistPath: string;

  constructor(maxSize = 1000, persistDir = 'data/memory') {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.persistPath = path.join(persistDir, 'processed-msg.json');
    this.load();
  }

  isProcessed(msgId: string): boolean {
    return this.cache.has(msgId);
  }

  markProcessed(msgId: string): void {
    this.cache.set(msgId, Date.now());
    if (this.cache.size > this.maxSize) {
      // 淘汰最旧的
      const oldest = this.cache.entries().next();
      if (oldest.value) this.cache.delete(oldest.value[0]);
    }
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
      if (Array.isArray(data)) {
        for (const { id, ts } of data) {
          if (id) this.cache.set(id, ts ?? 0);
        }
      }
    } catch { /* 首次不存在正常 */ }
  }

  flush(): void {
    ensureDir(path.dirname(this.persistPath));
    const data = Array.from(this.cache.entries()).map(([id, ts]) => ({ id, ts }));
    fs.writeFileSync(this.persistPath, JSON.stringify(data), 'utf-8');
  }
}
