/**
 * analyze 编排测试。
 *
 * analyze 是「安全门」真正落地的地方：输入校验、大小限制、去重、
 * 会话串行、以及模型失败时不 5xx。这些路径出错会直接影响用户体验和费用。
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { analyze } from "../src/coach/analyze.js";
import { RequestDedupe } from "../src/coach/dedupe.js";
import { SessionCallBudget } from "../src/coach/call-budget.js";
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

describe("analyze — 模型用量可观测（费用）", () => {
  it("每次模型调用后回调用量，且 mock 也标着 mock（不冒充真实费用）", async () => {
    const seen: Array<{ mock: boolean; inputTokens: number | null; outputTokens: number | null }> =
      [];
    const d = { ...deps(), onModelUsage: (u: (typeof seen)[number]) => seen.push(u) };

    await analyze(makePacket(), d);

    expect(seen).toHaveLength(1);
    // mock 模式下用量必然是 null —— 它没联网，也就没有真实 token 消耗
    expect(seen[0]?.mock).toBe(true);
    expect(seen[0]?.inputTokens).toBeNull();
  });

  it("live 模式下回调里带真实 token 用量（这才是能算钱的那两个数）", async () => {
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
                      observation: "本组 1 次挥拍。",
                      evidenceRefs: ["return_after_wrist_peak_ms"],
                      cue: null,
                      nextDrillId: null,
                      limitations: ["锚点为腕部速度峰值"],
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1181, completion_tokens: 698 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const seen: Array<{ modelId: string; mock: boolean; inputTokens: number | null }> = [];
    const d = {
      ...deps({
        modelMode: "live",
        modelId: "m",
        modelBaseUrl: "https://x.invalid",
        modelApiKey: "k",
      }),
      onModelUsage: (u: (typeof seen)[number]) => seen.push(u),
    };

    await analyze(makePacket(), d);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ mock: false, inputTokens: 1181, outputTokens: 698 });
  });
});

describe("analyze — 关键帧不是图片时不许拖垮整次分析（F-042）", () => {
  it("只把有效图片发给模型，并在 limitations 里如实记账（不是静默丢弃）", async () => {
    let sent: { messages: Array<{ content: unknown }> } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(init.body as string) as { messages: Array<{ content: unknown }> };
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    status: "observation_only",
                    observation: "本组 1 次挥拍。",
                    evidenceRefs: ["return_after_wrist_peak_ms"],
                    cue: null,
                    nextDrillId: null,
                    limitations: ["锚点为腕部速度峰值"],
                  }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    // 真包（关键帧都是可用的）里，把**第二张**换成 600KB 随机字节 ——
    // 这正是实测会让提供商 400 `unsupported image` 的那种负载
    const base = makePacket();
    expect(base.keyframes.length, "这条用例需要至少 2 张关键帧").toBeGreaterThanOrEqual(2);
    const garbage = Buffer.alloc(600 * 1024, 0xab).toString("base64");
    const packet = {
      ...base,
      keyframes: base.keyframes.map((k, i) => (i === 1 ? { ...k, jpegBase64: garbage } : k)),
    };
    const badId = packet.keyframes[1]!.id;

    const res = await analyze(
      packet,
      deps({
        modelMode: "live",
        modelBaseUrl: "https://x.invalid",
        modelApiKey: "k",
        modelId: "m",
      }),
    );

    // ① 坏图**没有**被发出去（否则提供商 400，整次分析白跑）
    const userContent = sent!.messages[1]!.content as Array<{ type: string }>;
    const images = userContent.filter((c) => c.type === "image_url");
    expect(images, "坏图仍然被发出去了 —— 提供商会 400，文本证据也一起丢").toHaveLength(
      packet.keyframes.length - 1,
    );

    // ② 文本证据照样拿到了反馈
    expect(res.ok).toBe(true);
    if (res.ok) {
      // ③ 而且**如实说了**丢了哪一张（红线：不许静默）
      const text = res.feedback.limitations.join(" ");
      expect(text).toContain(badId);
      expect(text).toContain("不是有效图片");
    }
  });
});

describe("analyze — 每会话模型调用预算（费用保护，F-027）", () => {
  const okResponse = () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "observation_only",
                observation: "本组 1 次挥拍。",
                evidenceRefs: ["return_after_wrist_peak_ms"],
                cue: null,
                nextDrillId: null,
                limitations: ["锚点为腕部速度峰值"],
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("live 模式下超出上限就拒绝，**但仍返回 200**（不阻塞本地链路，红线 9）", async () => {
    const fetchSpy = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchSpy);

    const callBudget = new SessionCallBudget(2);
    const live = {
      modelMode: "live" as const,
      modelBaseUrl: "https://x.invalid",
      modelApiKey: "k",
      modelId: "m",
    };

    // 前两次放行
    for (const id of ["r1", "r2"]) {
      const res = await analyze(makePacket({ requestId: id }), { ...deps(live), callBudget });
      expect(res.ok, `${id} 应当在预算内`).toBe(true);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // 第三次拒绝，且**没有**再发起模型调用
    const third = await analyze(makePacket({ requestId: "r3" }), { ...deps(live), callBudget });
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.code).toBe("model_budget_exceeded");
      expect(third.httpStatus, "费用保护不是故障，不该变成 5xx").toBe(200);
      expect(third.message).toContain("20 分钟");
      expect(third.details.join(" ")).toContain("sessionModelCallsPer20Min");
    }
    expect(fetchSpy, "被预算拦住时绝不能再花钱调一次").toHaveBeenCalledTimes(2);
  });

  it("mock 模式**不受**预算限制（mock 不花钱，拿它去卡只会制造无意义的失败）", async () => {
    const callBudget = new SessionCallBudget(1);
    const d = { ...deps(), callBudget }; // deps() 默认就是 mock

    for (const id of ["m1", "m2", "m3"]) {
      const res = await analyze(makePacket({ requestId: id }), d);
      expect(res.ok, "mock 下不该被预算拦住").toBe(true);
    }
  });
});

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
      keyPoints: [],
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

  /**
   * 真实模型上实测到的形态（deepseek-flash，2026-09-16）：
   * **推理模型先把 token 预算花在推理上**，预算不够时正文被**腰斩**，
   * 而腰斩的表现就是"JSON 不合法"。两条路径必须报**不同的码** ——
   * 都报 `model_invalid_json` 会把排查引到解析上，而真正要调的是预算。
   */
  it("被 token 预算截断时报 model_truncated，而不是 model_invalid_json", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  // 正文写到一半就断了 —— 这是截断的真实样子
                  message: { content: '{"status":"observation_only","observation":"事实：本组仅' },
                  finish_reason: "length",
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
      modelMaxTokens: 400,
    });
    const res = await analyze(makePacket(), d);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("model_truncated");
      // 报错文案必须**指出该动哪个旋钮**，否则等于只说"失败了"
      expect(res.message).toContain("max_tokens=400");
      expect(res.details?.join(" ")).toContain("MODEL_MAX_TOKENS");
      expect(res.httpStatus).toBe(200);
    }
  });

  it("同样是不合法 JSON，但结束原因不是 length 时仍报 model_invalid_json（不误报截断）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "这不是 JSON" }, finish_reason: "stop" }],
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
