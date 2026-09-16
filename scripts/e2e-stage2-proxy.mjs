#!/usr/bin/env node
/**
 * 极简转发服务（**只用于端到端测试**）。
 *
 * 为什么需要它：红线 8 要求"模型输出必须在服务端校验"，但 mock 模式根本不
 * 经过模型调用，所以那条校验路径在当前所有用例里都走不到。
 * 要用例走到它，需要让前端把请求打到**另一个** API 实例（live 模式 +
 * 本地假供应商）。而浏览器直连另一个端口是跨源、需要 CORS，
 * 给 API 加 CORS 等于为测试改产品边界。
 *
 * 先前的做法是让 vite 代理转发，结果卡在前缀改写上：
 * - `/api-live` 会被 vite 的 `/api` 规则先匹配走（按前缀选目标）；
 * - 这个版本的 vite 里 `rewrite` 与 `bypass` 的行为都与预期不符（实测
 *   后端收到的是带前缀的路径）。
 *
 * 所以改用一个独立的转发服务：它挂在**与 vite 相同的源**上做不到，
 * 那就退一步 —— 测试直接向它发请求即可，耦合更少、行为完全可预测，
 * 也不需要动 vite 配置。
 *
 * 用法：node scripts/e2e-stage2-proxy.mjs <listenPort> <targetPort>
 */

import { createServer, request as httpRequest } from "node:http";

const listenPort = Number(process.argv[2] ?? 8891);
const targetPort = Number(process.argv[3] ?? 8789);
const PREFIX = "/stage2";

const server = createServer((req, res) => {
  // CORS：测试页面由 vite 在另一个端口提供，浏览器直连这个转发服务是跨源的。
  // 在**这个测试专用转发层**加头，而不是给产品 API 加 CORS ——
  // 后者等于为测试改产品边界（本 API 的设计就是只经同源访问）。
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 探活：Playwright 的 webServer.url 发 GET /，它不在 PREFIX 下。
  // 这里必须先应答，否则探活一直 404、整个测试套件起不来。
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, target: targetPort }));
    return;
  }

  if (!req.url?.startsWith(PREFIX)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `只转发 ${PREFIX}/*` }));
    return;
  }

  // 剥掉前缀：/stage2/api/health → /api/health
  const path = req.url.slice(PREFIX.length) || "/";

  const upstream = httpRequest(
    { host: "127.0.0.1", port: targetPort, method: req.method, path, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on("error", (err) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `上游不可达：${err.message}` }));
  });

  req.pipe(upstream);
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(
    `stage2 转发就绪：http://127.0.0.1:${listenPort}${PREFIX}/* → 127.0.0.1:${targetPort}`,
  );
});
