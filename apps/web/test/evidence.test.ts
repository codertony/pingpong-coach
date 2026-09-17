import { describe, expect, it, vi } from "vitest";
import {
  KeyframeCache,
  bytesToBase64,
  selectRepresentativeFrames,
} from "../src/evidence/evidence-builder.js";

function makeBytes(size: number): Uint8Array {
  return new Uint8Array(size);
}

describe("KeyframeCache（有界缓存）", () => {
  it("在预算内正常保存", () => {
    const cache = new KeyframeCache(1000);
    cache.add({
      frameId: "a",
      sourceTimeMs: 0,
      bytes: makeBytes(400),
      width: 100,
      height: 100,
      pinned: false,
    });
    cache.add({
      frameId: "b",
      sourceTimeMs: 40,
      bytes: makeBytes(400),
      width: 100,
      height: 100,
      pinned: false,
    });
    expect(cache.size).toBe(2);
    expect(cache.usedBytes).toBe(800);
  });

  it("超出预算时淘汰未保留的最旧候选", () => {
    const cache = new KeyframeCache(1000);
    cache.add({
      frameId: "a",
      sourceTimeMs: 0,
      bytes: makeBytes(600),
      width: 100,
      height: 100,
      pinned: false,
    });
    cache.add({
      frameId: "b",
      sourceTimeMs: 40,
      bytes: makeBytes(600),
      width: 100,
      height: 100,
      pinned: false,
    });
    // 总量 1200 > 1000，最旧的 a 应被淘汰
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.usedBytes).toBe(600);
  });

  it("用户主动保留的候选不会被自动淘汰", () => {
    const cache = new KeyframeCache(1000);
    cache.add({
      frameId: "keep",
      sourceTimeMs: 0,
      bytes: makeBytes(600),
      width: 100,
      height: 100,
      pinned: false,
    });
    cache.pin("keep");
    cache.add({
      frameId: "b",
      sourceTimeMs: 40,
      bytes: makeBytes(600),
      width: 100,
      height: 100,
      pinned: false,
    });
    // keep 被 pin，因此淘汰的是 b，即使 b 更新
    expect(cache.get("keep")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("全部被 pin 时不淘汰，允许超预算而不是丢弃用户数据", () => {
    const cache = new KeyframeCache(500);
    cache.add({
      frameId: "a",
      sourceTimeMs: 0,
      bytes: makeBytes(400),
      width: 100,
      height: 100,
      pinned: true,
    });
    cache.add({
      frameId: "b",
      sourceTimeMs: 40,
      bytes: makeBytes(400),
      width: 100,
      height: 100,
      pinned: true,
    });
    expect(cache.size).toBe(2);
  });

  it("clear 释放全部缓存", () => {
    const cache = new KeyframeCache(10000);
    cache.add({
      frameId: "a",
      sourceTimeMs: 0,
      bytes: makeBytes(100),
      width: 1,
      height: 1,
      pinned: false,
    });
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.usedBytes).toBe(0);
  });
});

/**
 * 选帧：**先定事件，再选图**（R4 / 评审 §6.2）。
 *
 * 旧实现按**区间时间比例**挑（引拍那张 = 起点到锚点的中点……），
 * 名字像事件、实则只是比例位置。这些用例守的是新语义：每张图都锚在
 * **检出的阶段转变**上，偏了多少毫秒是算出来的，配不上就报缺失。
 */
describe("selectRepresentativeFrames", () => {
  const candidates = Array.from({ length: 20 }, (_, i) => ({
    frameId: `f${i}`,
    sourceTimeMs: i * 50,
    bytes: makeBytes(10),
    width: 100,
    height: 100,
    pinned: false,
  }));
  /** 全部候选的 id —— 这些用例测的是"挑哪几张"，不是"有没有资格当关键帧"，
   *  所以把资格给全，保持挑选结果不变。对齐约束另有专门的用例。 */
  const allIds = candidates.map((c) => c.frameId);

  /**
   * 一板标准的正手：四个事件，支撑帧就落在各自的时刻上。
   * 锚点 450ms 落在「前挥」窗 [400, 600) 里。
   */
  const event = (
    eventType: "backswing_start" | "forward_start" | "return_start" | "stroke_closed",
    timeMs: number,
    supportFrameIds: string[],
  ) => ({ eventType, timeMs, supportFrameIds });
  const stroke = (over: Partial<Parameters<typeof selectRepresentativeFrames>[0]> = {}) => ({
    strokeId: "st-1",
    startMs: 0,
    endMs: 950,
    anchor: { timeMs: 450 },
    evidenceFrameIds: allIds,
    phaseEvents: [
      event("backswing_start", 200, ["f4"]),
      event("forward_start", 400, ["f8"]),
      event("return_start", 600, ["f12"]),
      event("stroke_closed", 900, ["f18"]),
    ],
    ...over,
  });

  it("**每个事件各挑一张**，角色由事件类型推出", () => {
    const { picks, eventMisses } = selectRepresentativeFrames(stroke(), candidates);
    expect(eventMisses).toEqual([]);
    // 四个事件帧 + 一张腕速峰值帧
    expect(picks).toHaveLength(5);
    expect(new Set(picks.map((p) => p.role))).toEqual(
      new Set(["backswing", "forward", "return", "ready"]),
    );
  });

  it("事件帧就取在**转变时刻**上：偏移恒为 0，帧就是支撑帧", () => {
    const { picks } = selectRepresentativeFrames(stroke(), candidates);
    const byRole = new Map(picks.map((p) => [p.role, p]));
    // 每个角色至少有一张偏移 0 的（ready 只有闭合事件那一张）
    const roles = ["backswing", "forward", "return", "ready"] as const;
    for (const role of roles) {
      expect(byRole.get(role), `${role} 没有挑出图`).toBeDefined();
    }
    // 引拍/还原/闭合这三张只可能来自事件（没有别的来源）→ 偏移必须是 0
    expect(byRole.get("backswing")!.eventTimeOffsetMs).toBe(0);
    expect(byRole.get("return")!.eventTimeOffsetMs).toBe(0);
    expect(byRole.get("ready")!.eventTimeOffsetMs).toBe(0);
    expect(byRole.get("backswing")!.frameId).toBe("f4");
    expect(byRole.get("ready")!.frameId).toBe("f18");
  });

  it("腕速峰值那张**按它真实所在的相位**定角色，偏移 > 0", () => {
    const { picks } = selectRepresentativeFrames(stroke(), candidates);
    const peak = picks.find((p) => p.eventTimeOffsetMs > 0);
    expect(peak, "应该有且只有一张相位内的峰值帧").toBeDefined();
    // 锚点在 450ms，前挥从 400ms 起 ⇒ 偏移 +50
    expect(peak!.role).toBe("forward");
    expect(peak!.eventTimeOffsetMs).toBe(50);
    expect(peak!.sourceTimeMs).toBe(450);
    // 同一角色里偏移 0 的那张才是「恰在转变时刻」，两者不能混为一谈
    const atEvent = picks.filter((p) => p.role === "forward" && p.eventTimeOffsetMs === 0);
    expect(atEvent).toHaveLength(1);
    expect(atEvent[0]!.frameId).toBe("f8");
  });

  it("支撑帧**没采到图**时退到该事件窗内最近的一张（图片是每 3 帧一张，常事）", () => {
    // 前挥的支撑帧给一个不存在的 id；窗 [400, 600) 内有 f8(400)/f9(450)…
    const { picks, eventMisses } = selectRepresentativeFrames(
      stroke({
        phaseEvents: [
          event("backswing_start", 200, ["f4"]),
          event("forward_start", 400, ["f_没采到"]),
          event("return_start", 600, ["f12"]),
          event("stroke_closed", 900, ["f18"]),
        ],
      }),
      candidates,
    );
    // 退到窗内最近的一张，而不是报缺失
    const forwardAtEvent = picks.filter((p) => p.role === "forward" && p.eventTimeOffsetMs === 0);
    expect(forwardAtEvent).toHaveLength(1);
    expect(forwardAtEvent[0]!.frameId).toBe("f8"); // 窗内离 400 最近
    expect(eventMisses).toEqual([]);
  });

  it("事件窗是**半开**的：边界那一帧只属于后一个事件，不被前一个抢走", () => {
    // 只留 f4(200) 与 f8(400) 两张图。引拍窗是 [200, 400) ——
    // f8 恰在 400ms 上，属于「前挥」那一窗，引拍不该拿走它。
    const sparse = candidates.filter((c) => c.frameId === "f4" || c.frameId === "f8");
    const { picks, eventMisses } = selectRepresentativeFrames(
      stroke({
        evidenceFrameIds: ["f4", "f8"],
        // 引拍支撑帧故意给没采到的，逼它去窗内找
        phaseEvents: [
          event("backswing_start", 200, ["f_没采到"]),
          event("forward_start", 400, ["f8"]),
          event("return_start", 600, []),
          event("stroke_closed", 900, []),
        ],
      }),
      sparse,
    );
    const backswing = picks.find((p) => p.role === "backswing");
    expect(backswing!.frameId, "边界帧 400 被引拍窗抢走了 —— 窗口不是半开的").toBe("f4");
    // 前挥拿到的正是 400 那一张
    expect(picks.find((p) => p.role === "forward" && p.eventTimeOffsetMs === 0)!.frameId).toBe(
      "f8",
    );
    // 还原与闭合两窗内一张图都没有 → 必须**报缺失**，不能借别的窗的图
    expect(eventMisses.map((m) => m.eventType)).toEqual(["return_start", "stroke_closed"]);
  });

  it("窗内一张图都没有 → **报缺失**，不从别的窗或别的板借图", () => {
    // 两个事件落在同一时刻（契约只要求事件时间递增是 `>=`）：第一个事件的窗
    // `[200, 200)` 是空的。此时别的窗里**有的是图**，一张都不许借过来 ——
    // 借来的图会挂着一个它并不代表的阶段名，比缺一张更糟。
    const { picks, eventMisses } = selectRepresentativeFrames(
      stroke({
        phaseEvents: [event("backswing_start", 200, []), event("forward_start", 200, ["f4"])],
      }),
      candidates,
    );
    expect(eventMisses.map((m) => m.eventType)).toEqual(["backswing_start"]);
    expect(picks.some((p) => p.role === "backswing")).toBe(false);
  });

  it("**只从这一板的证据帧里挑**（契约要求与 evidenceFrameIds 对齐，F-029）", () => {
    // 只给前 5 个 id 资格。时间窗覆盖全部 20 个，但资格只有 5 个 ——
    // 若实现退化成"只看时间窗"，就会挑中没资格的帧。
    const allowed = candidates.slice(0, 5).map((c) => c.frameId);
    const { picks } = selectRepresentativeFrames(
      stroke({ evidenceFrameIds: allowed, phaseEvents: [event("backswing_start", 100, [])] }),
      candidates,
    );
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) {
      expect(allowed, `选中了 ${p.frameId}，但它不在这板的证据帧里`).toContain(p.frameId);
    }
  });

  it("一个资格帧都没有时返回空，**不退回**到只看时间窗", () => {
    const { picks } = selectRepresentativeFrames(stroke({ evidenceFrameIds: [] }), candidates);
    expect(picks).toEqual([]);
  });

  it("**一帧不重复**：峰值与 `forward_start` 是同一帧时只发一张", () => {
    // 锚点正好落在 forward_start 那一刻 ⇒ 事件帧与峰值帧抢同一张图
    const { picks } = selectRepresentativeFrames(stroke({ anchor: { timeMs: 400 } }), candidates);
    const ids = picks.map((p) => p.frameId);
    expect(new Set(ids).size, `挑出了重复帧：${ids.join(",")}`).toBe(ids.length);
  });

  it("峰值**早于全部事件**（还在准备区驻留）时不发那一张", () => {
    // 仓库自己的合成用例就是这种：准备区里速度最大，此后一路匀速。
    // 那是一张静止的准备位图，而且会让 role=ready 同时表示「闭合」与「起始驻留」。
    const { picks, eventMisses } = selectRepresentativeFrames(
      stroke({ anchor: { timeMs: 50 } }),
      candidates,
    );
    expect(eventMisses).toEqual([]);
    // 只剩四个事件帧
    expect(picks).toHaveLength(4);
    expect(picks.every((p) => p.eventTimeOffsetMs === 0)).toBe(true);
    expect(picks.some((p) => p.frameId === "f1")).toBe(false);
  });

  it("**没有阶段事件**时不回退到比例挑法，只报一条缺失", () => {
    // 产品里到不了这里（只有 complete 挥拍才有图，而 complete 必有 stroke_closed），
    // 但"走不到的分支"也不许偷偷编一张图出来。
    const { picks, eventMisses } = selectRepresentativeFrames(
      stroke({ phaseEvents: [] }),
      candidates,
    );
    expect(picks).toEqual([]);
    expect(eventMisses).toHaveLength(1);
  });

  it("返回的是**时间序**（提示词里读下去就是一条动作时间线）", () => {
    const { picks } = selectRepresentativeFrames(stroke(), candidates);
    const times = picks.map((p) => p.sourceTimeMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("所选帧都落在挥拍时间区间内", () => {
    const { picks } = selectRepresentativeFrames(
      stroke({ startMs: 200, endMs: 600, anchor: { timeMs: 400 }, evidenceFrameIds: allIds }),
      candidates,
    );
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) {
      const c = candidates.find((x) => x.frameId === p.frameId)!;
      expect(c.sourceTimeMs).toBeGreaterThanOrEqual(200);
      expect(c.sourceTimeMs).toBeLessThanOrEqual(600);
    }
  });

  it("endMs 为 null（未闭合）时仍能选出帧", () => {
    const { picks } = selectRepresentativeFrames(
      stroke({ endMs: null, phaseEvents: [event("backswing_start", 200, ["f4"])] }),
      candidates,
    );
    expect(picks.length).toBeGreaterThan(0);
  });

  it("阶段转变多于图片预算时（拉锯的一板），先丢**同类相位的重复**而不是截尾", () => {
    // 实测素材里出现过一板 7 条转变（引拍→前挥→还原→又引拍→前挥→还原→闭合）。
    // 按时间截尾会把「有没有还原」整段丢光。
    const sawtooth = [
      event("backswing_start", 100, ["f2"]),
      event("forward_start", 200, ["f4"]),
      event("return_start", 300, ["f6"]),
      event("backswing_start", 400, ["f8"]),
      event("forward_start", 500, ["f10"]),
      event("return_start", 600, ["f12"]),
      event("stroke_closed", 900, ["f18"]),
    ];
    const { picks } = selectRepresentativeFrames(
      stroke({ phaseEvents: sawtooth, anchor: { timeMs: 250 } }),
      candidates,
    );
    expect(picks.length).toBeLessThanOrEqual(6);
    // 四个相位都还在（没有因为截尾丢掉 return / ready）
    expect(new Set(picks.map((p) => p.role))).toEqual(
      new Set(["backswing", "forward", "return", "ready"]),
    );
  });
});

describe("bytesToBase64", () => {
  it("正确编码小数据", () => {
    // "Hi" 的 base64 是 "SGk="
    expect(bytesToBase64(new Uint8Array([0x48, 0x69]))).toBe("SGk=");
  });

  it("能处理超过单次 fromCharCode 限额的数据", () => {
    const big = new Uint8Array(200_000).fill(65); // 全 'A'
    const encoded = bytesToBase64(big);
    expect(encoded.length).toBeGreaterThan(0);
    expect(() => atob(encoded)).not.toThrow();
    expect(atob(encoded).length).toBe(200_000);
  });
});

// 保持 vi 引用以避免未使用导入告警
void vi;
