import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
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
