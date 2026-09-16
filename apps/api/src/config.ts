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
  /**
   * 推理强度透传给提供商（`reasoning_effort`）；`null` = **不发送该字段**。
   *
   * 为什么要开这个口子：`F-038` 的截断根因是**推理模型把预算花在推理上**，
   * 而推理强度正是那个量的旋钮。不同提供商的合法取值不同
   * （DeepSeek 文档示例用 `"high"`），所以**只做透传、不做校验、不给默认值** ——
   * 猜一个值发出去可能直接 400。不设就与现在行为完全一致。
   */
  modelReasoningEffort?: string | null;
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
    // 两个默认值都**按真实模型实测改过**（2026-09-16，deepseek-flash）：
    //
    // - 超时 4000 → 15000：实测延迟 min 2278 / 中位 3928 / max 4753 ms，
    //   端到端（含图片）实测 2568~4496 ms。**4000 正落在中位数上**，
    //   意味着约一半请求会超时 —— 那是"配了个必然间歇失败的默认值"。
    // - token 400 → 2000：实测完成用量（**含推理 token**）398~813，
    //   而 400 会让正文被腰斩（实测在第 192 字符处断），报出来却是
    //   "JSON 不合法"。推理模型会先花推理 token，正文预算必须留出余量。
    //
    // 依据记在 docs/evaluation-log.md；改这两个值要连 `configs/thresholds.json`
    // 的 latency 快照与 `apps/api/test/config.test.ts` 一起改，否则就是悄悄放宽。
    modelTimeoutMs: envInt("MODEL_TIMEOUT_MS", 15_000),
    modelMaxTokens: envInt("MODEL_MAX_TOKENS", 2000),
    // 空字符串 = 不发送（与"没配"同义），避免把 "" 当成一个值发给提供商
    modelReasoningEffort: (process.env.MODEL_REASONING_EFFORT ?? "").trim() || null,
    maxRequestBytes: envInt("MAX_REQUEST_BYTES", 2 * 1024 * 1024),
    dedupeTtlMs: envInt("DEDUPE_TTL_MS", 30_000),
  };
}
