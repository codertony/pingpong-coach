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

/**
 * 手部关键点名（MediaPipe Hand Landmarker 的 21 点）。
 *
 * 为什么用它：姿态模型（BlazePose）每只手只有腕加三个粗点，
 * 看不到指节，因而无法回答"手指在做什么"这类问题。
 *
 * ⚠️ **红线 3 约束**：这些点可以用于**测量**可见的指关节几何
 * （例如手指屈曲角度），但**不得**据此推断：
 * - 精确拍面姿态 / 拍面朝向 —— 拍面方向取决于握拍方式与三维旋转，
 *   单目二维骨架无法确定，红线 3 明确点名禁止；
 * - 握力、肌肉紧张。
 * 相关几何量必须按"观测值"命名并标注 `estimate`，不得命名成"拍面角度"。
 */
export const HAND_LANDMARK_NAMES = [
  "left_hand_wrist",
  "left_thumb_cmc",
  "left_thumb_mcp",
  "left_thumb_ip",
  "left_thumb_tip",
  "left_index_mcp",
  "left_index_pip",
  "left_index_dip",
  "left_index_tip",
  "left_middle_mcp",
  "left_middle_pip",
  "left_middle_dip",
  "left_middle_tip",
  "left_ring_mcp",
  "left_ring_pip",
  "left_ring_dip",
  "left_ring_tip",
  "left_pinky_mcp",
  "left_pinky_pip",
  "left_pinky_dip",
  "left_pinky_tip",
  "right_hand_wrist",
  "right_thumb_cmc",
  "right_thumb_mcp",
  "right_thumb_ip",
  "right_thumb_tip",
  "right_index_mcp",
  "right_index_pip",
  "right_index_dip",
  "right_index_tip",
  "right_middle_mcp",
  "right_middle_pip",
  "right_middle_dip",
  "right_middle_tip",
  "right_ring_mcp",
  "right_ring_pip",
  "right_ring_dip",
  "right_ring_tip",
  "right_pinky_mcp",
  "right_pinky_pip",
  "right_pinky_dip",
  "right_pinky_tip",
] as const;

export type HandLandmarkName = (typeof HAND_LANDMARK_NAMES)[number];

/** 关键点集合名称。手部模型启用时集合是两者之和，必须显式区分。 */
export const KEYPOINT_SET_POSE_ONLY = "blaze_33";
export const KEYPOINT_SET_POSE_AND_HAND = "blaze_33+hand_21";

export type KeypointSetName = typeof KEYPOINT_SET_POSE_ONLY | typeof KEYPOINT_SET_POSE_AND_HAND;

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
