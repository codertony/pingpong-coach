import { z } from "zod";
import { errorCodeSchema } from "./primitives.js";
import { coachFeedbackSchema } from "./evidence.js";

/** GET /api/health 响应。 */
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  /** "mock" 或 "live"。mock 表示未配置真实模型密钥。 */
  modelMode: z.enum(["mock", "live"]),
  /** 当前配置的模型标识，不暴露密钥。 */
  modelId: z.string(),
  /** 知识文件与规则的版本，便于把反馈关联到判定依据。 */
  ruleVersion: z.string(),
  knowledgeVersion: z.string(),
  nodeVersion: z.string(),
  uptimeSec: z.number().nonnegative(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** 统一错误响应体。 */
export const apiErrorSchema = z.object({
  ok: z.literal(false),
  code: errorCodeSchema,
  message: z.string(),
  /** 可选的字段级细节，便于契约调试。 */
  details: z.array(z.string()).optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** POST /api/coach/analyze 成功响应。 */
export const analyzeResponseSchema = z.object({
  ok: z.literal(true),
  feedback: coachFeedbackSchema,
  /** 是否命中了 requestId 在途去重或已完成响应复用。 */
  deduplicated: z.boolean(),
});

export type AnalyzeResponse = z.infer<typeof analyzeResponseSchema>;

export type AnalyzeResult = AnalyzeResponse | ApiError;
