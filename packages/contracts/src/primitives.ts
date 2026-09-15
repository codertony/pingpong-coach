import { z } from "zod";
import {
  CAMERA_VIEWS,
  FOCUS_IDS,
  HAND_LANDMARK_NAMES,
  KEYPOINT_NAMES,
  SCHEMA_VERSION,
} from "./constants.js";

/**
 * 质量状态。三态而非布尔：区分"看不清"与"确有动作偏差"，
 * 二者使用不同错误码并分别统计。
 */
export const qualityStateSchema = z.enum(["usable", "limited", "unusable"]);
export type QualityState = z.infer<typeof qualityStateSchema>;

export const handednessSchema = z.enum(["left", "right"]);
export const cameraViewSchema = z.enum(CAMERA_VIEWS as unknown as [string, ...string[]]);
export const strokeTypeSchema = z.literal("forehand_drive");
export const focusIdSchema = z.enum(FOCUS_IDS as unknown as [string, ...string[]]);
/**
 * 合法关键点名 = 姿态点 + 手部点。
 *
 * 手部点与姿态点共用 `Keypoint2D` 结构，因为二者的坐标语义完全相同
 * （原始画面像素、缺失保持缺失）。用独立的命名前缀（`*_hand_wrist` 等）
 * 区分二者，避免与姿态的 `left_wrist` / `right_wrist` 混淆。
 */
export const ALL_KEYPOINT_NAMES = [...KEYPOINT_NAMES, ...HAND_LANDMARK_NAMES] as const;

export const keypointNameSchema = z.enum(ALL_KEYPOINT_NAMES as unknown as [string, ...string[]]);

/** 已知错误码。新增需同步 docs/data-contracts.md。 */
export const ERROR_CODES = [
  // 采集与设备
  "camera_permission_denied",
  "camera_unavailable",
  "video_decode_failed",
  // 视觉质量
  "arm_occluded",
  "keypoints_out_of_frame",
  "keypoint_jitter",
  "body_scale_jump",
  "sampling_gap_too_large",
  "low_visibility",
  // 分段
  "segmentation_incomplete",
  "not_a_practice_stroke",
  "no_stroke_detected",
  // 证据与请求
  "evidence_too_large",
  "insufficient_evidence",
  "evidence_ref_unknown",
  // 模型链路
  "model_timeout",
  "model_unavailable",
  "model_invalid_json",
  "model_forbidden_claim",
  "stale_session_response",
  "disallowed_drill",
  "reference_not_reviewed",
  // 通用
  "unsupported",
  "internal_error",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES as unknown as [string, ...string[]]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** 可复用的 schema 版本字段。 */
export const schemaVersionSchema = z.literal(SCHEMA_VERSION);
