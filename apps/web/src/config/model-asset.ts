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
  modelId: process.env.MODEL_ID_ASSET ?? "pose_landmarker_full",
  modelAssetPath: "/models/pose_landmarker_full.task",
  wasmBasePath: "/wasm/",
  // 先尝试 GPU，失败时 Worker 会自动降级到 CPU 并如实回报
  preferredDelegate: "GPU",
};
