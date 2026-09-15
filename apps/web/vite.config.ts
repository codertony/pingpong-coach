/// <reference types="node" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
