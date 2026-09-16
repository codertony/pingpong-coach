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
 * 第二个 API 实例：**live 模式**，模型端点指向本地假供应商。
 *
 * 存在的理由：红线 8 要求"模型输出必须在服务端校验"，而 mock 模式根本不经过
 * 模型调用 —— 那条校验路径在所有其它用例里都走不到，而它正是红线所在。
 */
const API_LIVE_PORT = Number(process.env.E2E_API_LIVE_PORT ?? 8789);
const FAKE_MODEL_PORT = Number(process.env.E2E_FAKE_MODEL_PORT ?? 8790);
/** 把前端请求转到 live 实例的转发服务（见 scripts/e2e-stage2-proxy.mjs）。 */
const STAGE2_PORT = Number(process.env.E2E_STAGE2_PORT ?? 8891);

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

/**
 * 仓库根目录（从 apps/web 往上两级）。
 *
 * 用 const 而不是函数：它只在下面的 webServer 数组里用一次，
 * 而那个数组是对象字面量的一部分 —— 不能在里面写语句。
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
  // 第 2 个 webServer 是**真实 API 进程**（集成测试用）。
  // 为什么必须起真的：`api-client.e2e.ts` 用 page.route 造假响应，
  // 那测的是"前端拿到某个响应会怎么处理"，测不到"这条 HTTP 真的通不通"。
  // F-007/F-008/F-011 三个缺陷都藏在这种缝里。
  //
  // 第 3、4、5 个只服务**红线 8 那一条用例**：live 实例 + 假供应商 + 转发。
  // 为什么值得三个进程：服务端校验模型输出这条路径，mock 模式永远走不到，
  // 而它是本项目最硬的安全约束之一（伪造证据不得被播报）。
  //
  // 路径一律用绝对路径：webServer 的 cwd 是 apps/web，相对路径会解析错。
  webServer: [
    {
      // 假模型供应商
      command: `node ${resolve(repoRoot, "scripts/e2e-fake-model.mjs")} ${FAKE_MODEL_PORT}`,
      url: `http://127.0.0.1:${FAKE_MODEL_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // live 模式 API：三要素齐备才会进 live（见 apps/api/src/config.ts）
      command: `pnpm --filter @pingpong/api start`,
      url: `http://127.0.0.1:${API_LIVE_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      cwd: repoRoot,
      env: {
        PORT: String(API_LIVE_PORT),
        HOST: "127.0.0.1",
        // 测试**绝不能**继承开发者本机的 .env —— 否则会跑成 live 并真的花钱。
        // 实测踩到过：加了 .env 之后 e2e 直接打到真实模型上（见 F-041）。
        PPC_NO_ENV_FILE: "1",
        // 假密钥：测试环境不放任何真实凭据
        MODEL_API_KEY: "test-key-not-a-real-secret",
        MODEL_BASE_URL: `http://127.0.0.1:${FAKE_MODEL_PORT}`,
        MODEL_ID: "fake-model-for-e2e",
      },
    },
    {
      // 把 /stage2/* 转到 live 实例。
      // 不用 vite 代理：实测 `/api-live` 会被 `/api` 规则先匹配走，
      // 而 rewrite/bypass 在这个版本的行为都与预期不符。独立转发服务行为可预测。
      command: `node ${resolve(repoRoot, "scripts/e2e-stage2-proxy.mjs")} ${STAGE2_PORT} ${API_LIVE_PORT}`,
      url: `http://127.0.0.1:${STAGE2_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // 注意：命令里**不能**写 `PORT=8788 pnpm ...` —— Playwright 在 Windows 上
      // 用 cmd.exe 执行，那种 POSIX 前缀语法会被当成程序名而失败。
      // 端口一律通过 env 传（跨平台）。
      command: `pnpm --filter @pingpong/api start`,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      cwd: repoRoot,
      // 同上：测试用 mock，不读 .env
      env: { PORT: String(API_PORT), HOST: "127.0.0.1", PPC_NO_ENV_FILE: "1" },
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
