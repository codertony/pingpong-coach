/**
 * 每个会话的**模型调用预算**（`configs/thresholds.json` 的
 * `budgets.sessionModelCallsPer20Min`）。
 *
 * ## 为什么要有它
 *
 * 真实模型**按 token 计费**。这个预算早在配置文件里就声明了（60 次 / 20 分钟），
 * 但**代码里没有任何地方读它** —— 是 F-027 记下的"看起来像开关、改了不生效"之一。
 * 现在把它实现出来，理由是它护的是**用户的钱**：一次失控的循环（或用户把
 * 「每组几次」设得极小）本可以无声地烧掉大量调用。
 *
 * ## 语义（刻意选保守的那一种）
 *
 * - **滑动窗口**，不是固定桶：任意 20 分钟内的调用数不超过 N。
 * - 只统计**真正发起的模型调用**；被去重命中、被输入校验拒绝的都不算。
 * - 超预算时**不阻塞本地链路**（红线 9）：服务端仍返回 200，
 *   但明确说明"本会话的模型调用已达上限"，前端据此保留本地反馈。
 * - **不自动重试、不排队**（红线 12）：超了就是超了，等窗口滑过去。
 */

/** 窗口长度：20 分钟。 */
const WINDOW_MS = 20 * 60 * 1000;

export interface BudgetDecision {
  allowed: boolean;
  /** 本窗口内**已经**用掉的次数（含本次，若放行） */
  used: number;
  /** 预算上限 */
  limit: number;
  /** 还要等多久才有额度（毫秒）；未超限时为 0。用于如实告知用户 */
  retryAfterMs: number;
}

export class SessionCallBudget {
  private readonly limit: number;
  /** 会话 → 已用时刻（毫秒，注入的时钟） */
  private readonly stamps = new Map<string, number[]>();

  constructor(limitPer20Min: number) {
    // 非正数视为"不限"是不对的 —— 那会让一个手滑的配置静默变成无限花费。
    // 这里取至少 1：配置写错时宁可严一点，也不要无声地放开。
    this.limit =
      Number.isFinite(limitPer20Min) && limitPer20Min >= 1 ? Math.floor(limitPer20Min) : 1;
  }

  /** 只看看还能不能用，**不记账**。 */
  peek(sessionId: string, nowMs: number): BudgetDecision {
    const kept = (this.stamps.get(sessionId) ?? []).filter((t) => nowMs - t < WINDOW_MS);
    const used = kept.length;
    if (used < this.limit) {
      return { allowed: true, used: used + 1, limit: this.limit, retryAfterMs: 0 };
    }
    // 最早的那次滑出窗口时就有额度了
    const oldest = kept[0] ?? nowMs;
    return {
      allowed: false,
      used,
      limit: this.limit,
      retryAfterMs: Math.max(0, WINDOW_MS - (nowMs - oldest)),
    };
  }

  /** 看看并记账（放行时）。返回是否允许。 */
  tryConsume(sessionId: string, nowMs: number): BudgetDecision {
    const decision = this.peek(sessionId, nowMs);
    if (!decision.allowed) return decision;

    const kept = (this.stamps.get(sessionId) ?? []).filter((t) => nowMs - t < WINDOW_MS);
    kept.push(nowMs);
    this.stamps.set(sessionId, kept);
    return decision;
  }

  /** 会话结束/重开时清掉它的计数。 */
  reset(sessionId: string): void {
    this.stamps.delete(sessionId);
  }
}
