/**
 * Fastify 服务：首版唯一后端服务。
 *
 * 路由（方案 9.5）：
 *   GET  /api/health          服务、模型配置和运行模式检查
 *   POST /api/coach/analyze   接收 EvidencePacket，返回 CoachFeedback 或明确错误状态
 *
 * P1 暂不设计账户、订单、组织权限和复杂训练计划 CRUD。
 *
 * 正式本地启动时，由 Fastify 同时提供静态页面和 API。
 */

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { RULE_VERSION } from "@pingpong/contracts";
import { loadConfig, type ServerConfig } from "./config.js";
import { analyze } from "./coach/analyze.js";
import { RequestDedupe } from "./coach/dedupe.js";
import { loadKnowledge } from "./coach/knowledge.js";

export interface BuildServerOptions {
  config?: ServerConfig;
}

export async function buildServer(
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const dedupe = new RequestDedupe(config.dedupeTtlMs);
  const startedAt = Date.now();

  const app = Fastify({
    logger: {
      // 测试环境默认静音，避免淹没测试输出
      level: process.env.LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info"),
    },
    // 证据包可能接近 2 MiB，留出余量
    bodyLimit: Math.ceil(config.maxRequestBytes * 1.5),
  });

  // GET /api/health
  app.get("/api/health", async () => {
    const kb = await loadKnowledge();
    return {
      ok: true,
      version: "0.1.0",
      modelMode: config.modelMode,
      modelId: config.modelId,
      ruleVersion: RULE_VERSION,
      knowledgeVersion: kb.version,
      nodeVersion: process.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    };
  });

  // POST /api/coach/analyze
  app.post("/api/coach/analyze", async (request, reply) => {
    const result = await analyze(request.body, { config, dedupe });
    if (result.ok) {
      return reply.status(200).send({
        ok: true,
        feedback: result.feedback,
        deduplicated: result.deduplicated,
      });
    }
    return reply.status(result.httpStatus).send({
      ok: false,
      code: result.code,
      message: result.message,
      details: result.details,
    });
  });

  // 生产模式下同时提供前端静态产物
  const webDist = resolve(process.env.WEB_DIST ?? join(process.cwd(), "../web/dist"));
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.status(404).send({
          ok: false,
          code: "unsupported",
          message: `未知接口 ${request.url}`,
        });
      }
      // SPA 回退
      return reply.sendFile("index.html");
    });
  }

  return app;
}

/** 直接运行时的入口。 */
async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer({ config });
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      `pingpong-coach API 就绪 | 模式=${config.modelMode} | 模型=${config.modelId} | http://${config.host}:${config.port}`,
    );
    if (config.modelMode === "mock") {
      app.log.warn(
        "当前为 mock 模式：未配置 MODEL_API_KEY / MODEL_BASE_URL / MODEL_ID，反馈不来自真实模型。",
      );
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const isDirectRun =
  process.argv[1] != null &&
  (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"));

if (isDirectRun) {
  void main();
}
