/**
 * analyze 编排测试。
 *
 * analyze 是「安全门」真正落地的地方：输入校验、大小限制、去重、
 * 会话串行、以及模型失败时不 5xx。这些路径出错会直接影响用户体验和费用。
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { analyze } from "../src/coach/analyze.js";
import { RequestDedupe } from "../src/coach/dedupe.js";
import { makeConfig, makePacket, makeStroke } from "./fixtures.js";
import type { ServerConfig } from "../src/config.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deps(configOverrides: Partial<ServerConfig> = {}) {
  return {
    config: { ...makeConfig(), ...configOverrides } as ServerConfig,
    dedupe: new RequestDedupe(30_000),
  };
}

describe("analyze — 输入校验", () => {
  it("合法证据包返回 ok:true 与反馈", async () => {
    const res = await analyze(makePacket(), deps());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.feedback.status).toBe("observation_only");
      expect(res.deduplicated).toBe(false);
    }
  });

  it("非法证据包返回 400 + unsupported，并列出字段错误", async () => {
    const res = await analyze({ requestId: "x" }, deps());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("unsupported");
      expect(res.httpStatus).toBe(400);
      expect(res.details.length).toBeGreaterThan(0);
    }
  });

  it("证据包大小超限返回 413 + evidence_too_large", async () => {
    const res = await analyze(makePacket(), deps({ maxRequestBytes: 10 }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("evidence_too_large");
      expect(res.httpStatus).toBe(413);
    }
  });

  it("null 输入被安全拒绝而不是抛异常", async () => {
    const res = await analyze(null, deps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.httpStatus).toBe(400);
  });

  it("缺少 strokes 字段（空数组）依然通过契约（契约允许 0 次挥拍）", async () => {
    // 0 次挥拍时也**不能有关键帧**：关键帧必须属于某一板的证据帧
    // （契约的 `.refine`，见 F-029）。只清 strokes 会留下孤儿图片。
    const res = await analyze(makePacket({ strokes: [], keyframes: [] }), deps());
    expect(res.ok).toBe(true);
  });

  it("0 次挥拍却带着关键帧时被拒（孤儿图片没有归属的板）", async () => {
    const res = await analyze(makePacket({ strokes: [] }), deps());
    expect(res.ok, "没有挥拍却有图片，契约里的对齐约束应当拒绝它").toBe(false);
  });
});

describe("analyze — 去重与会话串行", () => {
  it("同一 requestId 第二次请求命中已完成缓存并标记 deduplicated", async () => {
    const d = deps();
    const first = await analyze(makePacket(), d);
    const second = await analyze(makePacket(), d);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.deduplicated).toBe(true);
      // 复用必须返回同一份反馈内容，不能重新算一遍。
      expect(second.feedback.observation).toBe(first.feedback.observation);
    }
  });

  it("换 requestId 后会重新分析，不命中去重", async () => {
    const d = deps();
    await analyze(makePacket({ requestId: "req-a" }), d);
    const second = await analyze(makePacket({ requestId: "req-b" }), d);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.deduplicated).toBe(false);
  });

  it("同一会话已有在途请求时返回 409，不排队", async () => {
    const d = deps();
    // 手工占住会话的在途槽位，模拟「第一个请求还没结束」。
    d.dedupe.begin("sess-1", "req-inflight", new Promise(() => {}));

    const res = await analyze(makePacket({ requestId: "req-2" }), d);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.httpStatus).toBe(409);
      expect(res.code).toBe("model_unavailable");
    }
  });

  it("同 requestId 在途时并发请求合并到同一个 Promise 结果", async () => {
    const d = deps();
    const fb = {
      schemaVersion: "1" as const,
      requestId: "req-1",
      sessionId: "sess-1",
      groupId: "group-1",
      focusId: "return_to_ready_zone",
      status: "observation_only" as const,
      observation: "合并结果",
      evidenceRefs: [],
      cue: null,
      nextDrillId: null,
      limitations: [],
      modelId: "mock-coach",
      mock: true,
      serverElapsedMs: 1,
      rejectedClaims: [],
      createdAtMonoMs: 1,
    };
    d.dedupe.begin("sess-1", "req-1", Promise.resolve(fb));

    const res = await analyze(makePacket(), d);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.deduplicated).toBe(true);
      expect(res.feedback.observation).toBe("合并结果");
    }
  });
});

describe("analyze — 模型失败不阻塞本地链路", () => {
  it("模型超时返回 ok:false 但 httpStatus 为 200（不是 5xx）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }),
    );

    const d = deps({
      modelMode: "live",
      modelBaseUrl: "https://x.invalid/v1",
      modelApiKey: "k",
      modelId: "m",
    });
    const res = await analyze(makePacket(), d);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("model_timeout");
      // 关键：模型失败不该让前端拿到 5xx，本地训练必须继续。
      expect(res.httpStatus).toBe(200);
    }
  });

  it("模型返回非法 JSON 时返回 model_invalid_json 且不播报", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "这不是 JSON" } }] }), {
            status: 200,
          }),
      ),
    );

    const d = deps({
      modelMode: "live",
      modelBaseUrl: "https://x.invalid/v1",
      modelApiKey: "k",
      modelId: "m",
    });
    const res = await analyze(makePacket(), d);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("model_invalid_json");
  });

  it("模型返回被 Markdown 代码块包裹的 JSON 也能被容错解析", async () => {
    const payload = JSON.stringify({
      status: "observation_only",
      observation: "包裹在代码块中的合法输出",
      evidenceRefs: ["return_after_wrist_peak_ms"],
      cue: null,
      nextDrillId: null,
      limitations: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "```json\n" + payload + "\n```" } }],
            }),
            { status: 200 },
          ),
      ),
    );

    const d = deps({
      modelMode: "live",
      modelBaseUrl: "https://x.invalid/v1",
      modelApiKey: "k",
      modelId: "m",
    });
    const res = await analyze(makePacket(), d);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.feedback.observation).toContain("包裹在代码块");
  });

  it("模型伪造不存在的 evidenceRefs 时拒绝播报", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      status: "observation_only",
                      observation: "引用了一个不存在的证据",
                      evidenceRefs: ["fake-id-999"],
                      cue: null,
                      nextDrillId: null,
                      limitations: [],
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const d = deps({
      modelMode: "live",
      modelBaseUrl: "https://x.invalid/v1",
      modelApiKey: "k",
      modelId: "m",
    });
    const res = await analyze(makePacket(), d);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.details.join(" ")).toContain("evidence_ref_unknown");
    }
  });

  it("模型失败后会话锁被释放，下次请求仍能进行", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("err", { status: 500 })),
    );
    const d = deps({
      modelMode: "live",
      modelBaseUrl: "https://x.invalid/v1",
      modelApiKey: "k",
      modelId: "m",
    });

    const first = await analyze(makePacket({ requestId: "r1" }), d);
    expect(first.ok).toBe(false);

    // 若失败没释放锁，这次会拿到 409 而不是继续尝试。
    const second = await analyze(makePacket({ requestId: "r2" }), d);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.httpStatus).not.toBe(409);
  });
});

describe("analyze — 输出标注诚实性", () => {
  it("mock 模式反馈里 mock 标记为 true 且 modelId 为 mock-coach", async () => {
    const res = await analyze(makePacket(), deps());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.feedback.mock).toBe(true);
      expect(res.feedback.modelId).toBe("mock-coach");
    }
  });

  it("mock 模式反馈的 limitations 里明说不来自真实模型", async () => {
    const res = await analyze(makePacket(), deps());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.feedback.limitations.join(" ")).toContain("未调用真实模型");
    }
  });

  it("反馈里的 requestId/sessionId/groupId 与请求一致（不会有陈旧串场）", async () => {
    const packet = makePacket({ requestId: "req-x", sessionId: "sess-x", groupId: "group-x" });
    const res = await analyze(packet, deps());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.feedback.requestId).toBe("req-x");
      expect(res.feedback.sessionId).toBe("sess-x");
      expect(res.feedback.groupId).toBe("group-x");
    }
  });

  it("未审核知识下的结论只能是 observation_only（红线 4）", async () => {
    // 当前仓库知识全部未审核，因此即使模型想给 target_met 也应被降级。
    const res = await analyze(makePacket({ strokes: [makeStroke()] }), deps());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.feedback.status).toBe("observation_only");
      expect(res.feedback.status).not.toBe("target_met");
    }
  });

  it("serverElapsedMs 被如实记录且非负", async () => {
    const res = await analyze(makePacket(), deps());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.feedback.serverElapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe("analyze — 注入时钟", () => {
  it("可用注入时钟控制 createdAtMonoMs（便于测试与复现）", async () => {
    let t = 5000;
    const now = () => t++;
    const res = await analyze(makePacket(), { ...deps(), now });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.feedback.createdAtMonoMs).toBeGreaterThanOrEqual(5000);
  });
});
