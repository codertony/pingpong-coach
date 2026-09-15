/**
 * requestId 短时在途去重与已完成响应复用。
 *
 * 方案第 9.5 节：
 * - 使用 requestId 做短时在途去重及已完成响应复用。
 * - 首版不自动重试模型超时，避免重复费用与陈旧播报。
 * - 进程重启后的持久幂等可在 P2 配合数据库实现。
 *
 * 同时保证：**每个会话最多一个模型请求在途**。
 */

import type { CoachFeedback } from "@pingpong/contracts";

interface Entry {
  feedback: CoachFeedback;
  storedAt: number;
}

export class RequestDedupe {
  private readonly ttlMs: number;
  private readonly completed = new Map<string, Entry>();
  /** 会话 → 在途 requestId，保证每会话最多一个在途请求 */
  private readonly inFlight = new Map<string, string>();
  /** 在途 requestId → 等待中的 Promise */
  private readonly pending = new Map<string, Promise<CoachFeedback>>();

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /** 取已完成的复用结果；过期则清理并返回 null。 */
  getCompleted(requestId: string): CoachFeedback | null {
    const hit = this.completed.get(requestId);
    if (!hit) return null;
    if (Date.now() - hit.storedAt > this.ttlMs) {
      this.completed.delete(requestId);
      return null;
    }
    return hit.feedback;
  }

  /** 同 requestId 是否有在途请求。 */
  getInFlight(requestId: string): Promise<CoachFeedback> | null {
    return this.pending.get(requestId) ?? null;
  }

  /** 该会话当前是否有在途请求。 */
  hasSessionInFlight(sessionId: string): boolean {
    return this.inFlight.has(sessionId);
  }

  begin(sessionId: string, requestId: string, task: Promise<CoachFeedback>): Promise<CoachFeedback> {
    this.inFlight.set(sessionId, requestId);
    this.pending.set(requestId, task);
    return task;
  }

  finish(sessionId: string, requestId: string, feedback: CoachFeedback): void {
    this.completed.set(requestId, { feedback, storedAt: Date.now() });
    this.inFlight.delete(sessionId);
    this.pending.delete(requestId);
    this.sweep();
  }

  fail(sessionId: string, requestId: string): void {
    this.inFlight.delete(sessionId);
    this.pending.delete(requestId);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.completed) {
      if (now - entry.storedAt > this.ttlMs) this.completed.delete(id);
    }
  }

  get size(): { completed: number; inFlight: number } {
    return { completed: this.completed.size, inFlight: this.inFlight.size };
  }
}
