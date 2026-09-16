/**
 * 模型资产配置。
 *
 * WASM 与 .task 文件通过**本项目静态资源路径**提供，
 * 避免每次训练依赖外部 CDN。
 * 实际文件由 `pnpm models:fetch` 下载并校验，清单见 models/manifest.json。
 */

import type { ModelAsset } from "../vision/pose-engine.js";

/**
 * 姿态模型的 id → 资产路径。
 *
 * 为什么要有这张表（而不是把路径硬编码在下面）：
 * `VITE_MODEL_ID_ASSET` 的用途是在**同一素材**上比较 full 与 lite
 * （见 models/manifest.json 里 lite 的 role: speed-comparison）。
 * 但如果只让环境变量改 `modelId`、路径却写死，就会出现
 * **加载 full 权重、却上报 lite 的 modelId** 的分歧 ——
 * 而 `modelId` 是写进 `PoseFrame`、用于评估与费用归因的。
 * 那等于伪造溯源，比读错一个数字严重得多。
 *
 * 所以路径**由 id 推导**：改 id 就必须有对应路径，没有就当场抛错。
 */
const POSE_MODEL_PATHS: Record<string, string> = {
  pose_landmarker_full: "/models/pose_landmarker_full.task",
  pose_landmarker_lite: "/models/pose_landmarker_lite.task",
};

/**
 * 首版使用 Pose Landmarker **Full** 版本做质量候选（方案 P0）。
 * 之后用同一素材比较 Lite 是否能改善速度；Heavy 只在证据表明收益值得时尝试。
 * 最终模型必须通过同一素材选定，不能仅凭型号推断质量。
 */
const poseModelId = import.meta.env.VITE_MODEL_ID_ASSET ?? "pose_landmarker_full";

const poseModelPath = POSE_MODEL_PATHS[poseModelId];
if (!poseModelPath) {
  // 明确失败，不静默退回某个默认模型 —— 那样会加载一个和上报 id 不一致的权重
  throw new Error(
    `VITE_MODEL_ID_ASSET 设为「${poseModelId}」，但没有对应的资产路径。` +
      `可用值：${Object.keys(POSE_MODEL_PATHS).join(" / ")}（见 models/manifest.json）。`,
  );
}

export const MODEL_ASSET: ModelAsset = {
  modelId: poseModelId,
  modelAssetPath: poseModelPath,
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
