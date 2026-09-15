/**
 * 质量检查。
 *
 * 方案第 8.1 节的关键判断：**关键点模型分数较高也可能定位错误。**
 * 因此不能只看 score，至少还要结合：
 *   1) 时间连续性（是否跳变）
 *   2) 骨段长度突变（人体骨段长度不会瞬变）
 *   3) 画面范围（是否出画/贴边）
 *   4) 关键阶段的采样间隔
 *
 * 并且对"看不清"与"确有动作偏差"使用不同错误码，分别统计。
 * 本模块只负责"看不清"这一类；动作偏差属于特征与规则层。
 */

import type { Keypoint2D, PoseFrame, QualityState } from "@pingpong/contracts";
import { distance, isUsablePoint, median, type Point2D } from "./geometry.js";

export interface QualityConfig {
  /** 低于此分数的关键点视为不可靠 */
  minScore: number;
  /** 关节离画面边缘小于此像素数即视为不可靠 */
  edgeMarginPx: number;
  /** 允许的骨段长度相对变化率，超过即判定跳变 */
  maxBoneLengthRatio: number;
  /** 允许的单帧最大位移（相对体尺度），超过即判定跳变 */
  maxJumpBodyScale: number;
  /** 关键阶段允许的最大采样间隔 */
  maxGapMs: number;
  /** 有效帧比例门槛：低于此值整组不可判 */
  minUsableFrameRatio: number;
}

export const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  minScore: 0.5,
  edgeMarginPx: 4,
  maxBoneLengthRatio: 0.35,
  maxJumpBodyScale: 0.35,
  maxGapMs: 200,
  minUsableFrameRatio: 0.8,
};

/** 单帧质量评估结果 */
export interface FrameQualityResult {
  quality: QualityState;
  reasons: string[];
}

function toPoint(kp: Keypoint2D | undefined): Point2D | null {
  if (!kp) return null;
  if (kp.visible === false) return null;
  if (!isUsablePoint({ x: kp.xPx, y: kp.yPx })) return null;
  return { x: kp.xPx, y: kp.yPx };
}

export function findKeypoint(frame: PoseFrame, name: string): Keypoint2D | undefined {
  return frame.keypoints2D.find((k) => k.name === name);
}

export function pointOf(frame: PoseFrame, name: string): Point2D | null {
  return toPoint(findKeypoint(frame, name));
}

/**
 * 持拍侧关键点集合。检查持拍侧完整链：肩 → 肘 → 腕。
 * 用 13 点模型时这三点都要看，缺一不可。
 */
export function racketSideKeypointNames(handedness: "left" | "right"): string[] {
  return [`${handedness}_shoulder`, `${handedness}_elbow`, `${handedness}_wrist`];
}

/**
 * 评估单帧质量。
 *
 * @param frame 当前帧
 * @param handedness 持拍手。**不由帧推断**，由用户显式选择后传入。
 * @param previous 上一帧可用帧，用于跳变检测；无则跳过跳变检查
 * @param config 质量配置
 */
export function assessFrameQuality(
  frame: PoseFrame,
  handedness: "left" | "right",
  previous: PoseFrame | null = null,
  config: QualityConfig = DEFAULT_QUALITY_CONFIG,
): FrameQualityResult {
  const reasons: string[] = [];
  let severity: QualityState = "usable";

  const escalate = (level: QualityState) => {
    const order: QualityState[] = ["usable", "limited", "unusable"];
    if (order.indexOf(level) > order.indexOf(severity)) severity = level;
  };

  const names = racketSideKeypointNames(handedness);
  const points: Array<{ name: string; kp: Keypoint2D }> = [];

  // 1) 可见性与分数
  for (const name of names) {
    const kp = findKeypoint(frame, name);
    if (!kp) {
      reasons.push(`missing_keypoint:${name}`);
      escalate("unusable");
      continue;
    }
    if (kp.visible === false) {
      reasons.push(`not_visible:${name}`);
      escalate("unusable");
      continue;
    }
    if (kp.score != null && kp.score < config.minScore) {
      reasons.push(`low_score:${name}`);
      escalate("limited");
    }
    points.push({ name, kp });
  }

  // 2) 画面范围：贴边视为不可靠
  for (const { name, kp } of points) {
    if (
      kp.xPx < config.edgeMarginPx ||
      kp.yPx < config.edgeMarginPx ||
      kp.xPx > frame.imageWidth - config.edgeMarginPx ||
      kp.yPx > frame.imageHeight - config.edgeMarginPx
    ) {
      reasons.push(`out_of_frame:${name}`);
      escalate("unusable");
    }
  }

  // 3) 骨段长度突变：肩—肘、肘—腕 的长度不会在相邻帧瞬变
  if (previous && previous.sourceEpoch === frame.sourceEpoch) {
    const pairs: Array<[string, string]> = [
      [`${names[0]}`, `${names[1]}`],
      [`${names[1]}`, `${names[2]}`],
    ];
    for (const [a, b] of pairs) {
      const pa = pointOf(frame, a);
      const pb = pointOf(frame, b);
      const qa = pointOf(previous, a);
      const qb = pointOf(previous, b);
      if (!pa || !pb || !qa || !qb) continue;
      const cur = distance(pa, pb);
      const prev = distance(qa, qb);
      if (cur == null || prev == null || prev === 0) continue;
      const ratio = Math.abs(cur - prev) / prev;
      if (ratio > config.maxBoneLengthRatio) {
        reasons.push(`bone_length_jump:${a}-${b}`);
        escalate("limited");
      }
    }
  }

  // 4) 采样间隔
  if (previous && previous.sourceEpoch === frame.sourceEpoch) {
    const gap = frame.sourceTimeMs - previous.sourceTimeMs;
    if (gap > config.maxGapMs) {
      reasons.push("sampling_gap");
      escalate("limited");
    }
    if (gap <= 0) {
      reasons.push("non_monotonic_time");
      escalate("unusable");
    }
  }

  return { quality: severity, reasons };
}

/**
 * 整组质量汇总。
 *
 * 有效帧比例 = quality === "usable" 的帧数 / 总帧数。
 * 分母包含所有被采集的帧，不允许只统计"看起来没问题"的帧来美化比例。
 */
export interface GroupQualitySummary {
  totalFrames: number;
  usableFrames: number;
  limitedFrames: number;
  unusableFrames: number;
  usableRatio: number;
  /** 是否达到可判门槛 */
  judgeable: boolean;
  reasons: string[];
}

export function summarizeGroupQuality(
  frames: PoseFrame[],
  config: QualityConfig = DEFAULT_QUALITY_CONFIG,
): GroupQualitySummary {
  let usable = 0;
  let limited = 0;
  let unusable = 0;
  const reasonSet = new Set<string>();

  for (const f of frames) {
    if (f.quality === "usable") usable++;
    else if (f.quality === "limited") limited++;
    else unusable++;
    for (const r of f.qualityReasons) reasonSet.add(r);
  }

  const total = frames.length;
  const ratio = total === 0 ? 0 : usable / total;
  return {
    totalFrames: total,
    usableFrames: usable,
    limitedFrames: limited,
    unusableFrames: unusable,
    usableRatio: ratio,
    judgeable: total > 0 && ratio >= config.minUsableFrameRatio,
    reasons: [...reasonSet],
  };
}

/**
 * 处理频率与丢帧统计。
 *
 * 三者可能不同：摄像头请求帧率、实际回调频率、真实姿态处理频率。
 * 即便相机录到 60 FPS，程序只处理 25 FPS，也不能声称获得 60 FPS 的关节时序。
 */
export interface SamplingStats {
  processedFrames: number;
  processedFps: number | null;
  /** 相邻处理帧间隔的中位数 */
  medianIntervalMs: number | null;
  /** 超过 maxGapMs 的空隙数量 */
  gapCount: number;
  /** 最大空隙 */
  maxGapMs: number | null;
  /** 时间是否单调递增 */
  monotonic: boolean;
}

export function computeSamplingStats(
  times: number[],
  config: QualityConfig = DEFAULT_QUALITY_CONFIG,
): SamplingStats {
  const n = times.length;
  if (n < 2) {
    return {
      processedFrames: n,
      processedFps: null,
      medianIntervalMs: null,
      gapCount: 0,
      maxGapMs: null,
      monotonic: true,
    };
  }

  const intervals: number[] = [];
  let monotonic = true;
  let gapCount = 0;
  let maxGap: number | null = null;

  for (let i = 1; i < n; i++) {
    const cur = times[i];
    const prev = times[i - 1];
    if (cur == null || prev == null) continue;
    const d = cur - prev;
    if (d <= 0) {
      monotonic = false;
      continue;
    }
    intervals.push(d);
    if (d > config.maxGapMs) gapCount++;
    if (maxGap == null || d > maxGap) maxGap = d;
  }

  const med = median(intervals);
  return {
    processedFrames: n,
    processedFps: med != null && med > 0 ? 1000 / med : null,
    medianIntervalMs: med,
    gapCount,
    maxGapMs: maxGap,
    monotonic,
  };
}
