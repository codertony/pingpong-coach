#!/usr/bin/env node
/**
 * 假的 OpenAI 兼容模型服务（**只用于端到端测试**）。
 *
 * 为什么需要它：红线 8 要求"模型输出必须在**服务端**校验"，但 mock 模式
 * 根本不经过模型调用 —— 那条校验路径在所有现有用例里都走不到，而它正是红线所在。
 * 这里顶替真实供应商，让服务端收到一段**故意伪造**的模型输出，
 * 从而真正走一遍 `validateModelOutput` 的拒回逻辑。
 *
 * 纪律：这个文件永远不该被生产代码引用，也不持有任何真实密钥。
 *
 * 用法：node scripts/e2e-fake-model.mjs <port>
 * 行为：POST /chat/completions 一律返回同一段伪造输出（引用不存在的证据 ID）。
 */

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8790);

/**
 * 伪造的模型输出。
 *
 * **必须是 schema 完全合法的**，只在 `evidenceRefs` 上作假 ——
 * 这样服务端才会走到"引用不存在"那条校验，而不是更早地在结构校验就拦下。
 * （实测踩过：少了 `limitations` 会被 `model_invalid_json` 先拦，
 * 用例就测不到红线 8 真正要测的那一条了。）
 */
const FORGED_OUTPUT = {
  status: "suggest_adjustment",
  observation: "引用了不存在的证据 ID —— 服务端应当拒回这条输出。",
  // ← 唯一的作假点：这个 ID 不在证据包里
  evidenceRefs: ["fabricated_evidence_id_that_does_not_exist"],
  cue: "这条提示不应被播报。",
  nextDrillId: null,
  limitations: ["伪造输出，仅用于端到端验证服务端校验"],
};

const server = createServer((req, res) => {
  // 探活：Playwright 的 webServer.url 会发 GET
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "fake-completion",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(FORGED_OUTPUT) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`假模型服务就绪：http://127.0.0.1:${port}/chat/completions`);
});
