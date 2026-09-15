/// <reference types="node" />
/**
 * Playwright 配置：真实浏览器测试。
 *
 * 与 vitest 的分工：
 * - vitest（node 环境）：纯逻辑，跑得快，覆盖算法与状态机；
 * - 这里（真实 Chromium）：只测那些「jsdom 根本模拟不了」的东西 ——
 *   Canvas 真实像素、真实 Worker 跨线程通信、真实 ImageBitmap 生命周期、真实 fetch。
 *
 * 明确的边界：**本套件不验证 MediaPipe 真实推理**。
 * Pose Landmarker 的 .task 模型托管在 storage.googleapis.com，
 * 在受限网络下不可获取；即使能获取，也需要真实球拍/人体画面才有意义。
 * 见 docs/known-failures.md 的 F-006。
 */

import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.E2E_PORT ?? 5199);
/** 集成测试用的真实 API 进程端口（mock 模式）。与开发默认的 8787 错开。 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 8788);

/**
 * 选择浏览器可执行文件。
 *
 * 优先顺序：
 * 1. 环境变量 CHROMIUM_PATH（显式指定，最高优先级）
 * 2. 系统常见路径（Linux 沙箱 / Ubuntu CI 预装）
 * 3. undefined —— 交给 Playwright 用它自己下载的浏览器
 *
 * 这样在沙箱和 CI 里能复用系统 Chromium（省下载），
 * 在普通开发机上则自动回落到 Playwright 自带浏览器，无需任何配置。
 */
function resolveChromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : [
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/google-chrome",
          "/snap/bin/chromium",
        ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // 忽略探测失败，继续尝试下一个
    }
  }
  return undefined;
}

const executablePath = resolveChromiumPath();

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: {
      // 容器内跑 Chromium 必须关沙箱，否则会因权限被拒。
      // 假摄像头：让采集链路在无摄像头的机器与 CI 上也能确定性跑通（app.e2e.ts）。
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
      executablePath,
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // 复用 vite dev server；夹具页走 vite 才能解析 TS 与 workspace 包。
  // 必须显式 --host 127.0.0.1：vite 默认绑 localhost，在容器/CI 里
  // localhost 可能不解析到 127.0.0.1，导致 Playwright 探活一直失败。
  //
  // 第二个 webServer 是**真实 API 进程**（集成测试用）。
  // 为什么必须起真的：`api-client.e2e.ts` 用 page.route 造假响应，
  // 那测的是"前端拿到某个响应会怎么处理"，测不到"这条 HTTP 真的通不通"。
  // F-007/F-008/F-011 三个缺陷都藏在这种缝里。这里让 vite 把 /api 代理到
  // 真实 Fastify 进程，前端 fetch 会真的打到它。
  // 走 mock 模式：测试环境不提供密钥，也不会把密钥写进测试。
  webServer: [
    {
      // 注意：命令里**不能**写 `PORT=8788 pnpm ...` —— Playwright 在 Windows 上
      // 用 cmd.exe 执行，那种 POSIX 前缀语法会被当成程序名而失败。
      // 端口一律通过 env 传（跨平台）。
      command: `pnpm --filter @pingpong/api start`,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      cwd: resolveRepoRoot(),
      env: { PORT: String(API_PORT), HOST: "127.0.0.1" },
    },
    {
      command: `pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}/e2e/fixtures/fixture.html`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { API_ORIGIN: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});

/** 仓库根目录（从 apps/web 往上两级）。 */
function resolveRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
