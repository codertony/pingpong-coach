/**
 * **可选的**真实模型烟雾测试 —— 用真实密钥打一次真实模型，验证"出厂默认值够用"。
 *
 * ## 为什么需要它（F-038）
 *
 * `live` 模式的两个出厂默认值曾经**在真实模型上全是错的**
 * （`max_tokens=400` 必然截断、超时 `4000ms` 正落在中位延迟上），
 * 而**单元测试发现不了**：它们全部用 stub 替换 `fetch`，
 * 断的是"我们的代码怎么处理响应"，不是"真实模型会怎么响应"。
 *
 * 这个用例**故意用最少的断言**：不评价建议好不好（那要人读），
 * 只钉住"**用仓库发布的默认值，能拿到一次通过服务端校验的真实反馈**"。
 * 默认值若被调回一个不合适的数（比如又把 token 预算调小），它会红。
 *
 * ## 怎么开
 *
 * 默认**不跑**，要显式开关 —— 它联网、**会花钱**、且依赖外部服务稳定性：
 *
 * ```bash
 * MODEL_API_KEY=<密钥> MODEL_BASE_URL=https://api.deepseek.com \
 *   MODEL_ID=deepseek-flash PPC_LIVE_MODEL=1 \
 *   pnpm --filter @pingpong/api test live-model
 * ```
 *
 * 密钥只从环境变量读；**不要**写进任何文件（红线 11）。
 */

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { makePacket } from "./fixtures.js";

const ENABLED = process.env.PPC_LIVE_MODEL === "1";

describe.skipIf(!ENABLED)("真实模型烟雾测试（需 PPC_LIVE_MODEL=1）", () => {
  it("用**仓库发布的默认值**能拿到一次通过服务端校验的真实反馈", async () => {
    // 关键：用 loadConfig()，即**测仓库的默认值**，不是自己另写一套。
    // （F-038 的排查里就栽过"探针把默认值又写了一遍"这个坑。）
    const config = loadConfig();
    expect(
      config.modelMode,
      "没有进入 live 模式 —— 检查 MODEL_API_KEY / MODEL_BASE_URL / MODEL_ID 三个变量名（无前缀）",
    ).toBe("live");

    const app = await buildServer({ config });
    try {
      const started = Date.now();
      const res = await app.inject({
        method: "POST",
        url: "/api/coach/analyze",
        payload: makePacket(),
      });
      const elapsedMs = Date.now() - started;

      const body = res.json() as Record<string, unknown>;

      // ① 不许因为预算不足而截断（F-038 的第一个默认值）
      expect(
        body.code,
        `模型输出被截断 —— 调大 MODEL_MAX_TOKENS（当前 ${config.modelMaxTokens}）`,
      ).not.toBe("model_truncated");

      // ② 不许因为超时而失败（F-038 的第二个默认值）
      expect(
        body.code,
        `请求超时（实测 ${elapsedMs}ms，默认超时 ${config.modelTimeoutMs}ms）—— ` +
          `调大 MODEL_TIMEOUT_MS，或确认网络`,
      ).not.toBe("model_timeout");

      // ③ 真的走通了，而且**不是 mock**
      expect(res.statusCode).toBe(200);
      expect(body.ok, `分析失败：${JSON.stringify(body).slice(0, 400)}`).toBe(true);

      const feedback = body.feedback as Record<string, unknown>;
      expect(feedback.mock, "结果被标成 mock —— 那条用例就没有意义了").toBe(false);
      expect(feedback.modelId).toBe(config.modelId);

      // ④ 服务端校验真的跑过（红线 8）。内容质量不在这里评价。
      expect(feedback).toHaveProperty("rejectedClaims");

      // 留数字，方便人工判断"这次算快还是慢"
      console.warn(
        `[live-model] ${config.modelId}：${elapsedMs}ms、` +
          `maxTokens=${config.modelMaxTokens}、timeout=${config.modelTimeoutMs}ms、` +
          `evidenceRefs=${(feedback.evidenceRefs as string[])?.length ?? 0} 项`,
      );
    } finally {
      await app.close();
    }
  }, 120_000);
});
