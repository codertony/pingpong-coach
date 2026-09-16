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
  PerStrokeFeatures,
  PoseFrame,
  RuleCriterion,
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
  computePhaseDurations,
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
  type KeyframeCandidate,
} from "../evidence/evidence-builder.js";
import {
  describeKeyframeTrim,
  trimKeyframesToBudget,
  utf8ByteLength,
} from "../evidence/evidence-budget.js";
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
   * 存在的理由：图片链路曾经整条是断的（F-028：缓存没有任何产品代码写入，
   * `keyframes` 恒为空数组），而那时这件事完全静默。
   * 现在采集侧会往里放图，但"取不到"仍可能发生（编码失败、位图拿不到、
   * 将来有人改了调用点），所以这个读数保留：**只要缺，就得看得见**。
   */
  keyframesMissing: number | null;
}

/**
 * 允许自动标定准备区的最少腕部样本数（≈2 秒 @30fps）。
 *
 * `motion-core` 的 `DWELL_MIN_SAMPLES` 是 20（≈0.67 秒）—— 那只是**估计器**
 * 能出一个数的最低要求，不是"这个数可信"的要求。20 个样本可能**整段落在一次
 * 引拍里**，估出来的是挥拍途中的某个位置。
 *
 * 实测（真实对拉素材，8.15 秒，腕部行程 506px）：同一段素材、同一套动作，
 * **只改"从哪一刻开始标定"，检出次数在 0~4 之间跳** —— 标定点落在
 * (442,339) 时 0 次，(680,212) 时 4 次。准备区是整条状态机的入口，
 * 它偏了，后面所有阈值都无从谈起，用户看到的就是"导入视频什么都没有"。
 */
const READY_CALIBRATION_MIN_SAMPLES = 60;

/**
 * 相邻两次估计的落点差 ≤ 这个比例 × 体尺度，才算"稳定"。
 *
 * 0.1 体尺度 ≈ 20px，不到准备区半径（0.3 体尺度）的三分之一：两个估计都落在
 * 这么近的地方，说明"最慢的那片区域"已经定了，不是在挥拍途中偶然经过。
 */
const READY_CALIBRATION_STABLE_BODY_SCALE = 0.1;

/** 还没测到体尺度时，用这个像素值充当尺度基准（仅用于上面的稳定性判断）。 */
const READY_CALIBRATION_FALLBACK_BODY_SCALE_PX = 200;

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
 * 找关键点，**并且要求它达到置信度门槛**。
 *
 * ## 为什么需要它（F-036）
 *
 * `findPoint` 只挡 `visible === false`，而 `visible` 的定义是
 * **`confidence > 0`** —— 于是置信度 0.01 的点与 0.99 的点对它**等价**。
 * 而绘制层要求 `score ≥ minScore`，低于门槛一个点都不画。
 * 同一件事实（"这具身体看得清吗"）于是有了**两套口径**。
 *
 * 实测的后果（合成图案、画面无人）：**准备区圆画出来 10/20 次，
 * 而骨架只出现 1/20 次** —— 屏幕在画一个它几乎不肯承认看得见的身体的约束圈。
 *
 * ## 门槛从哪来
 *
 * 用**绘制层同一个常量**（`DEFAULT_QUALITY_CONFIG.minScore`），
 * 而不是再写一个 0.5 —— 同一个事实只有一个定义，是这条修复的重点。
 *
 * ## `score === null` 怎么办
 *
 * **不判为不可靠**。`null` 的意思是"未知"而不是"低"（红线 1 的同一条精神）：
 * 手部模型的关键点置信度就恒为 `null`（见 `pose.worker.ts` 的注释）。
 * 把"未知"当成"不可靠"会静默地把一整条链路掐掉 —— 本项目栽过这个跟头。
 */
function findPointAboveScore(
  kps: Keypoint2D[],
  name: string,
  minScore: number,
): { x: number; y: number } | null {
  const point = findPoint(kps, name);
  if (!point) return null;
  const score = kps.find((k) => k.name === name)?.score;
  if (score != null && score < minScore) return null;
  return point;
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
  /** 上一次的驻留估计落点，用于判断估计是否已经稳定（见 acceptDwellEstimate） */
  private lastDwellEstimate: { x: number; y: number } | null = null;
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
   * 估计器（`estimateReadyZoneFromDwell`）取**局部速度最慢的那一半**样本的
   * 中位数 —— 理由是"停在准备姿势时手最慢"。⚠️ 本注释此前写的是"把画面切成
   * 格子、取样本最多的那一格"，与实现不符（实现里没有直方图），已按实际改。
   *
   * 什么时候**才允许**定下来，比估计器本身更容易出问题：20 个样本、
   * `>= 20` 就成交，等于让"最先到达的那 20 帧"决定整条状态机的入口。
   * 所以这里加了准入条件（见 `acceptDwellEstimate`）：样本要够多、
   * 估计要**已经不动了**。急着标定的代价是"整段素材什么都检不出"，
   * 多等一秒的代价只是晚一秒开始计数。
   *
   * @returns 用到的样本数；未达准入条件时返回 0 且**不改变**准备区（调用方据此重试）
   */
  calibrateReadyZoneFromDwell(): number {
    const n = this.wristSamples.length;
    const center = estimateReadyZoneFromDwell(
      this.wristSamples.map((s) => ({ x: s.x, y: s.y })),
      this.wristSamples.map((s) => s.tMs),
    );
    if (!center) return 0;
    if (!this.acceptDwellEstimate(center, n)) return 0;
    this.autoCalibrated = true;
    this.setReadyZone(center);
    return n;
  }

  /**
   * 自动标定的**准入条件**：样本够多，且估计已经稳定。
   *
   * 每帧都会调一次（估计值随窗口滑动而微动），所以这里要**记住上一次**的估计：
   * 只有连续两次落点足够近，才说明"最慢的那片区域"不是一个偶然路过的位置。
   *
   * `calibrateReadyZoneFromMedian` 走同一个准入条件：两者是对照实验，
   * 如果只有一边被门控，比出来的差异就分不清是估计器不同还是门槛不同。
   */
  private acceptDwellEstimate(center: { x: number; y: number }, samples: number): boolean {
    const previous = this.lastDwellEstimate;
    this.lastDwellEstimate = center;
    if (samples < READY_CALIBRATION_MIN_SAMPLES) return false;
    if (!previous) return false;
    const scale = this.lastBodyScalePx ?? READY_CALIBRATION_FALLBACK_BODY_SCALE_PX;
    const tolerance = scale * READY_CALIBRATION_STABLE_BODY_SCALE;
    return Math.hypot(center.x - previous.x, center.y - previous.y) <= tolerance;
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
    const center = { x: xs[mid]!, y: ys[mid]! };
    if (!this.acceptDwellEstimate(center, n)) return 0;
    this.autoCalibrated = true;
    this.setReadyZone(center);
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
   * 准备区半径（像素）：`readyZoneRadiusBodyScale × 体尺度`。
   *
   * ⚠️ **这是唯一一处计算**。此前同一个量在三处各算各的（F-032）：
   *   - 画面上的绿圈：`体尺度 ?? 200`（未测到时用魔数占位）
   *   - 证据包里的 `readyZone.radiusPx`：**写死 200**
   *   - 遥测的 `wristToZoneRatio` 分母：体尺度，未测到时为 null
   * 三者在这支素材上分别是 0.3×200、0.3×200、0.3×(147~250) ——
   * **用户照着调姿势的那个圈，跟状态机真正用的圈不是一个大小。**
   *
   * 未测到体尺度时返回 `null`：**不猜**。宁可先不画圈、也不在证据包里
   * 塞一个编出来的半径（红线 1：缺失就是缺失）。
   */
  private zoneRadiusPx(): number | null {
    return this.lastBodyScalePx == null
      ? null
      : this.config.segmentation.readyZoneRadiusBodyScale * this.lastBodyScalePx;
  }

  /**
   * 准备区显示信息（用于在画面上画出准备区）。
   *
   * 体尺度尚未测到（肩或髋未入镜）时返回 `null` —— **不画圈**。
   * 画一个尺寸随手编的圈比不画更糟：用户会照它调整站位。
   */
  get readyZoneDisplay(): { xPx: number; yPx: number; radiusPx: number } | null {
    const radiusPx = this.zoneRadiusPx();
    if (!this.readyZoneCenter || radiusPx == null) return null;
    return { xPx: this.readyZoneCenter.x, yPx: this.readyZoneCenter.y, radiusPx };
  }

  /** 源切换（seek/重播/切摄像头）时重置分段，避免跨片段污染。 */
  resetSegmentation(): void {
    this.segmenter.reset();
    this.wristFilter.reset();
    this.previousFrame = null;
    this.wristSamples.length = 0;
    this.autoCalibrated = false;
    // 稳定性判据要跨帧比较，换了源就不能拿旧源的估计当"上一次"
    this.lastDwellEstimate = null;
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

    /**
     * 腕部滤波：因果、单向，不偷看未来帧。
     *
     * ⚠️ **这里刻意不套置信度门槛**（与上方体尺度相反，见 F-036）。
     * 理由是这两条路的**承诺对象不同**：
     *
     * - 体尺度 → 画在屏幕上的准备区半径 + 证据包里的"本组约束"，
     *   即**对用户的承诺**，所以必须与绘制层同口径；
     * - 腕部 → **内部状态估计**。低置信度的点仍是信息，而它已经有
     *   两层兜底：因果滤波降噪，以及"逐帧质量分级 + 本组可判门槛"
     *   （`minUsableFrameRatio`）。整组都不可靠时会被标成不可判，
     *   而不会伪装成有效结论。
     *
     * 还有一条更硬的理由：**手部/腕部在运动模糊下掉置信度是已知的常态**
     * （见 F-006 的记录），而这里没有那种素材的实测数据 ——
     * 在真实数据之前调这个口径，就是把猜测从一个值挪到另一个值。
     */
    const rawWrist = findPoint(result.keypoints2D, `${this.config.handedness}_wrist`);
    const filteredWrist = rawWrist ? this.wristFilter.push(rawWrist, result.sourceTimeMs) : null;

    // 躯干参考与体尺度。
    //
    // ⚠️ 这里用**带置信度门槛**的查找（F-036）：体尺度会变成画在屏幕上的
    // 准备区半径、也会进证据包当作"本组的明确约束"—— 那是**对用户的承诺**，
    // 不能建立在一个绘制层会拒绝承认的身体上。门槛与绘制层同一个常量。
    //
    // 腕部**刻意不用**这个门槛（见下方 `rawWrist` 的注释）：那条路走的是内部
    // 状态估计，且已经有质量分级与"本组是否可判"两层兜底；严格与宽松的
    // 分界是"要不要对用户做出承诺"，不是"路径长短"。
    const minKeypointScore = DEFAULT_QUALITY_CONFIG.minScore;
    const lShoulder = findPointAboveScore(result.keypoints2D, "left_shoulder", minKeypointScore);
    const rShoulder = findPointAboveScore(result.keypoints2D, "right_shoulder", minKeypointScore);
    const lHip = findPointAboveScore(result.keypoints2D, "left_hip", minKeypointScore);
    const rHip = findPointAboveScore(result.keypoints2D, "right_hip", minKeypointScore);

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
    void this.emitGroup(null);
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

  /**
   * 本组的区间与落在其中的几何。
   *
   * 组区间 = 第一次挥拍起点 → 最后一次挥拍终点。
   * 抽出来是因为**逐板指标也要用同一批几何**（见 `computePerStrokeFeatures`）——
   * 两处各过滤一遍的话，将来改了"组区间怎么算"，只会改到其中一处，
   * 于是组级与逐板的数值来自两个不同的帧集合，而谁都看不出来。
   */
  private currentGroupWindow(): { interval: [number, number]; geometries: FrameGeometry[] } {
    const first = this.validStrokes[0]!;
    const last = this.validStrokes[this.validStrokes.length - 1]!;
    const interval: [number, number] = [first.startMs, last.endMs ?? last.anchor.timeMs];
    return {
      interval,
      geometries: this.geometries.filter(
        (g) => g.sourceTimeMs >= interval[0] && g.sourceTimeMs <= interval[1],
      ),
    };
  }

  /**
   * 逐板测量值（R5）。
   *
   * 这些数**本来就算过**：组级特征的口径就是"先算每板、再取中位数"，
   * 而聚合时把每板丢掉了 —— 模型只能拿组级标量讲话，答不了"哪一板、差多少"。
   *
   * 放三类**确实能逐板算**的量：
   * - **逐阶段时长**（引拍／前挥／还原）：由这一板自己的阶段事件相减得到（R5 后半）。
   *   有了它模型才说得出"引拍拖太久"这类话 —— 此前没有任何一个量在描述分段；
   * - 返回准备区时间（未闭合的板如实报缺失并说明原因）；
   * - 肘角（每板取峰值 ±80ms 中位数）—— 与组级特征同一个关注点门槛。
   *
   * **组内一致性、肘相对躯干位移刻意不放**：它们的定义就是组级概念，
   * 不是"每板的同一个量"。硬塞进来只会让模型把组级指标误读成逐板差异。
   */
  private computePerStrokeFeatures(): PerStrokeFeatures[] {
    const { geometries } = this.currentGroupWindow();
    return this.validStrokes.map((s) => {
      const features: FeatureValue[] = [];

      // 逐阶段时长：入口是**这一板自己的事件**，与分段口径同源
      features.push(...computePhaseDurations(s.phaseEvents));

      if (this.config.focusId === "elbow_extension_pattern") {
        features.push(
          computeElbowAngleAtWristPeak(geometries, s.anchor.timeMs, 80, [
            s.anchor.timeMs,
            s.anchor.timeMs,
          ]),
        );
      }

      if (s.endMs == null) {
        /*
         * 契约允许 `endMs` 为 null，而分段器只对**已闭合**的挥拍置 `complete: true`
         * 且必定带上 `endMs`（`onStrokeEvent` 也把未闭合的挡在外面）——
         * 所以正常链路走不到这里。留着它是因为**类型要求收窄**，
         * 而不是在为一个会发生的情况兜底；真走到了，也要如实说是哪一板缺什么。
         */
        features.push({
          id: FEATURE_IDS.RETURN_AFTER_WRIST_PEAK,
          value: null,
          unit: "ms",
          coordinateSpace: "image_2d",
          intervalMs: [s.anchor.timeMs, s.anchor.timeMs],
          quality: "unusable",
          reasonIfMissing: "这一板未闭合（没有回到准备区），无法计算返回时间",
        });
      } else {
        features.push(
          computeReturnAfterWristPeak(s.anchor.timeMs, s.endMs, [s.anchor.timeMs, s.endMs]),
        );
      }

      return { strokeId: s.strokeId, features };
    });
  }
  private computeFeatures(): FeatureValue[] {
    const features: FeatureValue[] = [];
    if (this.validStrokes.length === 0) return features;

    const first = this.validStrokes[0]!;
    const { interval, geometries: geometriesInGroup } = this.currentGroupWindow();

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
      const perStroke = this.validStrokes.map((s) =>
        computeElbowAngleAtWristPeak(geometriesInGroup, s.anchor.timeMs, 80, [
          s.anchor.timeMs,
          s.anchor.timeMs,
        ]),
      );
      const contributing = perStroke.filter((f) => f.value != null);
      const groupMedian = median(contributing.map((f) => f.value as number));

      /*
       * ⚠️ 这里原先**把角度当成了时间**（R1）：
       *
       *     computeElbowAngleAtWristPeak(geometriesInGroup, median(perStroke) ?? first.anchor.timeMs, 80, interval)
       *
       * `median(perStroke)` 是**度**（比如 152），却被塞进了 `anchorTimeMs` ——
       * 于是函数去 t≈152ms 附近找几何，算出的是那一小段的值（通常是缺失，
       * 偶尔取到一个毫不相干的区间）。而它旁边那条返回准备区时间的特征
       * 写法是对的（中位数进**值**，锚点单独给），两处一对比就看得出。
       *
       * 现在直接按注释里写明的口径做：**每次挥拍取峰值 ±80ms 的肘角中位数，
       * 再对本组取中位数**。不再绕回那个函数 —— 绕回去就还得再传一个时间，
       * 而这里根本没有"某一个时刻"可言。
       */
      features.push({
        id: FEATURE_IDS.ELBOW_ANGLE_AT_WRIST_PEAK,
        value: groupMedian,
        unit: "deg",
        coordinateSpace: "image_2d",
        intervalMs: interval,
        // 质量取**参与统计的那几次**里最差的一档：只要有一次降到 limited，
        // 这个中位数就不该自称 usable
        quality:
          groupMedian == null
            ? "unusable"
            : contributing.some((f) => f.quality === "limited")
              ? "limited"
              : "usable",
        reasonIfMissing:
          groupMedian == null ? "本组没有一次挥拍在腕速峰值 ±80ms 内取到可用肘角" : null,
      });
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
    await this.emitGroup(null);
  }

  /**
   * 本组所用的**训练判据**（随证据包一起发出去）。
   *
   * 为什么由发起端填，而不是服务端自己算：判据的数值住在 `motion-core`，
   * 而依赖方向规定**服务端只依赖 contracts**（AGENTS.md）。让服务端再写一份，
   * 就是同一个事实两处各写各的 —— 这个项目已经栽过好几次（F-026/F-027）。
   * 所以这里取**本次真正生效的**那套值，与本地规则读的是同一个常量。
   *
   * 只对**有明确门槛定义**的关注点给值：门槛只对返回准备区时间有定义，
   * 那就别在别的关注点上贴一个编出来的数字。
   *
   * 单位取自**本包内那条测量的单位**，不再写一遍 —— 免得将来改了测量单位、
   * 判据还念着旧单位。
   */
  private buildCriterion(features: FeatureValue[]): RuleCriterion | null {
    const rule = BUILTIN_RULES.find((r) => r.focusId === this.config.focusId);
    if (!rule) return null;
    if (!rule.requiredFeatureIds.includes(FEATURE_IDS.RETURN_AFTER_WRIST_PEAK)) return null;
    const feature = features.find((f) => f.id === FEATURE_IDS.RETURN_AFTER_WRIST_PEAK);
    if (!feature) return null;
    return {
      featureId: FEATURE_IDS.RETURN_AFTER_WRIST_PEAK,
      threshold: DEFAULT_THRESHOLDS.returnAfterWristPeakMaxMs,
      unit: feature.unit,
      minValidStrokes: DEFAULT_THRESHOLDS.minValidStrokes,
    };
  }

  /**
   * **素材结束，把当前这组提前交出去**（可能有，也可能一次都没有）。
   *
   * 为什么必须有这个入口：组边界（`strokesPerGroup`，默认 3）是**交互概念**，
   * 而导入的视频是**有限长**的。`onStrokeEvent` 只在凑满时才构建证据，
   * 于是"导入一段视频 → 什么都没发生"就是默认体验 —— 用户报的正是这个
   * （他同时也在报另一件事：视频循环播放，那是 `capture-source` 里的 `loop`）。
   *
   * 素材播完是**客观事实**，它比"这组还差 1 次挥拍"更硬：不会再有下一帧了，
   * 继续等下去就只是干等。所以这里把已收集到的有效挥拍当成一组交出去，
   * 并在证据包里**写明这组是提前结束的**（`N/M` 次）—— 不足额是事实，
   * 必须让模型和复查页都看到，而不是假装这组本来就该这么大。
   *
   * @returns 是否真的交出了一组（一次有效挥拍都没有时为 false）
   */
  finishGroup(reason: string): boolean {
    if (this.validStrokes.length === 0) {
      this.callbacks.onStatus(`${reason}，但整段素材没有检出一次完整挥拍，本次没有可分析的分组`);
      return false;
    }
    void this.emitGroup(reason);
    return true;
  }

  /**
   * 构建并交出一组证据。
   *
   * @param cutShortReason 本组是**提前**结束的（素材播完）时的原因；
   *   正常凑满 `strokesPerGroup` 时为 null。
   */
  private async emitGroup(cutShortReason: string | null): Promise<void> {
    const features = this.computeFeatures();
    // 逐板数值与组级数值**同时**取：两者必须来自同一批挥拍（见 currentGroupWindow）
    const perStrokeFeatures = this.computePerStrokeFeatures();
    const poses = [...this.posesByFrameId.values()];
    const quality = summarizeGroupQuality(poses, DEFAULT_QUALITY_CONFIG);

    /*
     * 选代表性关键帧时，候选必须**真的缓存里有图**（R3）。
     *
     * 原先用"时间窗内的姿态帧"当候选、`bytes` 填空数组，挑完才去缓存里找图，
     * 找不到只记一笔 `missing`。而图片是**每 3 帧**采一张
     * （`KEYFRAME_CAPTURE_EVERY_N_FRAMES`），姿态帧却帧帧都有 ——
     * 两个集合根本不一样大。于是"挑中的那几张恰好没采图"是常态，
     * 表现就是**附近明明有可用的图，却白白少发几张**给模型。
     *
     * 现在从有图的那些里挑，选中的就是真候选（带真实 bytes 与尺寸）。
     * 同时**记下整个组一共有几张有图的候选**（`availablePixels`）——
     * 它是下面区分两种失败模式的唯一依据。
     */
    let availablePixels = 0;
    const candidates = this.validStrokes.flatMap((s) => {
      const withPixels = poses
        .filter(
          (p) => p.sourceTimeMs >= s.startMs && (s.endMs == null || p.sourceTimeMs <= s.endMs),
        )
        .map((p) => this.keyframeCache.get(p.frameId))
        .filter((c): c is KeyframeCandidate => c != null);
      availablePixels += withPixels.length;

      return selectRepresentativeFrames(
        // 必须把 evidenceFrameIds 传进去：它决定"哪些帧有资格当关键帧"，
        // 契约要求关键帧与这一板的证据帧对齐（见 F-029）
        {
          startMs: s.startMs,
          endMs: s.endMs,
          anchor: s.anchor,
          evidenceFrameIds: s.evidenceFrameIds,
        },
        withPixels,
      );
    });

    // 关键帧必须与姿态帧通过 frameId 对齐；**阶段角色一并带上**（R2）
    const { keyframes, missing } = buildKeyframes(
      candidates,
      this.keyframeCache,
      this.posesByFrameId,
    );

    /*
     * ⚠️ 图片链路**曾经是断的**（F-028）：`KeyframeCache.add()` 当时在整个
     * apps/web 里没有任何调用方，缓存永远是空的，`keyframes` 恒为空数组 ——
     * 模型收到的是**纯文本**，而全线无报错。
     *
     * R3 的改动把候选收窄成"有图的帧"之后，**这两种失败必须分开看**，
     * 否则又会退回静默：
     *
     * - `missing`：挑中了却取不到图（缓存里没有、或没有对应姿态帧）。
     *   R3 之后这属于**异常**（编码竞态、别人改了调用点），正常链路为 0。
     * - **一张有图的候选都没有**：这才是 F-028 的形态，必须大声说。
     *   而且它**不能报成"0 张缺失"** —— 那样读起来像"一切正常"。
     *   所以这种情况下按**每板**计数兜底（`validStrokes.length`），
     *   让遥测与提示都还能看出"有 N 个东西要图、一个都没拿到"。
     */
    const noImageAtAll = availablePixels === 0 && this.validStrokes.length > 0;
    this.lastGroupKeyframes = {
      included: keyframes.length,
      missing: noImageAtAll ? this.validStrokes.length : missing.length,
    };

    if (noImageAtAll) {
      this.callbacks.onStatus(
        `本组证据不含图片：${this.validStrokes.length} 次挥拍的关键帧一张都取不到` +
          `（采集侧一张图都没缓存，图片链路未接通）—— 模型只会看到文本`,
      );
    } else if (missing.length > 0) {
      this.callbacks.onStatus(
        keyframes.length === 0
          ? `本组证据不含图片：${missing.length} 张关键帧全部取不到（图片链路未接通）—— 模型只会看到文本`
          : `本组有 ${missing.length} 张关键帧取不到图（其中 ${keyframes.length} 张正常）`,
      );
    }

    this.lastRequestId = `${this.groupId}_${Date.now()}`;
    // 与画面上的绿圈、遥测的 wristToZoneRatio 分母**同一处计算**（F-032）。
    // 未测到体尺度时给 null → 包里不带准备区，而不是塞一个编出来的半径。
    const packetZoneRadius = this.zoneRadiusPx();
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
      perStrokeFeatures,
      features,
      keyframes,
      ruleVersion: RULE_VERSION,
      referenceId: null,
      criterion: this.buildCriterion(features),
      limitations: [
        "单目二维骨架，无法判断肌肉紧张、发力大小、足底承重或力量传递效率",
        "事件锚点为腕部速度峰值，不是已确认的击球时刻",
        /*
         * R4：关键帧的 `role`（backswing / forward / return）是**按区间时间比例
         * 挑的那一帧**，不是检出的事件时刻 —— 引拍那张取的是"起点到锚点的中点"，
         * 还原那张取的是"锚点到终点的中点"。名字很像事件，容易被读成后者。
         *
         * 现在没有事件检测（那是 P1 的事），所以**如实写进 limitations**：
         * 与其让模型把"名为 forward 的图"当成击球瞬间，不如先说明它是怎么挑的。
         */
        ...(keyframes.length > 0
          ? ["关键帧按挥拍区间的时间比例挑选，不是检出的事件时刻 —— 不能当作「击球瞬间」的直接证据"]
          : []),
        ...(quality.judgeable ? [] : ["本组画质未达到可判门槛"]),
        // 不足额就说不足额。少了这句，模型会把 1 次挥拍当成本组全部表现来点评
        ...(cutShortReason == null
          ? []
          : [
              `本组提前结束（${cutShortReason}）：只有 ${this.validStrokes.length}/${this.config.strokesPerGroup} 次有效挥拍，样本量少于常规分组`,
            ]),
      ],
      readyZone:
        this.readyZoneCenter && packetZoneRadius != null
          ? {
              xPx: this.readyZoneCenter.x,
              yPx: this.readyZoneCenter.y,
              radiusPx: packetZoneRadius,
            }
          : null,
    };

    // 请求体积预算（数据契约「图片与请求预算」）。
    //
    // 契约写的是"超限**先减少冗余图片并记录降采样**"，而在此之前代码里没有这回事：
    // 服务端只会直接 413 —— 超一点预算，用户**什么都拿不到**。
    // 客户端手里才有图片，所以这件事在客户端做：从最不关键的那张开始丢，并写进 limitations。
    //
    // 用**真实序列化结果**量体积，不做估算（与服务端 `Buffer.byteLength(json,'utf8')` 同口径）：
    // 估偏了会算出"压过了"其实没压过。
    const trimmed = trimKeyframesToBudget(packet.keyframes, (kept) => {
      const dropped = packet.keyframes.length - kept.length;
      return utf8ByteLength(
        JSON.stringify({
          ...packet,
          keyframes: kept,
          // 丢过图就一定会附上那条说明，所以把它算进体积里 ——
          // 宁可多压几十字节，也不要"压完还超"
          limitations:
            dropped > 0
              ? [...packet.limitations, describeKeyframeTrim(dropped, 0)]
              : packet.limitations,
        }),
      );
    });
    if (trimmed.dropped > 0) {
      packet.keyframes = trimmed.kept;
      packet.limitations = [
        ...packet.limitations,
        describeKeyframeTrim(trimmed.dropped, trimmed.bytes),
      ];
      this.callbacks.onStatus(
        `本组证据超出请求预算，已丢弃 ${trimmed.dropped} 张关键帧（压后约 ${(trimmed.bytes / 1024 / 1024).toFixed(2)} MiB）`,
      );
    }

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
    // 与画面上的绿圈、证据包里的半径**同一处计算**（F-032）
    const zoneRadius = this.zoneRadiusPx();
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
    this.lastDwellEstimate = null;
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
