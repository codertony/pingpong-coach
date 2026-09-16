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
  /**
   * 每个会话在 20 分钟内允许的**模型调用次数**（费用保护）。
   *
   * 这个值原先只写在 `configs/thresholds.json` 里、**代码从不读它**（F-027），
   * 属于"看着像开关、改了不生效"。现在实现了：真实模型按 token 计费，
   * 一次失控的循环本可以无声烧钱。mock 不计费，所以预算只在 live 模式下生效。
   */
  sessionModelCallsPer20Min: number;
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
    /*
     * 两个默认值都是按**实测**定的，而且改过两轮 —— 第二轮是拿**真实证据包**量的。
     *
     * 第一轮（短提示）：原始值 4000ms / 400 tokens 在真实模型上全是错的 ——
     *   4000 正落在中位延迟（3928ms）上，400 会让正文被腰斩。
     *
     * 第二轮（**真实包：9 张 960 长边关键帧**，2026-09-16）：输入 4145 tokens、
     *   输出 1584 tokens、端到端 8.7s；无图那次更慢（>15s）。也就是说短提示上
     *   量出来的 15000/2000 对真实包**仍然偏紧**（已分别在 2000 处截断过一次、
     *   15000 处超时过一次）。→ 45000ms / 4000 tokens：
     *   成功那次输出 1584，留 2.5 倍余量；最慢观测 ~15s，留 3 倍。
     *
     * 依据记在 docs/evaluation-log.md 与 docs/acceptance.md（版本 1.0.2）；
     * 改这两个值要连 `configs/thresholds.json` 的 latency 快照与
     * `apps/api/test/config.test.ts` 一起改，否则就是悄悄放宽。
     */
    modelTimeoutMs: envInt("MODEL_TIMEOUT_MS", 45_000),
    modelMaxTokens: envInt("MODEL_MAX_TOKENS", 4000),
    // 空字符串 = 不发送（与"没配"同义），避免把 "" 当成一个值发给提供商
    modelReasoningEffort: (process.env.MODEL_REASONING_EFFORT ?? "").trim() || null,
    sessionModelCallsPer20Min: envInt("SESSION_MODEL_CALLS_PER_20_MIN", 60),
    maxRequestBytes: envInt("MAX_REQUEST_BYTES", 2 * 1024 * 1024),
    dedupeTtlMs: envInt("DEDUPE_TTL_MS", 30_000),
  };
}
