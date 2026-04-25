/**
 * 熔断器 —— LLM 调用连续失败后自动降级，防止雪崩
 *
 * 状态机:
 *   CLOSED (正常) → 连续 threshold 次失败 → OPEN (拒绝所有调用)
 *   OPEN → recoveryTimeout 后 → HALF_OPEN (试探一次)
 *     → 成功 → CLOSED
 *     → 失败 → OPEN (重置计时)
 */

enum State {
  CLOSED,
  OPEN,
  HALF_OPEN,
}

export class CircuitBreaker {
  private state = State.CLOSED;
  private failureCount = 0;
  private openTime = 0;
  private readonly threshold: number;
  private readonly recoveryTimeout: number;

  constructor(threshold = 3, recoveryTimeout = 10000) {
    this.threshold = threshold;
    this.recoveryTimeout = recoveryTimeout;
  }

  get isOpen(): boolean {
    if (this.state === State.OPEN) {
      if (Date.now() - this.openTime >= this.recoveryTimeout) {
        this.state = State.HALF_OPEN;
        return false;
      }
      return true;
    }
    return false;
  }

  get stateName(): string {
    return State[this.state];
  }

  recordSuccess(): void {
    this.state = State.CLOSED;
    this.failureCount = 0;
  }

  recordFailure(): void {
    this.failureCount++;
    if (this.state === State.HALF_OPEN || this.failureCount >= this.threshold) {
      this.state = State.OPEN;
      this.openTime = Date.now();
    }
  }
}
