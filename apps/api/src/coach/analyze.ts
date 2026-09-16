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
import { validateModelOutput, type ValidationIssue } from "./validate.js";

export interface AnalyzeDeps {
  config: ServerConfig;
  dedupe: RequestDedupe;
  /** 注入时钟，便于测试 */
  now?: () => number;
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

  // 6) 构造任务
  const task = runAnalysis(packet, config, now);
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

  // 一次模型调用，无自动重试
  const result = await callModel(config, packet, entries, allowed);

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

  const outcome = validateModelOutput(rawParsed, packet, allowed, {
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
