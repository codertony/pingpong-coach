/**
 * 训练会话编排。
 *
 * 把采集、推理、质量检查、分段、特征、证据与反馈串起来。
 *
 * 关键约束：
 * - 大模型调用**不阻塞**摄像头与本地分析。
 * - 每个会话最多一个模型请求在途；旧响应不播报。
 * - 反馈绑定 sessionId + groupId + focusId。
 */

import type {
  CoachFeedback,
  EvidencePacket,
  FeatureValue,
  Keypoint2D,
  PoseFrame,
  SegmentationConfig,
  StrokeEvent,
} from "@pingpong/contracts";
import { FEATURE_IDS, RULE_VERSION, SCHEMA_VERSION } from "@pingpong/contracts";
import {
  StrokeSegmenter,
  assessFrameQuality,
  computeElbowAngleRange,
  computeElbowTorsoDrift,
  computeIntraGroupConsistency,
  computeReturnAfterWristPeak,
  computeSamplingStats,
  DEFAULT_QUALITY_CONFIG,
  DEFAULT_THRESHOLDS,
  extractFrameGeometry,
  evaluateRule,
  BUILTIN_RULES,
  median,
  PointFilter,
  oneEuroConfig,
  summarizeGroupQuality,
  type FrameGeometry,
  type LocalVerdict,
} from "@pingpong/motion-core";
import type { PoseResult } from "../vision/pose-engine.js";
import {
  KeyframeCache,
  selectRepresentativeFrames,
  buildKeyframes,
} from "../evidence/evidence-builder.js";
import { toSpeechText } from "../audio/speech-channel.js";

export interface TrainingConfig {
  sessionId: string;
  strokeType: "forehand_drive";
  handedness: "left" | "right";
  cameraView: string;
  focusId: string;
  /** 本组需要的有效挥拍次数，默认 3（交互配置，不是算法要求） */
  strokesPerGroup: number;
  segmentation: SegmentationConfig;
}

export interface TrainingCallbacks {
  onFeedback: (feedback: CoachFeedback | null, verdict: LocalVerdict | null) => void;
  onGroupComplete: (packet: EvidencePacket) => void;
  onStatus: (text: string) => void;
  /** 本组新增一次有效挥拍 */
  onStroke: (stroke: StrokeEvent) => void;
}

export interface TrainingTelemetry {
  /** 姿态处理耗时 P95 */
  poseProcessingP95Ms: number | null;
  /** 本组从第一次挥拍开始到反馈可见的耗时 */
  groupFeedbackMs: number | null;
  /** 已处理的帧数与丢帧数 */
  framesProcessed: number;
  framesDropped: number;
  /** 实测处理频率 */
  actualFps: number | null;
  /** 有效帧比例 */
  usableRatio: number;
}

/** 把姿态结果转成 PoseFrame，并做质量评估。 */
export function toPoseFrame(
  result: PoseResult,
  sessionId: string,
  handedness: "left" | "right",
  previous: PoseFrame | null,
): PoseFrame {
  const provisional: PoseFrame = {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    frameId: result.frameId,
    sourceEpoch: result.sourceEpoch,
    sourceTimeMs: result.sourceTimeMs,
    receivedAtMonoMs: result.receivedAtMonoMs,
    modelId: "pose_landmarker",
    keypointSet: "blaze_33",
    imageWidth: result.imageWidth,
    imageHeight: result.imageHeight,
    keypoints2D: result.keypoints2D,
    quality: "usable",
    qualityReasons: [],
  };

  const q = assessFrameQuality(provisional, handedness, previous, DEFAULT_QUALITY_CONFIG);
  return { ...provisional, quality: q.quality, qualityReasons: q.reasons };
}

function findPoint(kps: Keypoint2D[], name: string): { x: number; y: number } | null {
  const kp = kps.find((k) => k.name === name);
  if (!kp || kp.visible === false) return null;
  if (!Number.isFinite(kp.xPx) || !Number.isFinite(kp.yPx)) return null;
  return { x: kp.xPx, y: kp.yPx };
}

/**
 * 训练会话。
 * 用法：创建 → pushPoseResult(逐帧) → closeGroup() 触发一次分析。
 */
export class TrainingSession {
  private readonly segmenter: StrokeSegmenter;
  private readonly wristFilter = new PointFilter(oneEuroConfig(1.0, 0.007));
  private readonly keyframeCache = new KeyframeCache();
  private readonly posesByFrameId = new Map<string, PoseFrame>();
  private readonly geometries: FrameGeometry[] = [];
  private readonly frameTimes: number[] = [];

  private previousFrame: PoseFrame | null = null;
  private validStrokes: StrokeEvent[] = [];
  private currentGroupIndex = 0;
  private readyZoneCenter: { x: number; y: number } | null = null;
  private poseLatencies: number[] = [];
  private groupFirstStrokeAtMs: number | null = null;
  private framesProcessed = 0;
  private framesDropped = 0;
  private lastRequestId: string | null = null;

  constructor(
    private readonly config: TrainingConfig,
    private readonly callbacks: TrainingCallbacks,
  ) {
    this.segmenter = new StrokeSegmenter(config.segmentation);
  }

  get groupId(): string {
    return `${this.config.sessionId}_g${this.currentGroupIndex}`;
  }

  /** 用户在拍摄检查页选定准备区中心。 */
  setReadyZone(center: { x: number; y: number }): void {
    this.readyZoneCenter = center;
    this.segmenter.setReadyZone(center);
  }

  get hasReadyZone(): boolean {
    return this.readyZoneCenter != null;
  }

  /** 源切换（seek/重播/切摄像头）时重置分段，避免跨片段污染。 */
  resetSegmentation(): void {
    this.segmenter.reset();
    this.wristFilter.reset();
    this.previousFrame = null;
  }

  markDropped(): void {
    this.framesDropped++;
  }

  /**
   * 投入一帧姿态结果。这是热路径，必须轻量。
   */
  pushPoseResult(result: PoseResult): void {
    this.framesProcessed++;
    this.poseLatencies.push(result.inferenceMs);
    if (this.poseLatencies.length > 500) this.poseLatencies.shift();
    this.frameTimes.push(result.sourceTimeMs);
    if (this.frameTimes.length > 500) this.frameTimes.shift();

    const frame = toPoseFrame(
      result,
      this.config.sessionId,
      this.config.handedness,
      this.previousFrame,
    );

    // 有界缓存：只保留姿态结果的引用，图片由 keyframeCache 单独管控
    this.posesByFrameId.set(frame.frameId, frame);
    if (this.posesByFrameId.size > 600) {
      const firstKey = this.posesByFrameId.keys().next().value;
      if (firstKey != null) this.posesByFrameId.delete(firstKey);
    }

    if (!result.detected) {
      this.callbacks.onStatus("画面中未检测到人体，请站到画面中央");
      this.previousFrame = frame;
      return;
    }

    const geom = extractFrameGeometry(frame, this.config.handedness);
    this.geometries.push(geom);
    if (this.geometries.length > 600) this.geometries.shift();

    // 腕部滤波：因果、单向，不偷看未来帧
    const rawWrist = findPoint(result.keypoints2D, `${this.config.handedness}_wrist`);
    const filteredWrist = rawWrist ? this.wristFilter.push(rawWrist, result.sourceTimeMs) : null;

    // 躯干参考与体尺度
    const lShoulder = findPoint(result.keypoints2D, "left_shoulder");
    const rShoulder = findPoint(result.keypoints2D, "right_shoulder");
    const lHip = findPoint(result.keypoints2D, "left_hip");
    const rHip = findPoint(result.keypoints2D, "right_hip");

    let bodyScalePx: number | null = null;
    if (lShoulder && rShoulder && lHip && rHip) {
      const sMid = { x: (lShoulder.x + rShoulder.x) / 2, y: (lShoulder.y + rShoulder.y) / 2 };
      const hMid = { x: (lHip.x + rHip.x) / 2, y: (lHip.y + rHip.y) / 2 };
      const d = Math.hypot(sMid.x - hMid.x, sMid.y - hMid.y);
      bodyScalePx = d > 0 ? d : null;
    }

    const stroke = this.segmenter.push({
      frameId: frame.frameId,
      sourceTimeMs: frame.sourceTimeMs,
      wristPx: filteredWrist,
      wristRelReadyZonePx:
        filteredWrist && this.readyZoneCenter
          ? {
              x: filteredWrist.x - this.readyZoneCenter.x,
              y: filteredWrist.y - this.readyZoneCenter.y,
            }
          : null,
      bodyScalePx,
      quality: frame.quality,
    });

    if (stroke) {
      this.onStrokeEvent(stroke);
    }

    this.previousFrame = frame;
  }

  private onStrokeEvent(stroke: StrokeEvent): void {
    if (!stroke.complete) {
      // 不完整样本只记录，不凑进有效挥拍数量
      this.callbacks.onStatus(
        `本次挥拍不完整（${stroke.reasons.join("、") || "原因未知"}），不计入本组`,
      );
      return;
    }

    this.validStrokes.push(stroke);
    if (this.groupFirstStrokeAtMs == null) this.groupFirstStrokeAtMs = stroke.startMs;
    this.callbacks.onStroke(stroke);

    const remaining = this.config.strokesPerGroup - this.validStrokes.length;
    if (remaining > 0) {
      this.callbacks.onStatus(
        `已记录 ${this.validStrokes.length} 次有效挥拍，还需 ${remaining} 次`,
      );
      // 一次挥拍足以判断的已验证目标可以更快更新本地状态
      this.emitLocalVerdictIfPossible();
      return;
    }

    // 本组够了：一次性构建证据并发起分析
    void this.completeGroup();
  }

  /** 在证据不足够时只做本地判断，不阻塞也不误导。 */
  private emitLocalVerdictIfPossible(): void {
    const features = this.computeFeatures();
    const quality = summarizeGroupQuality(
      [...this.posesByFrameId.values()],
      DEFAULT_QUALITY_CONFIG,
    );
    const rule = BUILTIN_RULES.find((r) => r.focusId === this.config.focusId);
    if (!rule) return;

    const verdict = evaluateRule({
      rule,
      features,
      validStrokeCount: this.validStrokes.length,
      judgeable: quality.judgeable,
    });

    // 只有拿到明确结论才回调，避免刷屏
    if (verdict.kind === "target_met" || verdict.kind === "suggest_adjustment") {
      this.callbacks.onFeedback(null, verdict);
    }
  }

  private computeFeatures(): FeatureValue[] {
    const features: FeatureValue[] = [];
    if (this.validStrokes.length === 0) return features;

    const first = this.validStrokes[0]!;
    const last = this.validStrokes[this.validStrokes.length - 1]!;
    const interval: [number, number] = [first.startMs, last.endMs ?? last.anchor.timeMs];

    const geometriesInGroup = this.geometries.filter(
      (g) => g.sourceTimeMs >= interval[0] && g.sourceTimeMs <= interval[1],
    );

    features.push(computeElbowAngleRange(geometriesInGroup, interval));
    features.push(computeElbowTorsoDrift(geometriesInGroup, interval));

    // 每次挥拍各自的返回准备区时间
    const returnTimes = this.validStrokes.map((s) => {
      const end = s.endMs;
      if (end == null) return null;
      const f = computeReturnAfterWristPeak(s.anchor.timeMs, end, [s.anchor.timeMs, end]);
      return f.value;
    });

    const medianReturn = median(returnTimes.filter((v): v is number => v != null));
    features.push(
      computeReturnAfterWristPeak(
        // 用中位数代表本组，锚点时间取第一次的峰值时间以保持区间语义
        medianReturn == null ? null : first.anchor.timeMs,
        medianReturn == null ? null : first.anchor.timeMs + medianReturn,
        interval,
      ),
    );

    // 组内一致性：返回准备区时间的离散程度
    features.push(
      computeIntraGroupConsistency(returnTimes, FEATURE_IDS.RETURN_AFTER_WRIST_PEAK, interval),
    );

    return features;
  }

  /** 本组收集完毕：构建证据包并回调，由上层发起模型调用。 */
  private async completeGroup(): Promise<void> {
    const features = this.computeFeatures();
    const poses = [...this.posesByFrameId.values()];
    const quality = summarizeGroupQuality(poses, DEFAULT_QUALITY_CONFIG);

    // 选代表性关键帧（最多 6 张）
    const candidates = this.validStrokes.flatMap((s) =>
      selectRepresentativeFrames(
        { startMs: s.startMs, endMs: s.endMs, anchor: s.anchor },
        // 这里用姿态帧代替真实图片候选，真实图片压缩在 capture 层完成
        poses
          .filter(
            (p) => p.sourceTimeMs >= s.startMs && (s.endMs == null || p.sourceTimeMs <= s.endMs),
          )
          .map((p) => ({
            frameId: p.frameId,
            sourceTimeMs: p.sourceTimeMs,
            bytes: new Uint8Array(0),
            width: p.imageWidth,
            height: p.imageHeight,
            pinned: false,
          })),
      ),
    );

    // 关键帧必须与姿态帧通过 frameId 对齐
    const { keyframes } = buildKeyframes(
      candidates.map((c) => c.frameId),
      this.keyframeCache,
      this.posesByFrameId,
    );

    this.lastRequestId = `${this.groupId}_${Date.now()}`;
    const packet: EvidencePacket = {
      schemaVersion: SCHEMA_VERSION,
      requestId: this.lastRequestId,
      sessionId: this.config.sessionId,
      groupId: this.groupId,
      focusId: this.config.focusId,
      strokeType: this.config.strokeType,
      handedness: this.config.handedness,
      cameraView: this.config.cameraView,
      strokes: this.validStrokes,
      features,
      keyframes,
      ruleVersion: RULE_VERSION,
      referenceId: null,
      limitations: [
        "单目二维骨架，无法判断肌肉紧张、发力大小、足底承重或力量传递效率",
        "事件锚点为腕部速度峰值，不是已确认的击球时刻",
        ...(quality.judgeable ? [] : ["本组画质未达到可判门槛"]),
      ],
      readyZone: this.readyZoneCenter
        ? {
            xPx: this.readyZoneCenter.x,
            yPx: this.readyZoneCenter.y,
            radiusPx: this.config.segmentation.readyZoneRadiusBodyScale * 200,
          }
        : null,
    };

    const localVerdict = (() => {
      const rule = BUILTIN_RULES.find((r) => r.focusId === this.config.focusId);
      if (!rule) return null;
      return evaluateRule({
        rule,
        features,
        validStrokeCount: this.validStrokes.length,
        judgeable: quality.judgeable,
      });
    })();

    this.callbacks.onGroupComplete(packet);
    // 本地规则立即给出结论，不等待模型
    this.callbacks.onFeedback(null, localVerdict);

    // 进入下一组
    this.currentGroupIndex++;
    this.validStrokes = [];
    this.groupFirstStrokeAtMs = null;
    this.segmenter.reset();
  }

  get telemetry(): TrainingTelemetry {
    const sorted = [...this.poseLatencies].sort((a, b) => a - b);
    const p95 =
      sorted.length === 0
        ? null
        : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null);

    const sampling = computeSamplingStats(this.frameTimes, DEFAULT_QUALITY_CONFIG);
    const poses = [...this.posesByFrameId.values()];
    const quality = summarizeGroupQuality(poses, DEFAULT_QUALITY_CONFIG);

    return {
      poseProcessingP95Ms: p95,
      groupFeedbackMs: null,
      framesProcessed: this.framesProcessed,
      framesDropped: this.framesDropped,
      actualFps: sampling.processedFps,
      usableRatio: quality.usableRatio,
    };
  }

  /** 供复查页使用：当前组的特征与挥拍。 */
  get currentSnapshot(): { strokes: StrokeEvent[]; features: FeatureValue[] } {
    return { strokes: [...this.validStrokes], features: this.computeFeatures() };
  }

  dispose(): void {
    this.keyframeCache.clear();
    this.posesByFrameId.clear();
    this.geometries.length = 0;
    this.frameTimes.length = 0;
    this.wristFilter.reset();
    this.segmenter.reset();
  }
}

/** 把本地结论转成可播报文本。 */
export function verdictToSpeech(verdict: LocalVerdict | null): string | null {
  if (!verdict) return null;
  if (verdict.kind === "target_met" || verdict.kind === "suggest_adjustment") {
    return toSpeechText(verdict.cue);
  }
  return null;
}

export { DEFAULT_THRESHOLDS };
