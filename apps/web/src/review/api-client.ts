/**
 * 后端 API 客户端。
 *
 * 注意：API 密钥只存在于服务端。前端只调用本地代理，不持有任何密钥。
 */

import type {
  AnalyzeResult,
  CoachFeedback,
  EvidencePacket,
  HealthResponse,
} from "@pingpong/contracts";

/**
 * API 基地址。默认空字符串 = 走同源 `/api`（开发时由 vite 代理转发）。
 *
 * 允许覆写只为一件事：端到端测试需要把请求打到**另一个后端实例**
 * （例如 live 模式 + 假模型供应商那个）。测试夹具页会在加载时设置它，
 * 产品代码从不设置。注意这里**只能是地址**，密钥永远不进浏览器。
 */
function apiBase(): string {
  const override = (globalThis as { __apiBase?: unknown }).__apiBase;
  return typeof override === "string" ? override : "";
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${apiBase()}/api/health`);
  if (!res.ok) throw new Error(`健康检查失败：HTTP ${res.status}`);
  return (await res.json()) as HealthResponse;
}

export interface AnalyzeOutcome {
  feedback: CoachFeedback | null;
  /** 失败时的错误码与说明，用于界面提示与降级 */
  error: { code: string; message: string; details: string[] } | null;
  /** 是否命中去重 */
  deduplicated: boolean;
  /** 端到端耗时（浏览器计时），包含网络与校验 */
  elapsedMs: number;
}

/**
 * 发起一次本组分析。
 *
 * 约定：模型失败**不阻塞**本地训练。调用方拿到 error 后应保留本地反馈，
 * 只提示模型侧不可用。
 */
export async function analyzeGroup(packet: EvidencePacket): Promise<AnalyzeOutcome> {
  const started = performance.now();
  try {
    const res = await fetch(`${apiBase()}/api/coach/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(packet),
    });
    const json = (await res.json()) as AnalyzeResult;
    const elapsedMs = performance.now() - started;

    if (json.ok) {
      return { feedback: json.feedback, error: null, deduplicated: json.deduplicated, elapsedMs };
    }
    return {
      feedback: null,
      error: { code: json.code, message: json.message, details: json.details ?? [] },
      deduplicated: false,
      elapsedMs,
    };
  } catch (err) {
    return {
      feedback: null,
      error: {
        code: "model_unavailable",
        message: "无法连接后端服务",
        details: [(err as Error).message, "确认后端已启动（pnpm dev:api）"],
      },
      deduplicated: false,
      elapsedMs: performance.now() - started,
    };
  }
}
