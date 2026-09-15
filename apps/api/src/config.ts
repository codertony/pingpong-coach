/**
 * 服务端配置。
 *
 * 安全约束（方案第 5 节）：
 * 不把 API 密钥放在前端环境变量或浏览器持久化存储中。
 * 模型地址和密钥由服务端配置，前端永远拿不到。
 */

export interface ServerConfig {
  port: number;
  host: string;
  /** "mock" 表示未配置真实模型密钥，只走本地规则与固定回放 */
  modelMode: "mock" | "live";
  /** 模型标识，写入反馈记录便于评估与费用归因 */
  modelId: string;
  /** 模型服务地址；密钥不在此结构中输出给前端 */
  modelBaseUrl: string;
  modelApiKey: string;
  /** 模型调用超时。初始 4 秒（方案 10.1） */
  modelTimeoutMs: number;
  /** 模型输出 token 预算，初始约 400（方案 9.2） */
  modelMaxTokens: number;
  /** 证据包请求总大小上限，初始 2 MiB */
  maxRequestBytes: number;
  /** 已完成响应复用的保留时长 */
  dedupeTtlMs: number;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function loadConfig(): ServerConfig {
  const apiKey = process.env.MODEL_API_KEY ?? "";
  const baseUrl = process.env.MODEL_BASE_URL ?? "";
  const modelId = process.env.MODEL_ID ?? "";

  // 只有密钥、地址、模型名三者都齐备才进入 live 模式。
  // 否则明确降级为 mock —— 绝不用 mock 结果冒充真实调用。
  const live = apiKey.trim() !== "" && baseUrl.trim() !== "" && modelId.trim() !== "";

  return {
    port: envInt("PORT", 8787),
    host: process.env.HOST ?? "127.0.0.1",
    modelMode: live ? "live" : "mock",
    modelId: live ? modelId : "mock-coach",
    modelBaseUrl: baseUrl,
    modelApiKey: apiKey,
    modelTimeoutMs: envInt("MODEL_TIMEOUT_MS", 4000),
    modelMaxTokens: envInt("MODEL_MAX_TOKENS", 400),
    maxRequestBytes: envInt("MAX_REQUEST_BYTES", 2 * 1024 * 1024),
    dedupeTtlMs: envInt("DEDUPE_TTL_MS", 30_000),
  };
}
