/**
 * POST /api/coach/analyze
 *
 * 流程：接收 EvidencePacket → 用 contracts 再次校验 → 选知识 → 一次模型调用
 *       → 校验输出 → 返回 CoachFeedback 或明确错误状态。
 *
 * 关键约束：
 * - P1 每组一次 HTTP 请求，不逐帧上传视频。
 * - 每个会话最多一个模型请求在途；旧会话响应不直接播报。
 * - 模型超时不自动重试，但**本地训练功能不受影响**。
 */

import type { EvidencePacket, CoachFeedback } from "@pingpong/contracts";
import { evidencePacketSchema } from "@pingpong/contracts";
import type { ServerConfig } from "../config.js";
import { RequestDedupe } from "./dedupe.js";
import { collectAllowedOutputs, loadKnowledge, selectKnowledge } from "./knowledge.js";
import { callModel } from "./provider.js";
import { splitDecodableKeyframes } from "./keyframe-guard.js";
import { SessionCallBudget } from "./call-budget.js";
import { validateModelOutput, type ValidationIssue } from "./validate.js";

export interface AnalyzeDeps {
  config: ServerConfig;
  dedupe: RequestDedupe;
  /** 注入时钟，便于测试 */
  now?: () => number;
  /**
   * 每会话的模型调用预算（费用保护）。不传 = 不限。
   *
   * 实现的是 `configs/thresholds.json` 里早就声明、此前却没人读的
   * `budgets.sessionModelCallsPer20Min`（见 F-027）。
   */
  callBudget?: SessionCallBudget;
  /**
   * 每次**真实模型调用**后的用量回调（可选）。
   *
   * 为什么要有它：接真实模型是**按 token 计费**的，而响应体里不带用量，
   * 于是"这次花了多少"在产品里**完全不可见**。这里不往契约里加字段
   * （那会动到前端与校验），只开一个口子让服务端把用量**记进日志**。
   * mock 调用也会回调，但 `mock: true` 标着，避免被当作真实费用。
   */
  onModelUsage?: (usage: {
    modelId: string;
    mock: boolean;
    inputTokens: number | null;
    outputTokens: number | null;
    elapsedMs: number;
  }) => void;
}

export interface AnalyzeSuccess {
  ok: true;
  feedback: CoachFeedback;
  deduplicated: boolean;
}

export interface AnalyzeFailure {
  ok: false;
  code: string;
  message: string;
  details: string[];
  /** 服务端是否已受理但未取得合格结论 */
  httpStatus: number;
}

export type AnalyzeResult = AnalyzeSuccess | AnalyzeFailure;

export async function analyze(body: unknown, deps: AnalyzeDeps): Promise<AnalyzeResult> {
  const { config, dedupe } = deps;
  const now = deps.now ?? (() => Date.now());
  // 取出来单独持有：真正调模型的那段在一个**嵌套函数**里，
  // 那里够不到 `deps`（踩过：写成 deps.onModelUsage?.() 会抛 "deps is not defined"）。
  const onModelUsage = deps.onModelUsage;

  // 1) 前端传来的数据必须再次校验
  const parsed = evidencePacketSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      code: "unsupported",
      message: "证据包未通过契约校验",
      details: parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      httpStatus: 400,
    };
  }
  const packet: EvidencePacket = parsed.data;

  // 2) 请求大小上限检查（按 JSON 长度近似）
  const approxBytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
  if (approxBytes > config.maxRequestBytes) {
    return {
      ok: false,
      code: "evidence_too_large",
      message: `证据包约 ${approxBytes} 字节，超过上限 ${config.maxRequestBytes} 字节`,
      details: ["请减少冗余关键帧或降低图片质量"],
      httpStatus: 413,
    };
  }

  // 3) 已完成响应复用
  const cached = dedupe.getCompleted(packet.requestId);
  if (cached) {
    return { ok: true, feedback: cached, deduplicated: true };
  }

  // 4) 同 requestId 在途：直接返回同一个 Promise 的结果
  const inFlight = dedupe.getInFlight(packet.requestId);
  if (inFlight) {
    const feedback = await inFlight;
    return { ok: true, feedback, deduplicated: true };
  }

  // 5) 每会话最多一个在途请求
  if (dedupe.hasSessionInFlight(packet.sessionId)) {
    return {
      ok: false,
      code: "model_unavailable",
      message: "该会话已有模型请求在途，本次不排队",
      details: ["等待当前请求结束，或稍后用新的分组再试"],
      httpStatus: 409,
    };
  }

  // 6) 费用保护：真实模型按 token 计费，本会话的调用次数要有上限。
  //    只在 live 下生效 —— mock 不花钱，拿它去卡只会制造没意义的失败。
  //    超限不阻塞本地链路（红线 9）：仍返回 200，但说清楚原因与何时能再试。
  if (config.modelMode === "live" && deps.callBudget != null) {
    const budget = deps.callBudget.tryConsume(packet.sessionId, now());
    if (!budget.allowed) {
      return {
        ok: false,
        code: "model_budget_exceeded",
        message:
          `本会话 20 分钟内最多 ${budget.limit} 次模型调用，已用完；` +
          `约 ${Math.ceil(budget.retryAfterMs / 1000)} 秒后可再试`,
        details: [
          "这是费用保护，不是故障；本地分析与提示不受影响",
          `上限来自 configs/thresholds.json 的 budgets.sessionModelCallsPer20Min（当前 ${budget.limit}）`,
        ],
        httpStatus: 200,
      };
    }
  }

  // 7) 构造任务
  const task = runAnalysis(packet, config, now, onModelUsage);
  dedupe.begin(packet.sessionId, packet.requestId, task);

  try {
    const feedback = await task;
    dedupe.finish(packet.sessionId, packet.requestId, feedback);
    return { ok: true, feedback, deduplicated: false };
  } catch (err) {
    dedupe.fail(packet.sessionId, packet.requestId);
    const e = err as Error & { code?: string; details?: string[]; httpStatus?: number };
    return {
      ok: false,
      code: e.code ?? "internal_error",
      message: e.message,
      details: e.details ?? [],
      httpStatus: e.httpStatus ?? 500,
    };
  }
}

class AnalysisError extends Error {
  code: string;
  details: string[];
  httpStatus: number;
  constructor(code: string, message: string, httpStatus: number, details: string[] = []) {
    super(message);
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

async function runAnalysis(
  packet: EvidencePacket,
  config: ServerConfig,
  now: () => number,
  onModelUsage: AnalyzeDeps["onModelUsage"],
): Promise<CoachFeedback> {
  const started = now();

  // 知识选择：按 strokeType + focusId + cameraView
  const kb = await loadKnowledge();
  const entries = selectKnowledge(kb, {
    strokeType: packet.strokeType,
    focusId: packet.focusId,
    cameraView: packet.cameraView,
  });
  const allowed = collectAllowedOutputs(entries);

  /*
   * 关键帧里混进**不是图片**的负载时，提供商直接 400（实测 DeepSeek：
   * `unsupported image`），于是**整次分析失败** —— 文本证据本来好好的却被一起丢掉。
   *
   * 所以在**组 prompt 之前**就把不能用的图摘掉，让文本证据照样能被分析；
   * 摘掉了哪些要如实记账，最后写进 limitations（不许静默）。
   * 注意顺序：必须在 buildPrompt 之前，否则提示里会声称有那些图，
   * 模型可能引用一张它根本看不到的关键帧。
   */
  const { valid: safeKeyframes, droppedIds } = splitDecodableKeyframes(packet.keyframes);
  const safePacket: EvidencePacket =
    droppedIds.length > 0 ? { ...packet, keyframes: safeKeyframes } : packet;

  // 一次模型调用，无自动重试
  const result = await callModel(config, safePacket, entries, allowed);

  onModelUsage?.({
    modelId: config.modelId,
    mock: result.mock,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    elapsedMs: result.elapsedMs,
  });

  if (result.raw == null) {
    const code = result.error ?? "model_unavailable";
    throw new AnalysisError(
      code,
      code === "model_timeout" ? `模型超过 ${config.modelTimeoutMs}ms 未返回` : "模型接口调用失败",
      // 服务端不会把模型失败变成 5xx——本地链路应继续运行。
      // 前端据此保留本地反馈，不阻塞采集。
      200,
      result.errorDetail ? [result.errorDetail] : [],
    );
  }

  // 解析 + 校验
  let rawParsed: unknown = null;
  let parseError: string | null = null;
  try {
    rawParsed = JSON.parse(stripCodeFence(result.raw));
  } catch (err) {
    parseError = (err as Error).message;
  }

  if (parseError != null) {
    // 截断不等于"模型乱输出 JSON"。**推理模型会把 token 预算花在推理上**，
    // 于是预算不够时正文被腰斩，报出来的却是 JSON 解析失败 ——
    // 只看那个 code 会去查解析，而真正要调的是预算。
    // 实测（deepseek-flash）：默认 max_tokens=400 被推理吃光，正文在第 192 字符处断。
    if (result.finishReason === "length") {
      throw new AnalysisError(
        "model_truncated",
        `模型输出被 token 预算截断（max_tokens=${config.modelMaxTokens}）`,
        200,
        [
          parseError,
          result.raw.slice(0, 200),
          "推理模型会先消耗推理 token，正文可能因此被截断。调大 MODEL_MAX_TOKENS 后重试。",
        ],
      );
    }
    throw new AnalysisError("model_invalid_json", "模型返回内容不是合法 JSON", 200, [
      parseError,
      result.raw.slice(0, 200),
    ]);
  }

  const outcome = validateModelOutput(rawParsed, safePacket, allowed, {
    sessionId: packet.sessionId,
    groupId: packet.groupId,
    focusId: packet.focusId,
    requestId: packet.requestId,
  });

  if (outcome.feedback == null) {
    const primary = outcome.issues[0];
    throw new AnalysisError(
      primary?.code ?? "model_invalid_json",
      "模型输出未通过服务端校验，不予播报",
      200,
      [...formatIssues(outcome.issues), ...(result.errorDetail ? [result.errorDetail] : [])],
    );
  }

  return {
    ...outcome.feedback,
    limitations:
      droppedIds.length > 0
        ? [
            ...outcome.feedback.limitations,
            `有 ${droppedIds.length} 张关键帧不是有效图片（${droppedIds.join("、")}），` +
              `已丢弃且未发送给模型 —— 本组结论只依据其余证据。`,
          ]
        : outcome.feedback.limitations,
    modelId: result.mock ? "mock-coach" : config.modelId,
    mock: result.mock,
    // mock 的耗时不计入真实模型延迟统计口径，但仍如实记录
    serverElapsedMs: now() - started,
    createdAtMonoMs: now(),
  };
}

/** 模型有时会包一层 Markdown 代码块，宽容地剥掉，但仍然要求内容是纯 JSON。 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const m = fence.exec(trimmed);
  return m?.[1] ?? trimmed;
}

function formatIssues(issues: ValidationIssue[]): string[] {
  return issues.map((i) => `[${i.code}] ${i.detail}`);
}
