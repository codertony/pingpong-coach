import { z } from "zod";
import { schemaVersionSchema, qualityStateSchema, keypointNameSchema } from "./primitives.js";

/**
 * 单个二维关键点。
 *
 * 坐标约定（见 docs/data-contracts.md）：
 * - xPx / yPx 是**原始画面像素坐标**，不是归一化坐标。
 *   用归一化 x/y 计算角度前必须分别乘原图宽高，否则长宽比会造成角度失真。
 * - 镜像预览不得改变这里的坐标语义；镜像只在渲染层处理，
 *   并且不得改变人体真实左右标签。
 */
export const keypoint2DSchema = z.object({
  name: keypointNameSchema,
  xPx: z.number().finite(),
  yPx: z.number().finite(),
  /**
   * 引擎原始置信度。不得直接当作诊断正确率 —— 分数高也可能定位错误，
   * 必须结合时间连续性、骨段长度突变和画面范围一起判断。
   */
  score: z.number().min(0).max(1).nullable(),
  visible: z.boolean().nullable(),
});

export type Keypoint2D = z.infer<typeof keypoint2DSchema>;

/**
 * 一帧姿态结果。
 *
 * 时间字段的两种时钟不可混用：
 * - sourceTimeMs：源视频媒体时间。导入视频以此为准，
 *   不能用播放耗时计算运动速度。
 * - receivedAtMonoMs：浏览器收到帧时的单调时钟，只用于记录处理耗时，
 *   不冒充相机曝光时间。
 *
 * sourceEpoch 在 seek / 重播 / 切换摄像头时递增，用于重置跟踪与分段状态，
 * 保证向姿态引擎提供的时间符合其约束。
 */
export const poseFrameSchema = z.object({
  schemaVersion: schemaVersionSchema,
  sessionId: z.string().min(1),
  frameId: z.string().min(1),
  sourceEpoch: z.number().int().nonnegative(),
  sourceTimeMs: z.number().finite().nonnegative(),
  receivedAtMonoMs: z.number().finite().nonnegative(),
  /** 姿态模型标识。换模型后必须重新评测并记录此值。 */
  modelId: z.string().min(1),
  /** 关键点集合名称，用于跨引擎显式映射。 */
  keypointSet: z.string().min(1),
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  keypoints2D: z.array(keypoint2DSchema),
  quality: qualityStateSchema,
  qualityReasons: z.array(z.string()),
});

export type PoseFrame = z.infer<typeof poseFrameSchema>;

/** 图像变换记录。任何裁剪/旋转/镜像都必须留痕，否则复查无法对齐。 */
export const imageTransformSchema = z.object({
  rotationDeg: z.number().finite(),
  mirrored: z.boolean(),
  cropX: z.number().int().nonnegative(),
  cropY: z.number().int().nonnegative(),
  cropWidth: z.number().int().positive(),
  cropHeight: z.number().int().positive(),
  /** 变换前的原始画面尺寸，用于把坐标还原回原始像素空间。 */
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
});

export type ImageTransform = z.infer<typeof imageTransformSchema>;

export const IDENTITY_TRANSFORM: ImageTransform = {
  rotationDeg: 0,
  mirrored: false,
  cropX: 0,
  cropY: 0,
  cropWidth: 1,
  cropHeight: 1,
  sourceWidth: 1,
  sourceHeight: 1,
};
