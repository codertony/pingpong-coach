/**
 * 模型调用适配测试。
 *
 * 这里钉死三条硬约束（AGENTS.md 红线 9/10/12）：
 * - mock 模式必须被显式标记为 mock，不能被误当成真实调用；
 * - 超时**不自动重试**（重试意味着重复计费和陈旧播报）；
 * - 模型失败时返回错误状态而不是抛异常，保证本地链路继续。
 *
 * 注意：本文件用 stub 替换 global.fetch，不发起真实网络请求。
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { callModel } from "../src/coach/provider.js";
import { collectAllowedOutputs, type AllowedOutputs } from "../src/coach/knowledge.js";
import { makeConfig, makePacket } from "./fixtures.js";
import type { ServerConfig } from "../src/config.js";

const noAllowed: AllowedOutputs = {
  cues: [],
  drillIds: [],
  hasReviewedReference: false,
  referenceId: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function liveConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    ...makeConfig(),
    modelMode: "live",
    modelId: "test-model",
    modelBaseUrl: "https://example.invalid/v1",
    modelApiKey: "test-key",
    ...overrides,
  } as ServerConfig;
}

describe("callModel — mock 模式", () => {
  it("mock 模式下 mock 标记为 true，且不发起网络请求", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await callModel(makeConfig() as ServerConfig, makePacket(), [], noAllowed);

    expect(result.mock).toBe(true);
    expect(result.error).toBeNull();
    // 关键：mock 绝不允许偷偷联网。
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mock 输出是合法 JSON 且 status 为 observation_only", async () => {
    const result = await callModel(makeConfig() as ServerConfig, makePacket(), [], noAllowed);
    expect(result.raw).not.toBeNull();
    const parsed = JSON.parse(result.raw as string);
    expect(parsed.status).toBe("observation_only");
  });

  it("mock 输出的 observation 带 [mock] 前缀，肉眼可辨", async () => {
    const result = await callModel(makeConfig() as ServerConfig, makePacket(), [], noAllowed);
    const parsed = JSON.parse(result.raw as string);
    expect(parsed.observation).toContain("[mock]");
  });

  it("mock 限制列表里明确写了「未调用真实模型」", async () => {
    const result = await callModel(makeConfig() as ServerConfig, makePacket(), [], noAllowed);
    const parsed = JSON.parse(result.raw as string);
    expect(parsed.limitations.join(" ")).toContain("未调用真实模型");
  });

  it("mock 遇到缺失特征时如实说明，不编造数值", async () => {
    const packet = makePacket({
      features: [
        {
          id: "return_after_wrist_peak_ms",
          value: null,
          unit: "ms",
          coordinateSpace: "image_2d",
          intervalMs: [0, 1],
          quality: "unusable",
          reasonIfMissing: "未回到准备区",
        },
      ],
    });
    const result = await callModel(makeConfig() as ServerConfig, packet, [], noAllowed);
    const parsed = JSON.parse(result.raw as string);
    expect(parsed.observation).toContain("未取得可靠");
    expect(parsed.observation).toContain("未回到准备区");
  });

  it("mock 的 evidenceRefs 只引用证据包里真实存在的 id", async () => {
    const packet = makePacket();
    const result = await callModel(makeConfig() as ServerConfig, packet, [], noAllowed);
    const parsed = JSON.parse(result.raw as string);
    const known = new Set([
      ...packet.features.map((f) => f.id),
      ...packet.keyframes.map((k) => k.id),
    ]);
    for (const ref of parsed.evidenceRefs) {
      expect(known.has(ref)).toBe(true);
    }
  });

  it("mock 无允许提示时 cue 为 null", async () => {
    const result = await callModel(makeConfig() as ServerConfig, makePacket(), [], noAllowed);
    const parsed = JSON.parse(result.raw as string);
    expect(parsed.cue).toBeNull();
  });

  it("mock 有允许提示时 cue 取自允许集合", async () => {
    const allowed = collectAllowedOutputs([
      {
        id: "kb",
        version: "1",
        strokeType: "forehand_drive",
        focusId: "return_to_ready_zone",
        cameraViews: [],
        context: "",
        observable: [],
        notApplicable: [],
        reviewedCues: ["回到预备位"],
        allowedDrillIds: [],
        sources: [],
        status: "observation_only",
        referenceId: null,
      },
    ]);
    const result = await callModel(makeConfig() as ServerConfig, makePacket(), [], allowed);
    const parsed = JSON.parse(result.raw as string);
    expect(parsed.cue).toBe("回到预备位");
  });

  it("mock 的 elapsedMs 是本地构造耗时，不是模型延迟", async () => {
    const result = await callModel(makeConfig() as ServerConfig, makePacket(), [], noAllowed);
    // 它必然很小（本地 JSON 拼装），这正是「不能当真实延迟」的证据。
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.elapsedMs).toBeLessThan(1000);
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
  });
});

describe("callModel — live 模式成功路径", () => {
  it("正常响应时返回模型文本且 mock 为 false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"status":"observation_only"}' } }],
              usage: { prompt_tokens: 120, completion_tokens: 40 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const result = await callModel(liveConfig(), makePacket(), [], noAllowed);

    expect(result.mock).toBe(false);
    expect(result.error).toBeNull();
    expect(result.raw).toContain("observation_only");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
  });

  it("请求体包含图片，且以 data URL 形式携带 base64", async () => {
    let captured: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await callModel(liveConfig(), makePacket(), [], noAllowed);

    const messages = (
      captured as unknown as { messages: Array<{ role: string; content: unknown }> }
    ).messages;
    const userContent = messages[1]?.content as Array<Record<string, unknown>>;
    const images = userContent.filter((c) => c.type === "image_url");
    expect(images.length).toBe(3);
    const firstUrl = (images[0] as { image_url: { url: string } }).image_url.url;
    expect(firstUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("授权头使用 Bearer，密钥只在服务端请求头里出现", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
          status: 200,
        });
      }),
    );

    await callModel(liveConfig(), makePacket(), [], noAllowed);
    expect(headers.authorization).toBe("Bearer test-key");
  });

  it("baseUrl 末尾多余斜杠被规整，不会产生双斜杠路径", async () => {
    let calledUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calledUrl = url;
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
          status: 200,
        });
      }),
    );

    await callModel(
      liveConfig({ modelBaseUrl: "https://example.invalid/v1/" }),
      makePacket(),
      [],
      noAllowed,
    );
    expect(calledUrl).toBe("https://example.invalid/v1/chat/completions");
    expect(calledUrl).not.toContain("//chat");
  });
});

describe("callModel — live 模式失败路径", () => {
  it("HTTP 非 2xx 返回 model_unavailable 而不是抛异常", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    const result = await callModel(liveConfig(), makePacket(), [], noAllowed);
    expect(result.error).toBe("model_unavailable");
    expect(result.raw).toBeNull();
    expect(result.errorDetail).toContain("HTTP 500");
  });

  it("响应缺少 content 字段时判定为 model_unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{}] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const result = await callModel(liveConfig(), makePacket(), [], noAllowed);
    expect(result.raw).toBeNull();
    expect(result.error).toBe("model_unavailable");
  });

  it("超时被识别为 model_timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }),
    );

    const result = await callModel(liveConfig(), makePacket(), [], noAllowed);
    expect(result.error).toBe("model_timeout");
    expect(result.errorDetail).toContain("未返回");
  });

  it("网络异常被识别为 model_unavailable 并保留原因", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    const result = await callModel(liveConfig(), makePacket(), [], noAllowed);
    expect(result.error).toBe("model_unavailable");
    expect(result.errorDetail).toContain("ECONNREFUSED");
  });

  it("超时后不自动重试 —— fetch 只被调用一次（红线 12）", async () => {
    const fetchSpy = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await callModel(liveConfig(), makePacket(), [], noAllowed);

    expect(result.error).toBe("model_timeout");
    // 关键断言：重试会导致重复计费与陈旧播报，必须恰好一次。
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("HTTP 500 后也不重试", async () => {
    const fetchSpy = vi.fn(async () => new Response("err", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);

    await callModel(liveConfig(), makePacket(), [], noAllowed);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("失败结果的 mock 标记为 false（不能把失败伪装成 mock）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("err", { status: 503 })),
    );
    const result = await callModel(liveConfig(), makePacket(), [], noAllowed);
    expect(result.mock).toBe(false);
  });
});
