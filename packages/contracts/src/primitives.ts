import { z } from "zod";
import {
  CAMERA_VIEWS,
  FOCUS_IDS,
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
export const cameraViewSchema = z.enum(
  CAMERA_VIEWS as unknown as [string, ...string[]],
);
export const strokeTypeSchema = z.literal("forehand_drive");
export const focusIdSchema = z.enum(
  FOCUS_IDS as unknown as [string, ...string[]],
);
export const keypointNameSchema = z.enum(
  KEYPOINT_NAMES as unknown as [string, ...string[]],
);

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

export const errorCodeSchema = z.enum(
  ERROR_CODES as unknown as [string, ...string[]],
);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** 可复用的 schema 版本字段。 */
export const schemaVersionSchema = z.literal(SCHEMA_VERSION);
