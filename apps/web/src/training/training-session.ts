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
  StrokePhase,
} from "@pingpong/contracts";
import { FEATURE_IDS, RULE_VERSION, SCHEMA_VERSION } from "@pingpong/contracts";
import {
  StrokeSegmenter,
  assessFrameQuality,
  computeElbowAngleRange,
  computeElbowAngleAtWristPeak,
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
  estimateReadyZoneFromDwell,
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
  /**
   * **端到端处理延迟** P95：从浏览器收到帧（`receivedAtMonoMs`）到骨架结果可用。
   *
   * 这是用户真正感受到的那段延迟 —— 它**包含**调度器排队与 Worker 跨线程往返。
   * 不要用 `poseInferenceP95Ms` 冒充它：那个只算 Worker 内的推理，
   * 而排队与往返恰恰是最容易出问题、也最容易被漏掉的部分。
   */
  poseLatencyP95Ms: number | null;
  /**
   * Worker 内**推理本身**的耗时 P95。与上面的差值就是"排队 + 跨线程 + 序列化"的开销。
   * 单列出来是为了能判断延迟到底花在模型上还是花在链路开销上。
   */
  poseInferenceP95Ms: number | null;
  /** 本组从第一次挥拍开始到反馈可见的耗时 */
  groupFeedbackMs: number | null;
  /** 已处理的帧数与丢帧数 */
  framesProcessed: number;
  framesDropped: number;
  /** 实测处理频率 */
  actualFps: number | null;
  /** 有效帧比例 */
  usableRatio: number;
  /** 当前分段阶段（idle/ready/backswing/forward/returning/aborted） */
  segmentationPhase: StrokePhase | null;
  /** 分段期间因质量/缺失被跳过的帧数 */
  segmentationSkippedFrames: number;
  /** 最近一次异常结束原因 */
  segmentationLastAbortReason: string | null;
  /** 最近一帧是否测到了体尺度（肩+髋都在画面内） */
  hasBodyScale: boolean;
  /** 最近一帧是否检测到持拍手腕 */
  wristVisible: boolean;
  /** 当前体尺度（肩中点—髋中点，像素）；null 表示未测到 */
  bodyScalePx: number | null;
  /** 当前准备区半径（像素）；null 表示尚未设定准备区 */
  readyZoneRadiusPx: number | null;
  /**
   * 腕部到准备区中心的距离 ÷ 准备区半径。
   * ≤ 1 表示在区内（状态机可以开始一次挥拍）；> 1 表示在区外。
   * 这是"为什么一直等待有效挥拍"的最直接判据：它长期 > 1 就是准备区设错了。
   */
  wristToZoneRatio: number | null;
  /**
   * 准备区是否由自动标定得出（腕部驻留位置）。
   * 界面必须如实标注：用户要知道这个约束是程序猜的，还是自己设的。
   */
  readyZoneAutoCalibrated: boolean;
  /**
   * 最近一组里**取不到图**的关键帧张数；`null` 表示还没成组。
   *
   * 存在的理由：图片链路目前是断的（F-028），而原先这件事完全静默。
   * 把它做成可观测，界面与测试才能如实说出"这组证据里没有图片"。
   */
  keyframesMissing: number | null;
}

/** 把姿态结果转成 PoseFrame，并做质量评估。 */
function toPoseFrame(
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
    keypointSet: result.keypointSet,
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
  /** 最近一次滤波后的持拍手腕位置，用于"以此处为准备区"与诊断 */
  private lastWristPx: { x: number; y: number } | null = null;
  /** 最近一次测到的体尺度（肩中点—髋中点距离），null 表示肩或髋未入镜 */
  private lastBodyScalePx: number | null = null;
  /** 最近若干帧的腕部位置与媒体时间，用于自动标定准备区（速度加权） */
  private wristSamples: Array<{ x: number; y: number; tMs: number }> = [];
  /** 当前准备区是否由自动标定得出（用于界面如实标注） */
  private autoCalibrated = false;
  /** 最近一组的关键帧取图情况，供遥测如实展示（F-028） */
  private lastGroupKeyframes: { included: number; missing: number } | null = null;
  private poseLatencies: number[] = [];
  /** Worker 内推理耗时，单独留一份用于区分"模型慢"与"链路慢" */
  private poseInferenceLatencies: number[] = [];
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

  /** 用户在拍摄检查页选定准备区中心，或手动覆盖自动标定结果。 */
  setReadyZone(center: { x: number; y: number }): void {
    this.readyZoneCenter = center;
    this.segmenter.setReadyZone(center);
  }

  /**
   * 把准备区中心设为"当前腕部位置"（用户手动）。
   * 手动设定后清除自动标定标记，避免界面继续显示"由自动标定得出"。
   */
  setReadyZoneToCurrentWrist(): boolean {
    if (!this.lastWristPx) return false;
    this.autoCalibrated = false;
    this.setReadyZone({ ...this.lastWristPx });
    return true;
  }

  /**
   * 自动标定准备区：找**腕部停留最久**的位置。
   *
   * 为什么不是简单取中位数：一次挥拍中腕部会扫过一大片区域，中位数会被
   * 挥拍轨迹拉偏。真正要的是"手停在哪里等球"——因此把画面切成格子统计
   * 落点，取样本最多的那一格（驻留格），再在该格内取中位数细分。
   * 停在准备姿势的时间天然远多于挥拍中，所以驻留格就是准备位置。
   *
   * @returns 用到的样本数；样本不足（< 20）时返回 0 且不改变准备区。
   */
  calibrateReadyZoneFromDwell(): number {
    const n = this.wristSamples.length;
    const center = estimateReadyZoneFromDwell(
      this.wristSamples.map((s) => ({ x: s.x, y: s.y })),
      this.wristSamples.map((s) => s.tMs),
    );
    if (!center) return 0;
    this.autoCalibrated = true;
    this.setReadyZone(center);
    return n;
  }

  /**
   * 对照实验用：按腕部样本中位数标定准备区。
   *
   * 保留它是为了能在**真实素材**上比较两种估计器（见 docs/known-failures.md）。
   * 不要在未比较过的情况下删掉其中一个。
   */
  calibrateReadyZoneFromMedian(): number {
    const n = this.wristSamples.length;
    if (n === 0) return 0;
    const xs = this.wristSamples.map((p) => p.x).sort((a, b) => a - b);
    const ys = this.wristSamples.map((p) => p.y).sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    this.autoCalibrated = true;
    this.setReadyZone({ x: xs[mid]!, y: ys[mid]! });
    return n;
  }

  get hasReadyZone(): boolean {
    return this.readyZoneCenter != null;
  }

  /** 最近一次滤波后的持拍手腕位置（原始画面像素），用于"以此处为准备区"。 */
  get currentWristPx(): { x: number; y: number } | null {
    return this.lastWristPx;
  }

  /** 腕部位置样本（诊断用）。返回副本，调用方不能改到内部状态。 */
  get wristSamplesSnapshot(): Array<{ x: number; y: number }> {
    return this.wristSamples.map((s) => ({ x: s.x, y: s.y }));
  }

  /**
   * 准备区显示信息（用于在画面上画出准备区）。
   * 半径按 `readyZoneRadiusBodyScale * 体尺度` 计算，与分段状态机一致。
   * 体尺度尚未测到（肩或髋未入镜）时用固定占位值，仅用于显示，不影响判定。
   */
  get readyZoneDisplay(): { xPx: number; yPx: number; radiusPx: number } | null {
    if (!this.readyZoneCenter) return null;
    const bodyScale = this.lastBodyScalePx ?? 200;
    return {
      xPx: this.readyZoneCenter.x,
      yPx: this.readyZoneCenter.y,
      radiusPx: this.config.segmentation.readyZoneRadiusBodyScale * bodyScale,
    };
  }

  /** 源切换（seek/重播/切摄像头）时重置分段，避免跨片段污染。 */
  resetSegmentation(): void {
    this.segmenter.reset();
    this.wristFilter.reset();
    this.previousFrame = null;
    this.wristSamples.length = 0;
    this.autoCalibrated = false;
  }

  markDropped(): void {
    this.framesDropped++;
  }

  /**
   * 把某一帧的图片像素放进关键帧缓存（F-028）。
   *
   * 采集侧在把位图交给引擎**之前**调用它（位图的所有权随后转移给 Worker，
   * 之后就取不到像素了）。成组时 `selectRepresentativeFrames` 会回溯挑出若干张，
   * `buildKeyframes` 再从本缓存按 frameId 取图。
   *
   * **在此之前整个缓存没有任何产品代码写入**，于是 `keyframes` 恒为空数组、
   * 模型收到的是纯文本。这里只做"放进去"，不判断哪张会被选中 ——
   * 选中是成组时才知道的事。
   *
   * 空字节直接忽略：那等于没有图，塞进去只会让 `keyframes` 里多出一条空图片
   * （比"取不到"更糟 —— 它看起来是有的）。
   */
  addFramePixels(
    frameId: string,
    sourceTimeMs: number,
    bytes: Uint8Array,
    width: number,
    height: number,
  ): void {
    if (bytes.byteLength === 0) return;
    this.keyframeCache.add({ frameId, sourceTimeMs, bytes, width, height, pinned: false });
  }

  /**
   * 投入一帧姿态结果。这是热路径，必须轻量。
   */
  pushPoseResult(result: PoseResult): void {
    this.framesProcessed++;
    // 端到端延迟：收到帧 → 结果可用。含排队与跨线程往返。
    // 端到端延迟 = 主线程盖的两个时刻之差（收到帧 → 骨架可用）。
    // ⚠️ 两个时刻必须**同源**：`inferredAtMonoMs` 由 PoseEngine 在主线程盖章，
    // 不能用 Worker 报的那个（不同源，实测差约 155ms，会算出负延迟，见 F-024）。
    this.poseLatencies.push(result.inferredAtMonoMs - result.receivedAtMonoMs);
    if (this.poseLatencies.length > 500) this.poseLatencies.shift();
    this.poseInferenceLatencies.push(result.inferenceMs);
    if (this.poseInferenceLatencies.length > 500) this.poseInferenceLatencies.shift();
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

    // 记录最近一帧的手腕与体尺度，供"以此处为准备区"与诊断展示
    this.lastWristPx = filteredWrist;
    this.lastBodyScalePx = bodyScalePx;
    if (filteredWrist) {
      this.wristSamples.push({ ...filteredWrist, tMs: result.sourceTimeMs });
      if (this.wristSamples.length > 180) this.wristSamples.shift();
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

    /*
     * 用户选中的关注点是「肘角伸展模式」时，必须真的把**肘角**算出来。
     *
     * 为什么单列这一段：先前 `computeElbowAngleAtForwardPeak` 定义了、测过了，
     * 却**从未被调用** —— 而「肘角伸展模式」在界面里是**可选**的关注点。
     * 结果是产品静默忽略用户的选择：证据包里 focusId 标着用户选的那个，
     * 而对应指标根本没算。模型于是被框在一个不存在的指标上。
     *
     * 口径：每次挥拍取**腕部速度峰值前后**一小段窗（±80ms）的肘角中位数，
     * 再对本组取中位数。用一段窗而不是单帧，是因为单帧的骨架抖动会让
     * "锚点那一帧"变成一个不稳定的读数；而窗口边界锚在真实事件上，
     * 不是随意的区间。超出窗口没采到就报缺失 —— 不拿窗口外的帧冒充。
     */
    if (this.config.focusId === "elbow_extension_pattern") {
      const perStroke = this.validStrokes
        .map((s) =>
          computeElbowAngleAtWristPeak(geometriesInGroup, s.anchor.timeMs, 80, [
            s.anchor.timeMs,
            s.anchor.timeMs,
          ]),
        )
        .map((f) => f.value)
        .filter((v): v is number => v != null);

      // 用中位数代表本组；区间语义保留为整组区间
      features.push(
        computeElbowAngleAtWristPeak(
          geometriesInGroup,
          median(perStroke) ?? first.anchor.timeMs,
          80,
          interval,
        ),
      );
    }

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
    const { keyframes, missing } = buildKeyframes(
      candidates.map((c) => c.frameId),
      this.keyframeCache,
      this.posesByFrameId,
    );
    this.lastGroupKeyframes = { included: keyframes.length, missing: missing.length };

    // ⚠️ 图片链路目前**是断的**（F-028）：`KeyframeCache.add()` 在整个 apps/web 里
    // 没有任何调用方，缓存永远是空的，于是每一张关键帧都落到 `missing` 里、
    // `keyframes` 恒为空数组 —— 模型收到的是**纯文本**。
    // 契约里 `keyframes` 没有 `.min(1)`，所以这个包在服务端是合法的、一路通行。
    // 原先 `missing` 被直接丢弃，整件事**完全静默**；这里把它报出来。
    if (missing.length > 0) {
      this.callbacks.onStatus(
        keyframes.length === 0
          ? `本组证据不含图片：${missing.length} 张关键帧全部取不到（图片链路未接通）—— 模型只会看到文本`
          : `本组有 ${missing.length} 张关键帧取不到图（其中 ${keyframes.length} 张正常）`,
      );
    }

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
    /** 取 P95（样本不足时退回最大值；空样本给 null）。 */
    const p95Of = (values: number[]): number | null => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null;
    };

    const sampling = computeSamplingStats(this.frameTimes, DEFAULT_QUALITY_CONFIG);
    const poses = [...this.posesByFrameId.values()];
    const quality = summarizeGroupQuality(poses, DEFAULT_QUALITY_CONFIG);
    const diag = this.segmenter.diagnostics;
    const bodyScale = this.lastBodyScalePx;
    const zoneRadius =
      bodyScale != null ? this.config.segmentation.readyZoneRadiusBodyScale * bodyScale : null;
    const wristToZoneRatio =
      this.lastWristPx != null &&
      this.readyZoneCenter != null &&
      zoneRadius != null &&
      zoneRadius > 0
        ? Math.hypot(
            this.lastWristPx.x - this.readyZoneCenter.x,
            this.lastWristPx.y - this.readyZoneCenter.y,
          ) / zoneRadius
        : null;

    return {
      poseLatencyP95Ms: p95Of(this.poseLatencies),
      poseInferenceP95Ms: p95Of(this.poseInferenceLatencies),
      groupFeedbackMs: null,
      framesProcessed: this.framesProcessed,
      framesDropped: this.framesDropped,
      actualFps: sampling.processedFps,
      usableRatio: quality.usableRatio,
      segmentationPhase: diag.phase,
      segmentationSkippedFrames: diag.skippedFrames,
      segmentationLastAbortReason: diag.lastAbortReason,
      hasBodyScale: bodyScale != null,
      wristVisible: this.lastWristPx != null,
      bodyScalePx: bodyScale,
      readyZoneRadiusPx: zoneRadius,
      wristToZoneRatio,
      readyZoneAutoCalibrated: this.autoCalibrated,
      keyframesMissing: this.lastGroupKeyframes?.missing ?? null,
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
    this.wristSamples.length = 0;
    // 延迟样本也要清：它们是逐帧累积的，会话结束不清就把整段历史挂在对象上
    this.poseLatencies.length = 0;
    this.poseInferenceLatencies.length = 0;
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
