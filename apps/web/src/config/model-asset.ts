/**
 * 模型资产配置。
 *
 * WASM 与 .task 文件通过**本项目静态资源路径**提供，
 * 避免每次训练依赖外部 CDN。
 * 实际文件由 `pnpm models:fetch` 下载并校验，清单见 models/manifest.json。
 */

import type { ModelAsset } from "../vision/pose-engine.js";

/**
 * 首版使用 Pose Landmarker **Full** 版本做质量候选（方案 P0）。
 * 之后用同一素材比较 Lite 是否能改善速度；Heavy 只在证据表明收益值得时尝试。
 * 最终模型必须通过同一素材选定，不能仅凭型号推断质量。
 */
export const MODEL_ASSET: ModelAsset = {
  modelId: import.meta.env.VITE_MODEL_ID_ASSET ?? "pose_landmarker_full",
  modelAssetPath: "/models/pose_landmarker_full.task",
  // 手部 21 点：姿态模型每只手只有腕加三个粗点，看不到指节。
  // 这是**可选增强** —— 它加载失败时姿态链路照常工作，只是没有手指细节，
  // 引擎会在状态里如实标记 handModelAvailable=false。
  handModelAssetPath: "/models/hand_landmarker.task",
  // 必须是带 origin 的绝对 URL，且不带尾斜杠：
  // MediaPipe 在运行期动态 import(`${wasmBasePath}/vision_wasm_internal.js`)，
  // 而 Vite dev 会把以 "/" 开头的动态 import 改写成 `?import`，
  // 指向 public/ 的文件被 import 会直接 500；写成 "/wasm/" 则会命中
  // SPA 回退返回 index.html，浏览器按模块解析 HTML 失败。
  // 绝对 URL 不在 Vite 的改写范围内（见 vite 的 injectQuery 实现）。
  wasmBasePath: new URL("/wasm", document.baseURI).href,
  // 先尝试 GPU，失败时 Worker 会自动降级到 CPU 并如实回报
  preferredDelegate: "GPU",
};
