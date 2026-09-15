import { z } from "zod";

/**
 * 事件锚点。
 *
 * 首版锚点是腕部速度峰值。它**不是**已确认的击球时刻：
 * 未可靠识别球拍接触球之前，不得把指标命名为 recovery_after_impact_ms。
 */
export const strokeAnchorSchema = z.object({
  type: z.enum(["wrist_speed_peak", "impact_confirmed", "manual"]),
  timeMs: z.number().finite().nonnegative(),
});

export type StrokeAnchor = z.infer<typeof strokeAnchorSchema>;

/**
 * 一次挥拍分段。
 * endMs 为 null 表示尚未闭合（仍在进行或异常结束）。
 */
export const strokeEventSchema = z.object({
  strokeId: z.string().min(1),
  startMs: z.number().finite().nonnegative(),
  endMs: z.number().finite().nonnegative().nullable(),
  anchor: strokeAnchorSchema,
  /** 仅当锚点类型为 impact_confirmed 且有可靠接触证据时才非 null。 */
  impactTimeMs: z.number().finite().nonnegative().nullable(),
  /** 只有完整走完 准备→引拍→向前→回到准备区 才为 true。 */
  complete: z.boolean(),
  /** 该次挥拍所用到的证据帧 ID，必须能回指到真实帧。 */
  evidenceFrameIds: z.array(z.string()),
  /** 不完整或低质量时的原因。 */
  reasons: z.array(z.string()),
});

export type StrokeEvent = z.infer<typeof strokeEventSchema>;

/** 状态机阶段。可解释状态机，首版不使用动作分类模型。 */
export const strokePhaseSchema = z.enum([
  "idle",
  "ready",
  "backswing",
  "forward",
  "returning",
  "aborted",
]);

export type StrokePhase = z.infer<typeof strokePhaseSchema>;

/** 分段配置。方向必须与机位、持拍手一起配置。 */
export const segmentationConfigSchema = z.object({
  strokeType: z.string().min(1),
  cameraView: z.string().min(1),
  handedness: z.enum(["left", "right"]),
  /** 准备区半径，单位为体尺度比例（不是厘米）。 */
  readyZoneRadiusBodyScale: z.number().positive(),
  /** 进入准备区后需要稳定的最短时间，防抖。 */
  readyStableMinMs: z.number().positive(),
  /** 离开准备区的最小位移，用于确认引拍开始。 */
  backswingMinDisplacementBodyScale: z.number().positive(),
  /** 判定向前挥拍所需的最小速度，单位为体尺度/秒。 */
  forwardMinSpeedBodyScalePerSec: z.number().positive(),
  /** 回到准备区后需要保持的时间，确认该次挥拍闭合。 */
  returnStableMinMs: z.number().positive(),
  /** 采样间断超过此值即标记不完整。 */
  maxGapMs: z.number().positive(),
  /** 一次挥拍的最大允许时长，超过即异常结束。 */
  maxStrokeDurationMs: z.number().positive(),
});

export type SegmentationConfig = z.infer<typeof segmentationConfigSchema>;
