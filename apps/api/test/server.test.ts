import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig, type ServerConfig } from "../src/config.js";

const MOCK_CONFIG: ServerConfig = {
  ...loadConfig(),
  modelMode: "mock",
  modelId: "mock-coach",
  modelApiKey: "",
  modelBaseUrl: "",
  modelTimeoutMs: 4000,
  dedupeTtlMs: 5000,
};

const PACKET_BODY = {
  schemaVersion: "1",
  requestId: "req_e2e_1",
  sessionId: "sess_e2e",
  groupId: "grp_e2e",
  focusId: "return_to_ready_zone",
  strokeType: "forehand_drive",
  handedness: "right",
  cameraView: "front",
  strokes: [
    {
      strokeId: "st_1",
      startMs: 0,
      endMs: 1000,
      anchor: { type: "wrist_speed_peak", timeMs: 400 },
      impactTimeMs: null,
      complete: true,
      evidenceFrameIds: ["f_1"],
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
      id: "kf_1",
      sourceTimeMs: 400,
      jpegBase64: "AAAA",
      frameId: "f_1",
      width: 960,
      height: 540,
      role: "forward",
    },
  ],
  ruleVersion: "1.0.0",
  referenceId: null,
  criterion: {
    featureId: "return_after_wrist_peak_ms",
    threshold: 700,
    unit: "ms",
    minValidStrokes: 3,
  },
  limitations: ["单目二维，无法判断肌肉发力"],
  readyZone: { xPx: 640, yPx: 400, radiusPx: 80 },
};

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("GET /api/health", () => {
  it("返回服务状态并标明 mock 模式", async () => {
    app = await buildServer({ config: MOCK_CONFIG });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.modelMode).toBe("mock");
    expect(body.ruleVersion).toBeDefined();
    expect(body.nodeVersion).toMatch(/^v\d+/);
  });

  it("不泄露密钥字段", async () => {
    app = await buildServer({ config: MOCK_CONFIG });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    const text = res.body;
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("MODEL_API_KEY");
  });
});

describe("POST /api/coach/analyze", () => {
  it("合法证据包得到结构合法的反馈，且明确标记 mock", async () => {
    app = await buildServer({ config: MOCK_CONFIG });
    const res = await app.inject({
      method: "POST",
      url: "/api/coach/analyze",
      payload: PACKET_BODY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.feedback.mock).toBe(true);
    expect(body.feedback.modelId).toBe("mock-coach");
    // 无已审核参考 → 只能是观察
    expect(body.feedback.status).toBe("observation_only");
    // 证据引用必须落在本包内
    const known = new Set(["return_after_wrist_peak_ms", "kf_1", "st_1"]);
    for (const ref of body.feedback.evidenceRefs) {
      expect(known.has(ref)).toBe(true);
    }
  });

  it("契约校验失败返回 400 且带字段细节", async () => {
    app = await buildServer({ config: MOCK_CONFIG });
    const bad = { ...PACKET_BODY, strokeType: "backhand_drive" };
    const res = await app.inject({
      method: "POST",
      url: "/api/coach/analyze",
      payload: bad,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.details.length).toBeGreaterThan(0);
  });

  it("同 requestId 重复提交复用已完成结果", async () => {
    app = await buildServer({ config: MOCK_CONFIG });
    const first = await app.inject({
      method: "POST",
      url: "/api/coach/analyze",
      payload: PACKET_BODY,
    });
    expect(first.json().deduplicated).toBe(false);

    const second = await app.inject({
      method: "POST",
      url: "/api/coach/analyze",
      payload: PACKET_BODY,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().deduplicated).toBe(true);
    expect(second.json().feedback.requestId).toBe("req_e2e_1");
  });

  it("mock 输出不含发力类禁用语结论", async () => {
    app = await buildServer({ config: MOCK_CONFIG });
    const res = await app.inject({
      method: "POST",
      url: "/api/coach/analyze",
      payload: PACKET_BODY,
    });
    const fb = res.json().feedback;
    const all = `${fb.observation} ${fb.cue ?? ""}`;
    expect(all).not.toMatch(/肌肉(紧张|僵硬|发力)/);
    expect(all).not.toMatch(/足底承重/);
  });

  it("反馈携带限制说明，不把二维结果说成三维结论", async () => {
    app = await buildServer({ config: MOCK_CONFIG });
    const res = await app.inject({
      method: "POST",
      url: "/api/coach/analyze",
      payload: PACKET_BODY,
    });
    const fb = res.json().feedback;
    expect(fb.limitations.length).toBeGreaterThan(0);
    expect(fb.limitations.join(" ")).toContain("mock");
  });
});
