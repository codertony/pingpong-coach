/**
 * 第一批特征计算。
 *
 * 命名纪律（方案 8.3）：
 * - 锚点是腕部速度峰值时，指标必须叫 `return_after_wrist_peak_ms`。
 *   未可靠识别球拍接触球之前，**不使用** `recovery_after_impact_ms`。
 * - 肘角是二维夹角，不能推断小臂发力大小。
 * - 肘相对躯干位移不能直接断言大臂肌肉僵硬。
 * - 组内一致性不能把"稳定地做错"判为正确。
 */

import type { FeatureValue, PoseFrame, QualityState } from "@pingpong/contracts";
import { FEATURE_IDS } from "@pingpong/contracts";
import { angleDeg, coefficientOfVariation, mean, median, type Point2D } from "./geometry.js";
import { pointOf } from "./quality.js";

/** 一帧里本组关注所需的几何量。 */
export interface FrameGeometry {
  frameId: string;
  sourceTimeMs: number;
  elbowAngleDeg: number | null;
  /** 肘相对肩髋中点（躯干参考点）的偏移，单位为体尺度倍数 */
  elbowRelTorsoBodyScale: { x: number; y: number } | null;
  bodyScalePx: number | null;
}

/**
 * 从一帧提取关注点的几何量。
 * 缺失点保持 null —— 不补零、不外推。
 */
export function extractFrameGeometry(
  frame: PoseFrame,
  handedness: "left" | "right",
): FrameGeometry {
  const shoulder = pointOf(frame, `${handedness}_shoulder`);
  const elbow = pointOf(frame, `${handedness}_elbow`);
  const wrist = pointOf(frame, `${handedness}_wrist`);
  const lHip = pointOf(frame, "left_hip");
  const rHip = pointOf(frame, "right_hip");
  const lShoulder = pointOf(frame, "left_shoulder");
  const rShoulder = pointOf(frame, "right_shoulder");

  // 肩—肘—腕 二维夹角。180 度表示伸直。
  const elbowAngleDeg = shoulder && elbow && wrist ? angleDeg(shoulder, elbow, wrist) : null;

  // 躯干参考点：双肩中点与双髋中点的连线中点，比单一肩点稳定
  let torsoRef: Point2D | null = null;
  if (lShoulder && rShoulder && lHip && rHip) {
    torsoRef = {
      x: (lShoulder.x + rShoulder.x + lHip.x + rHip.x) / 4,
      y: (lShoulder.y + rShoulder.y + lHip.y + rHip.y) / 4,
    };
  } else if (lShoulder && rShoulder) {
    torsoRef = {
      x: (lShoulder.x + rShoulder.x) / 2,
      y: (lShoulder.y + rShoulder.y) / 2,
    };
  }

  // 体尺度：肩中点—髋中点距离。缺髋时退化为肩宽，并在质量上体现。
  let bodyScalePx: number | null = null;
  if (lShoulder && rShoulder && lHip && rHip) {
    const sMid = {
      x: (lShoulder.x + rShoulder.x) / 2,
      y: (lShoulder.y + rShoulder.y) / 2,
    };
    const hMid = { x: (lHip.x + rHip.x) / 2, y: (lHip.y + rHip.y) / 2 };
    bodyScalePx = Math.hypot(sMid.x - hMid.x, sMid.y - hMid.y);
    if (bodyScalePx <= 0) bodyScalePx = null;
  }

  let elbowRelTorsoBodyScale: { x: number; y: number } | null = null;
  if (elbow && torsoRef && bodyScalePx != null && bodyScalePx > 0) {
    elbowRelTorsoBodyScale = {
      x: (elbow.x - torsoRef.x) / bodyScalePx,
      y: (elbow.y - torsoRef.y) / bodyScalePx,
    };
  }

  return {
    frameId: frame.frameId,
    sourceTimeMs: frame.sourceTimeMs,
    elbowAngleDeg,
    elbowRelTorsoBodyScale,
    bodyScalePx,
  };
}

function qualityOf(values: Array<number | null>): {
  quality: QualityState;
  reason: string | null;
} {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) {
    return { quality: "unusable", reason: "本区间内无可用测量点" };
  }
  if (present.length < values.length / 2) {
    return { quality: "limited", reason: "本区间超过一半采样点缺失" };
  }
  return { quality: "usable", reason: null };
}

/**
 * 肘角变化范围。用于观察引拍到向前挥拍期间肘部的伸展模式。
 * 不能推断小臂发力大小。
 */
export function computeElbowAngleRange(
  geometries: FrameGeometry[],
  intervalMs: [number, number],
): FeatureValue {
  const angles = geometries.map((g) => g.elbowAngleDeg);
  const q = qualityOf(angles);
  const present = angles.filter((v): v is number => v != null);
  const value = present.length === 0 ? null : Math.max(...present) - Math.min(...present);

  return {
    id: FEATURE_IDS.ELBOW_ANGLE_RANGE,
    value,
    unit: "deg",
    coordinateSpace: "image_2d",
    intervalMs,
    quality: q.quality,
    reasonIfMissing: value == null ? (q.reason ?? "无可用肘角测量") : q.reason,
  };
}

/**
 * 向前挥拍峰值附近的肘角。取区间内中位数，比取单点稳健。
 */
export function computeElbowAngleAtForwardPeak(
  geometries: FrameGeometry[],
  intervalMs: [number, number],
): FeatureValue {
  const angles = geometries.map((g) => g.elbowAngleDeg);
  const q = qualityOf(angles);
  const value = median(angles.filter((v): v is number => v != null));
  return {
    id: FEATURE_IDS.ELBOW_ANGLE_AT_FORWARD_PEAK,
    value,
    unit: "deg",
    coordinateSpace: "image_2d",
    intervalMs,
    quality: q.quality,
    reasonIfMissing: value == null ? (q.reason ?? "无可用肘角测量") : q.reason,
  };
}

/**
 * 肘相对躯干位移：消除整体平移后肘部移动幅度，单位为体尺度。
 * 不能直接断言大臂肌肉僵硬。
 */
export function computeElbowTorsoDrift(
  geometries: FrameGeometry[],
  intervalMs: [number, number],
): FeatureValue {
  const rels = geometries
    .map((g) => g.elbowRelTorsoBodyScale)
    .filter((v): v is { x: number; y: number } => v != null);

  if (rels.length === 0) {
    return {
      id: FEATURE_IDS.ELBOW_TORSO_DRIFT,
      value: null,
      unit: "body_scale",
      coordinateSpace: "body_relative_2d",
      intervalMs,
      quality: "unusable",
      reasonIfMissing: "本区间内无可用肘部或躯干参考点",
    };
  }

  const xs = rels.map((r) => r.x);
  const ys = rels.map((r) => r.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  // 位移幅度取包围盒对角线的长度，反映二维移动范围
  const value = Math.hypot(xMax - xMin, yMax - yMin);

  const { quality, reason } = qualityOf(
    geometries.map((g) => (g.elbowRelTorsoBodyScale ? 1 : null)),
  );

  return {
    id: FEATURE_IDS.ELBOW_TORSO_DRIFT,
    value,
    unit: "body_scale",
    coordinateSpace: "body_relative_2d",
    intervalMs,
    quality,
    // 与同文件其他特征保持一致：优先说明具体原因。
    // 这里 value 恒非 null（包围盒总存在），所以 reason 就是唯一的质量说明来源。
    // 若把 reason 丢掉，质量降级成 limited 时调用方将看不到任何解释，
    // 违反 AGENTS.md 红线 1（缺失/降级必须有理由）。
    reasonIfMissing: reason,
  };
}

/**
 * 从腕部速度峰值到重新进入准备区的时间。
 *
 * 命名严格对应锚点类型：锚点是 wrist_speed_peak，不是已确认的击球。
 * 所以这个值**不能**被解释为"击球后恢复时间"。
 */
export function computeReturnAfterWristPeak(
  wristPeakMs: number | null,
  returnedToZoneMs: number | null,
  intervalMs: [number, number],
): FeatureValue {
  const base: Omit<FeatureValue, "value" | "quality" | "reasonIfMissing"> = {
    id: FEATURE_IDS.RETURN_AFTER_WRIST_PEAK,
    unit: "ms",
    coordinateSpace: "image_2d",
    intervalMs,
  };

  if (wristPeakMs == null) {
    return {
      ...base,
      value: null,
      quality: "unusable",
      reasonIfMissing: "未检测到腕部速度峰值，锚点缺失",
    };
  }
  if (returnedToZoneMs == null) {
    return {
      ...base,
      value: null,
      quality: "limited",
      reasonIfMissing: "本组未观察到回到准备区，无法计算返回时间",
    };
  }
  const delta = returnedToZoneMs - wristPeakMs;
  if (delta < 0) {
    return {
      ...base,
      value: null,
      quality: "unusable",
      reasonIfMissing: "回到准备区发生在速度峰值之前，时序异常，拒绝给值",
    };
  }
  return { ...base, value: delta, quality: "usable", reasonIfMissing: null };
}

/**
 * 组内一致性：同一特征在多次挥拍间的变异系数。
 *
 * 关键限制：它只说明"是否稳定"，**不能说明是否做对**。
 * 稳定地做错同样会得到很低的一致性离散度。
 */
export function computeIntraGroupConsistency(
  perStrokeValues: Array<number | null>,
  featureId: string,
  intervalMs: [number, number],
): FeatureValue {
  const clean = perStrokeValues.filter((v): v is number => v != null);
  const base = {
    id: FEATURE_IDS.INTRA_GROUP_CONSISTENCY,
    unit: "body_scale" as const,
    coordinateSpace: "image_2d" as const,
    intervalMs,
  };

  if (clean.length < 2) {
    return {
      ...base,
      value: null,
      quality: "limited",
      reasonIfMissing: `有效挥拍不足 2 次，无法评价 ${featureId} 的组内一致性`,
    };
  }

  const cv = coefficientOfVariation(clean);
  if (cv == null) {
    return {
      ...base,
      value: null,
      quality: "limited",
      reasonIfMissing: `${featureId} 的均值接近 0，变异系数无解释意义`,
    };
  }

  return { ...base, value: cv, quality: "usable", reasonIfMissing: null };
}

/** 组内简单统计摘要，用于复查页展示与规则判断。 */
export interface GroupSummaryStats {
  count: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

export function summarizeValues(values: Array<number | null>): GroupSummaryStats {
  const clean = values.filter((v): v is number => v != null);
  if (clean.length === 0) {
    return { count: 0, mean: null, median: null, min: null, max: null };
  }
  return {
    count: clean.length,
    mean: mean(clean),
    median: median(clean),
    min: Math.min(...clean),
    max: Math.max(...clean),
  };
}
