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

  it("最多返回 6 张（初始预算）", () => {
    const picked = selectRepresentativeFrames(
      { startMs: 0, endMs: 950, anchor: { timeMs: 500 }, evidenceFrameIds: allIds },
      candidates,
    );
    expect(picked.length).toBeLessThanOrEqual(6);
    expect(picked.length).toBeGreaterThan(0);
  });

  it("覆盖引拍、向前挥拍与还原三个阶段", () => {
    const picked = selectRepresentativeFrames(
      { startMs: 0, endMs: 950, anchor: { timeMs: 500 }, evidenceFrameIds: allIds },
      candidates,
    );
    const roles = new Set(picked.map((p) => p.role));
    expect(roles.has("backswing")).toBe(true);
    expect(roles.has("forward")).toBe(true);
    expect(roles.has("return")).toBe(true);
  });

  it("不重复选择同一帧", () => {
    const picked = selectRepresentativeFrames(
      { startMs: 0, endMs: 950, anchor: { timeMs: 500 }, evidenceFrameIds: allIds },
      candidates,
    );
    const ids = picked.map((p) => p.frameId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("所选帧都落在挥拍时间区间内", () => {
    const picked = selectRepresentativeFrames(
      { startMs: 200, endMs: 600, anchor: { timeMs: 400 }, evidenceFrameIds: allIds },
      candidates,
    );
    for (const p of picked) {
      const c = candidates.find((x) => x.frameId === p.frameId)!;
      expect(c.sourceTimeMs).toBeGreaterThanOrEqual(200);
      expect(c.sourceTimeMs).toBeLessThanOrEqual(600);
    }
  });

  it("区间内没有候选时返回空", () => {
    const picked = selectRepresentativeFrames(
      { startMs: 5000, endMs: 6000, anchor: { timeMs: 5500 }, evidenceFrameIds: allIds },
      candidates,
    );
    expect(picked).toEqual([]);
  });

  it("endMs 为 null（未闭合）时仍能选出帧", () => {
    const picked = selectRepresentativeFrames(
      { startMs: 0, endMs: null, anchor: { timeMs: 300 }, evidenceFrameIds: allIds },
      candidates,
    );
    expect(picked.length).toBeGreaterThan(0);
  });

  it("**只从这一板的证据帧里挑**（契约要求与 evidenceFrameIds 对齐，F-029）", () => {
    // 只给前 5 个 id 资格。时间窗覆盖全部 20 个，但资格只有 5 个 ——
    // 若实现退化成"只看时间窗"，就会挑中没资格的帧。
    const allowed = candidates.slice(0, 5).map((c) => c.frameId);
    const picked = selectRepresentativeFrames(
      { startMs: 0, endMs: 950, anchor: { timeMs: 500 }, evidenceFrameIds: allowed },
      candidates,
    );
    expect(picked.length).toBeGreaterThan(0);
    for (const p of picked) {
      expect(allowed, `选中了 ${p.frameId}，但它不在这板的证据帧里`).toContain(p.frameId);
    }
  });

  it("一个资格帧都没有时返回空，**不退回**到只看时间窗", () => {
    const picked = selectRepresentativeFrames(
      { startMs: 0, endMs: 950, anchor: { timeMs: 500 }, evidenceFrameIds: [] },
      candidates,
    );
    expect(picked).toEqual([]);
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
