/**
 * requestId 去重与「每会话最多一个在途请求」测试。
 *
 * 这层保护的是钱和体验：
 * - 去重防止同一个分组重复计费；
 * - 会话串行防止用户狂点导致多个模型请求同时飞出去；
 * - TTL 防止陈旧结论被当成新结论播报。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CoachFeedback } from "@pingpong/contracts";
import { RequestDedupe } from "../src/coach/dedupe.js";

function makeFeedback(overrides: Partial<CoachFeedback> = {}): CoachFeedback {
  return {
    schemaVersion: "1",
    requestId: "req-1",
    sessionId: "sess-1",
    groupId: "group-1",
    focusId: "return_to_ready_zone",
    status: "observation_only",
    observation: "观察",
    evidenceRefs: [],
    cue: null,
    nextDrillId: null,
    limitations: [],
    modelId: "mock-coach",
    mock: true,
    serverElapsedMs: 1,
    rejectedClaims: [],
    createdAtMonoMs: 1,
    ...overrides,
  };
}

describe("RequestDedupe", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("未记录过的 requestId 取不到已完成结果", () => {
    const d = new RequestDedupe(1000);
    expect(d.getCompleted("nope")).toBeNull();
  });

  it("finish 之后同一 requestId 能取回同一份反馈（响应复用）", () => {
    const d = new RequestDedupe(1000);
    const fb = makeFeedback();
    d.begin("sess-1", "req-1", Promise.resolve(fb));
    d.finish("sess-1", "req-1", fb);
    expect(d.getCompleted("req-1")).toBe(fb);
  });

  it("超过 TTL 后已完成结果被清除，不会拿旧结论冒充新结论", () => {
    const d = new RequestDedupe(1000);
    const fb = makeFeedback();
    d.begin("sess-1", "req-1", Promise.resolve(fb));
    d.finish("sess-1", "req-1", fb);
    expect(d.getCompleted("req-1")).toBe(fb);

    vi.advanceTimersByTime(1001);
    // 关键：过期后必须取不到，否则用户会看到几分钟前的陈旧反馈。
    expect(d.getCompleted("req-1")).toBeNull();
  });

  it("在途请求能被同 requestId 查询到（用于并发合并）", () => {
    const d = new RequestDedupe(1000);
    const p = new Promise<CoachFeedback>(() => {});
    d.begin("sess-1", "req-1", p);
    expect(d.getInFlight("req-1")).toBe(p);
  });

  it("未开始的 requestId 查不到在途请求", () => {
    const d = new RequestDedupe(1000);
    expect(d.getInFlight("req-1")).toBeNull();
  });

  it("会话在途标记：begin 后为 true，finish 后为 false", () => {
    const d = new RequestDedupe(1000);
    const p = new Promise<CoachFeedback>(() => {});
    expect(d.hasSessionInFlight("sess-1")).toBe(false);
    d.begin("sess-1", "req-1", p);
    expect(d.hasSessionInFlight("sess-1")).toBe(true);
    d.finish("sess-1", "req-1", makeFeedback());
    expect(d.hasSessionInFlight("sess-1")).toBe(false);
  });

  it("fail 也释放会话在途标记（失败不能永久锁死会话）", () => {
    const d = new RequestDedupe(1000);
    d.begin("sess-1", "req-1", new Promise<CoachFeedback>(() => {}));
    d.fail("sess-1", "req-1");
    // 若不释放，这个会话之后的所有分析都会被 409 拒掉。
    expect(d.hasSessionInFlight("sess-1")).toBe(false);
    expect(d.getInFlight("req-1")).toBeNull();
  });

  it("失败不会写入已完成缓存（避免缓存住一次失败）", () => {
    const d = new RequestDedupe(1000);
    d.begin("sess-1", "req-1", new Promise<CoachFeedback>(() => {}));
    d.fail("sess-1", "req-1");
    expect(d.getCompleted("req-1")).toBeNull();
  });

  it("不同会话互不影响在途状态", () => {
    const d = new RequestDedupe(1000);
    d.begin("sess-1", "req-1", new Promise<CoachFeedback>(() => {}));
    expect(d.hasSessionInFlight("sess-1")).toBe(true);
    expect(d.hasSessionInFlight("sess-2")).toBe(false);
  });

  it("size 如实反映当前缓存与在途数量", () => {
    const d = new RequestDedupe(10_000);
    expect(d.size).toEqual({ completed: 0, inFlight: 0 });
    d.begin("sess-1", "req-1", new Promise<CoachFeedback>(() => {}));
    expect(d.size).toEqual({ completed: 0, inFlight: 1 });
    d.finish("sess-1", "req-1", makeFeedback());
    expect(d.size).toEqual({ completed: 1, inFlight: 0 });
  });

  it("同一会话换新 requestId 时旧在途记录被覆盖（不会被永久占住）", () => {
    const d = new RequestDedupe(10_000);
    d.begin("sess-1", "req-1", new Promise<CoachFeedback>(() => {}));
    d.begin("sess-1", "req-2", new Promise<CoachFeedback>(() => {}));
    // inFlight 是 会话→requestId 映射，同会话只保留最新一个。
    expect(d.size.inFlight).toBe(1);
    expect(d.hasSessionInFlight("sess-1")).toBe(true);
  });
});
