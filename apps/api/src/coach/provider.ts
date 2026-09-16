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
      errorDetail: aborted ? `超过 ${config.modelTimeoutMs}ms 未返回` : (err as Error).message,
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
/**
 * 关注点 → 该关注点对应的**主测量**。
 *
 * 为什么需要这张表（实测发现的缺陷）：mock 适配器原先**写死**只找
 * `return_after_wrist_peak_ms`，完全忽略 `packet.focusId`。
 * 于是用户选了「肘角伸展模式」时，mock 返回的观察文本仍在讲返回准备区时间 ——
 * 答非所问。配合本地规则也只有 return_to_ready_zone 一条，
 * 在 mock 模式下**整个反馈区是空的**。
 *
 * 语义：这里声明的是"这个关注点关心哪个测量"，mock 据此复述**程序已经算出的**
 * 值。它不做任何判断，只是把该关注点的测量如实转述出来。
 */
const FOCUS_PRIMARY_FEATURE: Record<string, string> = {
  return_to_ready_zone: "return_after_wrist_peak_ms",
  elbow_extension_pattern: "elbow_angle_at_wrist_peak_deg",
  elbow_relative_torso_drift: "elbow_relative_torso_drift_body_scale",
};

/** 各测量的口语化说法，用于 mock 的观察文本。 */
const FEATURE_STATEMENT: Record<string, (v: number, n: number) => string> = {
  return_after_wrist_peak_ms: (v, n) =>
    `本组 ${n} 次挥拍中，从腕部速度峰值到重新进入准备区的中位时间约 ${Math.round(v)} 毫秒`,
  elbow_angle_at_wrist_peak_deg: (v, n) =>
    `本组 ${n} 次挥拍中，腕部速度峰值处的肘角中位数约 ${Math.round(v)} 度（180 度为伸直）`,
  elbow_relative_torso_drift_body_scale: (v) =>
    `本组肘部相对躯干的移动幅度约 ${v.toFixed(2)} 倍体尺度（已消除整体平移）`,
};

function mockCall(
  packet: EvidencePacket,
  entries: KnowledgeEntry[],
  allowed: AllowedOutputs,
  started: number,
): ModelCallResult {
  // 按**用户选中的关注点**挑主测量，而不是固定挑返回准备区时间。
  const primaryId = FOCUS_PRIMARY_FEATURE[packet.focusId] ?? "return_after_wrist_peak_ms";
  const primary = packet.features.find((f) => f.id === primaryId);

  const evidenceRefs: string[] = [];
  if (primary) evidenceRefs.push(primary.id);
  const firstKeyframe = packet.keyframes[0];
  if (firstKeyframe) evidenceRefs.push(firstKeyframe.id);

  const say = FEATURE_STATEMENT[primaryId];
  let observation: string;
  if (primary?.value == null) {
    // 缺失时按契约如实说明原因，**不编造数值**（红线 1）
    observation = `本组未取得可靠的对应测量（${primary?.reasonIfMissing ?? "缺少该测量"}），仅报告可见的挥拍数量与关键帧，不判断目标。`;
  } else if (say) {
    observation = `[mock] ${say(primary.value, packet.strokes.length)}。该数值由程序测量，未经真实模型复核。`;
  } else {
    observation = `[mock] 本组 ${packet.strokes.length} 次挥拍，未识别该关注点对应的测量。`;
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
