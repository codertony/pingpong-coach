/**
 * 模型提供商适配。
 *
 * 设计约束：
 * - 模型名放入服务端配置，不让业务逻辑绑定某个提供商。
 * - 首版只做一次调用，不自动重试（避免重复费用与陈旧播报）。
 * - mock 模式必须**显著区分**，绝不用 mock 结果填充真实延迟或准确率。
 */

import type { EvidencePacket } from "@pingpong/contracts";
import type { ServerConfig } from "../config.js";
import type { AllowedOutputs, KnowledgeEntry } from "./knowledge.js";
import { buildPrompt } from "./prompt.js";

export interface ModelCallResult {
  /** 原始输出文本；超时或失败时为 null */
  raw: string | null;
  /** 是否发生了错误 */
  error: "model_timeout" | "model_unavailable" | null;
  errorDetail: string | null;
  /** 是否来自 mock */
  mock: boolean;
  elapsedMs: number;
  /** 提供商返回的 token 用量（若有） */
  usage: { inputTokens: number | null; outputTokens: number | null };
}

/**
 * 调用多模态模型。
 *
 * 注意：图片会发送到所选模型服务；摄像头连续流保留在设备端。
 * 首版不自动重试。
 */
export async function callModel(
  config: ServerConfig,
  packet: EvidencePacket,
  entries: KnowledgeEntry[],
  allowed: AllowedOutputs,
): Promise<ModelCallResult> {
  const started = Date.now();

  if (config.modelMode === "mock") {
    return mockCall(packet, entries, allowed, started);
  }

  const { system, user } = buildPrompt(packet, entries, allowed);

  // OpenAI 兼容的多模态消息结构：文本 + 图片。
  const content: Array<Record<string, unknown>> = [{ type: "text", text: user }];
  for (const kf of packet.keyframes) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${kf.jpegBase64}` },
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.modelTimeoutMs);

  try {
    const res = await fetch(`${config.modelBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.modelApiKey}`,
      },
      body: JSON.stringify({
        model: config.modelId,
        max_tokens: config.modelMaxTokens,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        raw: null,
        error: "model_unavailable",
        errorDetail: `HTTP ${res.status}: ${body.slice(0, 300)}`,
        mock: false,
        elapsedMs: Date.now() - started,
        usage: { inputTokens: null, outputTokens: null },
      };
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = json.choices?.[0]?.message?.content ?? null;

    return {
      raw,
      error: raw == null ? "model_unavailable" : null,
      errorDetail: raw == null ? "响应中没有 choices[0].message.content" : null,
      mock: false,
      elapsedMs: Date.now() - started,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? null,
        outputTokens: json.usage?.completion_tokens ?? null,
      },
    };
  } catch (err) {
    const aborted = (err as Error).name === "AbortError";
    return {
      raw: null,
      error: aborted ? "model_timeout" : "model_unavailable",
      errorDetail: aborted
        ? `超过 ${config.modelTimeoutMs}ms 未返回`
        : (err as Error).message,
      mock: false,
      elapsedMs: Date.now() - started,
      usage: { inputTokens: null, outputTokens: null },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mock 调用：不联网，基于证据包生成一个结构合法、措辞保守的输出。
 *
 * 它只用于在缺少密钥时验证整条链路（构造证据包 → 校验 → 展示 → 复查）。
 * **不得**用它产出的数字冒充真实延迟，也不得用它评估准确性。
 */
function mockCall(
  packet: EvidencePacket,
  entries: KnowledgeEntry[],
  allowed: AllowedOutputs,
  started: number,
): ModelCallResult {
  const returnFeature = packet.features.find(
    (f) => f.id === "return_after_wrist_peak_ms",
  );

  const evidenceRefs: string[] = [];
  if (returnFeature) evidenceRefs.push(returnFeature.id);
  const firstKeyframe = packet.keyframes[0];
  if (firstKeyframe) evidenceRefs.push(firstKeyframe.id);

  let observation: string;
  if (returnFeature?.value == null) {
    observation = `本组未取得可靠的返回准备区时间测量（${returnFeature?.reasonIfMissing ?? "缺少该测量"}），仅报告可见的挥拍数量与关键帧，不判断目标。`;
  } else {
    observation = `[mock] 本组 ${packet.strokes.length} 次挥拍中，从腕部速度峰值到重新进入准备区的中位时间约 ${Math.round(returnFeature.value)} 毫秒。该数值由程序测量，未经真实模型复核。`;
  }

  const cue = allowed.cues[0] ?? null;

  const out = {
    status: "observation_only" as const,
    observation,
    evidenceRefs,
    cue,
    nextDrillId: null,
    limitations: [
      "本次为 mock 模式输出，未调用真实模型",
      "锚点为腕部速度峰值，不是已确认的击球时刻",
      ...packet.limitations,
    ],
  };

  return {
    raw: JSON.stringify(out),
    error: null,
    errorDetail: null,
    mock: true,
    // mock 不参与真实延迟统计，这里仅记录本地构造耗时
    elapsedMs: Date.now() - started,
    usage: { inputTokens: null, outputTokens: null },
  };
}
