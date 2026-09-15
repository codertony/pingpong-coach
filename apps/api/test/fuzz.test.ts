/**
 * API 模糊测试（roadmap A3）。
 *
 * 目的：任意畸形请求体打到 `POST /api/coach/analyze`，**绝不返回 500**。
 * 畸形输入应当被契约校验拦成 400（或偶尔 413 / 200），而不是把内部异常
 * 漏给调用方。这条测试防的是 `analyze()` 里新增的、会因畸形数据抛错的逻辑。
 *
 * 与 contracts/test/fuzz.test.ts 的分工：那边验证 zod schema 本身不抛，
 * 这边验证「schema 之后」的编排层（知识选择 / 去重 / prompt / 校验）也不抛。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { makeConfig, makePacket } from "./fixtures.js";

/** mulberry32 —— 确定性 PRNG。 */
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
  "features",
  "keyframes",
  "ruleVersion",
  "referenceId",
  "limitations",
  "readyZone",
];

/** 只生成 JSON 安全的随机值（HTTP 层收不到 undefined / Symbol / NaN）。 */
function jsonRandom(rng: () => number, depth = 0): unknown {
  if (depth > 4 || rng() < 0.4) {
    const roll = rng();
    if (roll < 0.2) return null;
    if (roll < 0.4) return rng() < 0.5;
    if (roll < 0.6) return Math.floor(rng() * 1_000_000);
    if (roll < 0.8) return rng() * 1_000_000 - 500_000;
    return Math.random()
      .toString(36)
      .slice(2, 2 + Math.floor(rng() * 12));
  }
  if (rng() < 0.5) {
    return Array.from({ length: Math.floor(rng() * 6) }, () => jsonRandom(rng, depth + 1));
  }
  const obj: Record<string, unknown> = {};
  const n = Math.floor(rng() * 6);
  for (let i = 0; i < n; i++) {
    obj[KEYS[Math.floor(rng() * KEYS.length)] ?? `k${i}`] = jsonRandom(rng, depth + 1);
  }
  return obj;
}

let app: FastifyInstance | null = null;

beforeAll(async () => {
  app = await buildServer({ config: makeConfig() });
});

afterAll(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("POST /api/coach/analyze 模糊测试：畸形输入绝不 500", () => {
  it("纯随机垃圾请求体", async () => {
    const rng = mulberry32(0x0bad_f00d);
    for (let i = 0; i < 300; i++) {
      const payload = jsonRandom(rng);
      const res = await app!.inject({
        method: "POST",
        url: "/api/coach/analyze",
        payload: payload as Record<string, unknown>,
      });
      expect(res.statusCode, `第 ${i} 个畸形体返回了 500`).not.toBe(500);
      // 必须是受控响应（<500），且响应体是合法 JSON。
      // 注意：对无法解析为 JSON 的原始字符串，Fastify 用自己的 400 错误
      // `{statusCode,error,message}` 拦截，不走本应用的 `{ok,...}` 形状——仍属受控。
      expect(res.statusCode).toBeLessThan(500);
      expect(() => res.json()).not.toThrow();
    }
  });

  it("逐字段污染合法包，绝不 500", async () => {
    const rng = mulberry32(0xc0ffee_11);
    const base = makePacket();
    for (let i = 0; i < 300; i++) {
      const key = KEYS[Math.floor(rng() * KEYS.length)]!;
      const mutated: Record<string, unknown> = { ...base, [key]: jsonRandom(rng, 1) };
      const res = await app!.inject({
        method: "POST",
        url: "/api/coach/analyze",
        payload: mutated,
      });
      expect(res.statusCode, `污染字段 ${key} 时返回了 500`).not.toBe(500);
      expect(res.statusCode).toBeLessThan(500);
    }
  });

  it("删除单个字段，绝不 500", async () => {
    const base = makePacket() as unknown as Record<string, unknown>;
    for (const key of KEYS) {
      const mutated = { ...base };
      delete mutated[key];
      const res = await app!.inject({
        method: "POST",
        url: "/api/coach/analyze",
        payload: mutated,
      });
      expect(res.statusCode, `删除字段 ${key} 时返回了 500`).not.toBe(500);
    }
  });
});
