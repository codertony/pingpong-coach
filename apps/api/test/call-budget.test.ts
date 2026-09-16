/**
 * 每会话模型调用预算的测试（`sessionModelCallsPer20Min`，见 F-027）。
 *
 * 它护的是**用户的钱**：真实模型按 token 计费，一次失控的循环可以无声烧钱。
 * 所以判据要严：窗口必须真的滑动、会话之间必须互不影响、配置写错时宁可严不要松。
 */

import { describe, expect, it } from "vitest";
import { SessionCallBudget } from "../src/coach/call-budget.js";

const MIN = 60_000;

describe("SessionCallBudget", () => {
  it("限额内放行，超了拒绝，并报出还要等多久", () => {
    const b = new SessionCallBudget(2);
    expect(b.tryConsume("s1", 0).allowed).toBe(true);
    expect(b.tryConsume("s1", 1000).allowed).toBe(true);

    const third = b.tryConsume("s1", 2000);
    expect(third.allowed).toBe(false);
    expect(third.limit).toBe(2);
    expect(third.used).toBe(2);
    // 最早那次（t=0）在 20 分钟后滑出窗口 ⇒ 还应等约 20 分钟
    expect(third.retryAfterMs).toBe(20 * MIN - 2000);
  });

  it("窗口**真的滑动**：最早那次滑出去之后就又有额度了", () => {
    const b = new SessionCallBudget(1);
    expect(b.tryConsume("s1", 0).allowed).toBe(true);
    expect(b.tryConsume("s1", 19 * MIN).allowed).toBe(false);
    // 20 分钟零 1 毫秒：第一次已经出窗
    expect(b.tryConsume("s1", 20 * MIN + 1).allowed).toBe(true);
  });

  it("会话之间互不影响", () => {
    const b = new SessionCallBudget(1);
    expect(b.tryConsume("s1", 0).allowed).toBe(true);
    expect(b.tryConsume("s2", 0).allowed).toBe(true);
    expect(b.tryConsume("s1", 1).allowed).toBe(false);
    expect(b.tryConsume("s2", 1).allowed).toBe(false);
  });

  it("peek 只看不记账（连查多次不会把额度吃掉）", () => {
    const b = new SessionCallBudget(1);
    for (let i = 0; i < 5; i++) expect(b.peek("s1", i).allowed).toBe(true);
    expect(b.tryConsume("s1", 10).allowed).toBe(true);
    expect(b.peek("s1", 11).allowed).toBe(false);
  });

  it("reset 清掉该会话的计数（重开一组不该被上一次拖住）", () => {
    const b = new SessionCallBudget(1);
    b.tryConsume("s1", 0);
    expect(b.peek("s1", 1).allowed).toBe(false);
    b.reset("s1");
    expect(b.tryConsume("s1", 2).allowed).toBe(true);
  });

  it("限额配成 0 / 负数 / NaN 时**收敛到 1**，而不是变成无限", () => {
    // 手滑写错配置不该静默放开花费 —— 宁可严一点。
    for (const bad of [0, -5, Number.NaN]) {
      const b = new SessionCallBudget(bad);
      expect(b.tryConsume("s", 0).allowed, `limit=${bad} 应当仍允许 1 次`).toBe(true);
      expect(b.tryConsume("s", 1).allowed, `limit=${bad} 不该放行第 2 次`).toBe(false);
    }
  });

  it("小数额度向下取整（不会因为 2.9 就放行 3 次）", () => {
    const b = new SessionCallBudget(2.9);
    expect(b.tryConsume("s", 0).allowed).toBe(true);
    expect(b.tryConsume("s", 1).allowed).toBe(true);
    expect(b.tryConsume("s", 2).allowed).toBe(false);
  });
});
