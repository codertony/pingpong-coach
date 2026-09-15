import { z } from "zod";
import { qualityStateSchema, schemaVersionSchema } from "./primitives.js";

/** 坐标空间。原始画面坐标与身体相对坐标必须分开保存。 */
export const coordinateSpaceSchema = z.enum(["image_2d", "body_relative_2d"]);

/** 单位。像素位移按标定尺度归一化后不得标成真实厘米。 */
export const featureUnitSchema = z.enum(["deg", "ms", "px", "body_scale"]);

/**
 * 单个特征值。
 *
 * 缺失一律使用 value: null + reasonIfMissing，**不使用 0 填补缺失**。
 * 0 是合法测量值，与"没测到"必须可区分。
 */
export const featureValueSchema = z.object({
  id: z.string().min(1),
  value: z.number().finite().nullable(),
  unit: featureUnitSchema,
  coordinateSpace: coordinateSpaceSchema,
  /** 该特征所依据的时间区间，用于复查与曲线展示。 */
  intervalMs: z.tuple([z.number().finite(), z.number().finite()]),
  quality: qualityStateSchema,
  reasonIfMissing: z.string().nullable(),
});

export type FeatureValue = z.infer<typeof featureValueSchema>;

/** 特征 ID 常量。命名必须诚实反映实际测量到什么。 */
export const FEATURE_IDS = {
  /** 肩—肘—腕三点二维夹角。180 度表示伸直。 */
  ELBOW_ANGLE_RANGE: "elbow_angle_range_deg",
  ELBOW_ANGLE_AT_FORWARD_PEAK: "elbow_angle_at_forward_peak_deg",
  /** 消除整体平移后肘部相对躯干的移动幅度。 */
  ELBOW_TORSO_DRIFT: "elbow_relative_torso_drift_body_scale",
  /**
   * 从腕部速度峰值到重新进入准备区的时间。
   * 注意命名：未确认为击球，所以不叫 recovery_after_impact_ms。
   */
  RETURN_AFTER_WRIST_PEAK: "return_after_wrist_peak_ms",
  /** 组内一致性：同条件多次挥拍同一特征的离散程度。 */
  INTRA_GROUP_CONSISTENCY: "intra_group_consistency_cv",
} as const;

export type FeatureId = (typeof FEATURE_IDS)[keyof typeof FEATURE_IDS];

/** 完整特征集。 */
export const featureSetSchema = z.object({
  // 复用统一版本常量，而不是硬编码 "1"。
  // 硬编码会在 SCHEMA_VERSION 提升时静默脱节：其余 schema 都升了版本，
  // 这里还认旧的，导致老数据被误判为当前格式。
  schemaVersion: schemaVersionSchema,
  sessionId: z.string().min(1),
  groupId: z.string().min(1),
  strokeIds: z.array(z.string()),
  features: z.array(featureValueSchema),
  computedAtMonoMs: z.number().finite().nonnegative(),
});

export type FeatureSet = z.infer<typeof featureSetSchema>;
