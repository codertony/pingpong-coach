/**
 * 契约版本。任何破坏性字段变更都必须提升此版本，并保留旧评估样本的解释能力。
 * 见 docs/data-contracts.md。
 */
export const SCHEMA_VERSION = "1" as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

/** 规则版本：规则集内容变更时提升，用于把历史反馈关联到当时的判定依据。 */
export const RULE_VERSION = "1.0.0" as const;

/**
 * 统一语义关键点名。
 * 不直接使用引擎原生名称（MediaPipe 的 landmark index 或 COCO 名称），
 * 由 vision 适配层负责映射。缺失点保持缺失，不补零。
 */
export const KEYPOINT_NAMES = [
  "nose",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
] as const;

export type KeypointName = (typeof KEYPOINT_NAMES)[number];

/** 持拍侧。镜像预览不得改变此语义标签。 */
export type Handedness = "left" | "right";

/** 机位与朝向。方向相关的判定必须与该值一起配置。 */
export type CameraView =
  | "front"
  | "back"
  | "left_side"
  | "right_side"
  | "front_left_diagonal"
  | "front_right_diagonal"
  | "unknown";

export type StrokeType = "forehand_drive";

/** 关注点 ID。首版为回到准备区。 */
export const FOCUS_IDS = [
  "return_to_ready_zone",
  "elbow_extension_pattern",
  "elbow_relative_torso_drift",
  "intra_group_consistency",
] as const;

export type FocusId = (typeof FOCUS_IDS)[number];

/** 机位取值。与 CameraView 类型保持一致，供 Zod enum 复用。 */
export const CAMERA_VIEWS = [
  "front",
  "back",
  "left_side",
  "right_side",
  "front_left_diagonal",
  "front_right_diagonal",
  "unknown",
] as const;
