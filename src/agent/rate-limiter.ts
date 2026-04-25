/**
 * 频道级和用户级限流
 */
export class RateLimiter {
  private channelLastTime = new Map<string, number>();
  private userTimestamps = new Map<string, number[]>();
  private channelCooldownMs: number;
  private userMaxPerMinute: number;

  constructor(channelCooldownMs = 5000, userMaxPerMinute = 5) {
    this.channelCooldownMs = channelCooldownMs;
    this.userMaxPerMinute = userMaxPerMinute;
  }

  /** 检查频道冷却，返回还能处理的毫秒数 (0 = OK) */
  checkChannel(channelId: string): number {
    const last = this.channelLastTime.get(channelId);
    if (!last) return 0;
    const elapsed = Date.now() - last;
    if (elapsed >= this.channelCooldownMs) return 0;
    return this.channelCooldownMs - elapsed;
  }

  /** 检查用户配额，返回是否被限制 */
  checkUser(userId: string): boolean {
    const now = Date.now();
    let timestamps = this.userTimestamps.get(userId);
    if (!timestamps) {
      this.userTimestamps.set(userId, [now]);
      return false;
    }

    // 清理超过 1 分钟的记录
    timestamps = timestamps.filter((t) => now - t < 60000);
    this.userTimestamps.set(userId, timestamps);

    return timestamps.length >= this.userMaxPerMinute;
  }

  touch(channelId: string, userId: string): void {
    this.channelLastTime.set(channelId, Date.now());

    const timestamps = this.userTimestamps.get(userId) ?? [];
    timestamps.push(Date.now());
    this.userTimestamps.set(userId, timestamps);
  }
}
