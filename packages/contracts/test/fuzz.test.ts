/**
 * 契约模糊测试（roadmap A3 的一部分）。
 *
 * 目的：zod 的 `safeParse` 对**任意**畸形输入都必须安全返回
 * `{ success: false }`，绝不 throw。今天这些 schema 都是纯 `z.object` /
 * `z.enum` / `z.number().finite()`，没有会抛错的 `.refine` 回调，所以这条
 * 测试是「金丝雀」——防的是未来有人往 schema 里塞带副作用或会抛错的校验器。
 *
 * 测试纪律：这里只验证「不崩溃」，不验证具体 reject 了哪个字段
 * （那属于 contracts.test.ts 的职责）。PRNG 用固定种子，保证可复现。
 */

import { describe, expect, it } from "vitest";
import { evidencePacketSchema } from "../src/index.js";

/** mulberry32 —— 确定性 PRNG，固定种子让失败可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = [
  "schemaVersion",
  "requestId",
  "sessionId",
  "groupId",
  "focusId",
  "strokeType",
  "handedness",
  "cameraView",
  "strokes",
  "perStrokeFeatures",
  "features",
  "keyframes",
  "ruleVersion",
  "referenceId",
  "criterion",
  "limitations",
  "readyZone",
];

function randomPrimitive(rng: () => number): unknown {
  const roll = rng();
  if (roll < 0.15) return null;
  if (roll < 0.3) return undefined;
  if (roll < 0.45) return rng() < 0.5;
  if (roll < 0.6) return Math.floor(rng() * 1_000_000);
  if (roll < 0.7) return rng() * 1_000_000 - 500_000;
  if (roll < 0.78) return Number.NaN;
  if (roll < 0.86) return Number.POSITIVE_INFINITY;
  if (roll < 0.9)
    return Math.random()
      .toString(36)
      .slice(2, 2 + Math.floor(rng() * 12));
  return Symbol.toStringTag; // 非 JSON 值：确保 safeParse 也不会因它崩溃
}

function randomValue(rng: () => number, depth = 0): unknown {
  if (depth > 4 || rng() < 0.4) return randomPrimitive(rng);
  if (rng() < 0.5) {
    // 数组
    const len = Math.floor(rng() * 6);
    return Array.from({ length: len }, () => randomValue(rng, depth + 1));
  }
  // 对象
  const obj: Record<string, unknown> = {};
  const n = Math.floor(rng() * 6);
  for (let i = 0; i < n; i++) {
    obj[KEYS[Math.floor(rng() * KEYS.length)] ?? `k${i}`] = randomValue(rng, depth + 1);
  }
  return obj;
}

/** 一个最小合法证据包，用于「逐字段污染」式变异。 */
function validPacket() {
  return {
    schemaVersion: "1",
    requestId: "req-1",
    sessionId: "sess-1",
    groupId: "grp-1",
    focusId: "return_to_ready_zone",
    strokeType: "forehand_drive",
    handedness: "right",
    cameraView: "front",
    perStrokeFeatures: [{ strokeId: "st-1", features: [] }],
    strokes: [
      {
        strokeId: "st-1",
        startMs: 0,
        endMs: 1000,
        anchor: { type: "wrist_speed_peak", timeMs: 400 },
        impactTimeMs: null,
        complete: true,
        phaseEvents: [],
        evidenceFrameIds: ["f-1"],
        reasons: [],
      },
    ],
    features: [
      {
        id: "return_after_wrist_peak_ms",
        value: 420,
        unit: "ms",
        coordinateSpace: "image_2d",
        intervalMs: [400, 820],
        quality: "usable",
        reasonIfMissing: null,
      },
    ],
    keyframes: [
      {
        id: "kf-1",
        sourceTimeMs: 400,
        jpegBase64: "AAAA",
        frameId: "f-1",
        width: 960,
        height: 540,
        role: "forward",
      },
    ],
    ruleVersion: "1.0.0",
    referenceId: null,
    criterion: null,
    limitations: ["单目二维"],
    readyZone: { xPx: 640, yPx: 400, radiusPx: 80 },
  };
}

describe("evidencePacketSchema 模糊测试：任意输入不抛异常", () => {
  it("纯随机垃圾永不 throw，safeParse 稳定返回结果", () => {
    const rng = mulberry32(0xdead_beef);
    for (let i = 0; i < 2_000; i++) {
      const junk = randomValue(rng);
      let result: { success: boolean } | null = null;
      expect(() => {
        result = evidencePacketSchema.safeParse(junk);
      }).not.toThrow();
      // safeParse 要么成功、要么带 error 地失败，不存在第三种状态。
      expect(result).not.toBeNull();
    }
  });

  it("逐字段污染合法包，也绝不 throw", () => {
    const rng = mulberry32(0x1234_5678);
    const base = validPacket();
    for (let i = 0; i < 2_000; i++) {
      const key = KEYS[Math.floor(rng() * KEYS.length)]!;
      const mutated: Record<string, unknown> = { ...base, [key]: randomValue(rng, 1) };
      expect(() => {
        evidencePacketSchema.safeParse(mutated);
      }).not.toThrow();
    }
  });

  it("删除单个字段不 throw", () => {
    const base = validPacket();
    for (const key of KEYS) {
      const mutated = { ...base } as Record<string, unknown>;
      delete mutated[key];
      expect(() => {
        evidencePacketSchema.safeParse(mutated);
      }).not.toThrow();
    }
  });
});
