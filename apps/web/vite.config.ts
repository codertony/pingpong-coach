/// <reference types="node" />
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const webRoot = dirname(fileURLToPath(import.meta.url));

/**
 * 把 MediaPipe 的 WASM 运行时从 node_modules 铺进 `public/wasm`。
 *
 * **为什么必须是构建的一步，而不是文档里的一条 `cp`。**
 * `public/models` 与 `public/wasm` 都在 `.gitignore` 里（不进仓库），但**只有模型有权重下载脚本**
 * （`models:fetch`）—— WASM 谁都不负责。于是构建产物里到底有没有 WASM，
 * 取决于**构建这台机器上有没有人手跑过那条 `cp`**：
 *
 * - 本机开发（改成本插件之前）：照清单跑过那条 `cp` 的人有，别人没有；
 * - **生产镜像：一定没有** —— `.dockerignore` 明确排除了 `apps/web/public/wasm`
 *   （并注明"wasm 来自 node_modules，装依赖时就有"），而整个构建里**没有任何一步**
 *   把它复制过去：`pnpm models:fetch` 只下权重，`vite build` 对空的 public 目录
 *   不报任何错。所以镜像能构建成功、健康检查也过，只是**骨架永远出不来** ——
 *   正是 F-007 的症状，搬到了生产环境。
 *
 * 缺包时**抛错**：宁可构建失败，也不要产出一个"能起来、界面正常、就是没有骨架"的产物
 * ——那种失败没有任何一处会报红。
 */
function stageMediapipeWasm(): Plugin {
  const src = resolve(webRoot, "node_modules/@mediapipe/tasks-vision/wasm");
  const dest = resolve(webRoot, "public/wasm");

  const stage = (): void => {
    if (!existsSync(src)) {
      throw new Error(
        `找不到 MediaPipe 的 WASM 目录：${src}\n` +
          `@mediapipe/tasks-vision 没装，或者包内布局变了。` +
          `不要绕过这一步 —— 缺了它产物里就没有 WASM，姿态引擎在浏览器里起不来。`,
      );
    }
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      const from = resolve(src, name);
      const to = resolve(dest, name);
      // 大小一致就认为已铺过：dev server 每次启动都重拷 11 MB 没有必要
      if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
      copyFileSync(from, to);
    }
  };

  return {
    name: "stage-mediapipe-wasm",
    // dev 与 build 两条路都要：`vite` 直接吃 public/ 下的文件，
    // 而 playwright 的 e2e 起的正是 dev server。
    buildStart: stage,
    configureServer: stage,
  };
}

export default defineConfig({
  plugins: [stageMediapipeWasm(), react()],
  server: {
    /*
     * 显式绑定回环地址。
     *
     * 为什么必须显式写：vite 默认绑 `localhost`，在 Windows 上会解析成 IPv6
     * 的 `::1` —— 实测表现是 `http://localhost:5173` 通、`http://127.0.0.1:5173`
     * **连不上**（netstat 只看到 `[::1]:5173`）。而 README 与本项目的其它文档
     * 写的都是 127.0.0.1，用户照着敲会打不开。
     *
     * 绑 `127.0.0.1` 后两个地址都能访问（实测）。
     * 用环境变量 HOST 可覆盖；Playwright 仍会通过命令行 `--host` 传入，优先级更高。
     */
    host: process.env.HOST ?? "127.0.0.1",
    // P1 使用 Vite 开发代理让前端调用 Node（方案第 14 节）
    proxy: {
      "/api": {
        target: process.env.API_ORIGIN ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
    headers: {
      // 允许在 Worker 中使用 SharedArrayBuffer 等能力所需的隔离（按需）
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // MediaPipe 的 wasm 资源不做预打包
    exclude: ["@mediapipe/tasks-vision"],
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
