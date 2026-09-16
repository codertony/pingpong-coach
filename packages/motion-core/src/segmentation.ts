/**
 * 可解释挥拍状态机（P1）。
 *
 * 阶段：准备 → 引拍 → 向前挥拍 → 回到准备区
 * 异常：遮挡、出画、长时间间断、换动作 → aborted（不完整样本）
 *
 * 设计要点：
 * - 方向必须与机位、持拍手一起配置，不能写死。
 * - 使用有界滞后与防抖，避免抖动导致反复切换状态。
 * - 首版**不用**复杂动作分类模型。
 * - 低质量或非练习动作不凑进有效挥拍数量。
 */

import type { SegmentationConfig, StrokeEvent, StrokePhase } from "@pingpong/contracts";

/**
 * 分段阈值的**默认值**（不含 `strokeType` / `cameraView` / `handedness` ——
 * 那三项是每次会话由用户选的，不是标定值）。
 *
 * 为什么放在这里而不是 `apps/web`：这些值配置的就是本文件的状态机，
 * 而且 `configs/thresholds.json` 里有一份同名的**规范快照**。
 * 快照与代码的一致性检查住在 `motion-core` 的测试里，而
 * **`motion-core` 不允许依赖 `apps/web`** —— 值如果放在 `apps/web`，
 * 那个检查就够不着它（这正是 F-026 之前的状态：JSON 里那 6 个值从没被校过）。
 *
 * ⚠️ `readyZoneRadiusBodyScale` 与 `returnStableMinMs` 是**当前最需要标定**的两个：
 * 实测（见 F-022 补测）回位距离 0.29~0.40 正压在半径 0.30 上，
 * 而落点在区外时检出会从"数得少"直接掉到 **0 板**；另外名义上的 120ms
 * 实际需要约 **200ms** 墙上时间（每板白吃一帧 + 必须连续在区内）。
 */
export const DEFAULT_SEGMENTATION: Omit<
  SegmentationConfig,
  "strokeType" | "cameraView" | "handedness"
> = {
  readyZoneRadiusBodyScale: 0.3,
  readyStableMinMs: 120,
  backswingMinDisplacementBodyScale: 0.2,
  forwardMinSpeedBodyScalePerSec: 0.5,
  returnStableMinMs: 120,
  maxGapMs: 250,
  maxStrokeDurationMs: 3000,
};

export interface SegmentationSample {
  frameId: string;
  sourceTimeMs: number;
  /** 已滤波的持拍侧腕部位置（原始画面像素） */
  wristPx: { x: number; y: number } | null;
  /** 该点相对准备区中心的位置，已去掉整体平移影响 */
  wristRelReadyZonePx: { x: number; y: number } | null;
  /** 体尺度像素长度，用于把所有阈值归一化 */
  bodyScalePx: number | null;
  /** 该帧质量；unusable 的帧不参与状态转移 */
  quality: "usable" | "limited" | "unusable";
}

/** 状态机的可观测诊断信息，用于评估与调试。 */
export interface SegmentationDiagnostics {
  phase: StrokePhase;
  /** 当前阶段已持续时间 */
  phaseElapsedMs: number;
  /** 因质量问题被跳过的帧数 */
  skippedFrames: number;
  /** 触发异常结束的次数 */
  abortedCount: number;
  /** 最近一次异常结束的原因 */
  lastAbortReason: string | null;
}

/**
 * 主状态机。
 *
 * 使用方式：按时间顺序对每个采样调用 `push(sample)`，
 * 返回值为本次调用**新闭合**的完整挥拍（可能为 null）。
 */
export class StrokeSegmenter {
  private readonly config: SegmentationConfig;
  private phase: StrokePhase = "idle";
  private phaseSinceMs = 0;
  private phaseEntered = false;

  // 当前进行中的挥拍
  private currentStrokeId: string | null = null;
  private strokeStartMs = 0;
  private strokeFrames: string[] = [];
  private strokeReasons: string[] = [];
  private lastSampleAtMs: number | null = null;

  // 锚点：腕部速度峰值
  private peakSpeedBodyScalePerSec = -1;
  private peakTimeMs: number | null = null;
  private peakFrameId: string | null = null;

  // 准备区
  private readyZoneCenterPx: { x: number; y: number } | null = null;

  private skippedFrames = 0;
  private abortedCount = 0;
  private lastAbortReason: string | null = null;

  private strokeCounter = 0;

  constructor(config: SegmentationConfig) {
    this.config = config;
  }

  /** 显式设定本组准备区中心。未设定前状态机停留在 idle。 */
  setReadyZone(center: { x: number; y: number }): void {
    this.readyZoneCenterPx = center;
  }

  /** 源切换（seek/重播/换摄像头）时必须重置，避免跨片段污染。 */
  reset(): void {
    this.phase = "idle";
    this.phaseSinceMs = 0;
    this.phaseEntered = false;
    this.currentStrokeId = null;
    this.strokeStartMs = 0;
    this.strokeFrames = [];
    this.strokeReasons = [];
    this.lastSampleAtMs = null;
    this.lastSampleTimeMs = 0;
    this.peakSpeedBodyScalePerSec = -1;
    this.peakTimeMs = null;
    this.peakFrameId = null;
    this.lastDistBodyScale = Number.POSITIVE_INFINITY;
    this.backswingMaxDistBodyScale = 0;
    this.zoneDwellMs = 0;
    this.lastWrist = null;
    this.skippedFrames = 0;
    this.abortedCount = 0;
    this.lastAbortReason = null;
  }

  get diagnostics(): SegmentationDiagnostics {
    return {
      phase: this.phase,
      phaseElapsedMs: this.lastSampleAtMs == null ? 0 : this.lastSampleAtMs - this.phaseSinceMs,
      skippedFrames: this.skippedFrames,
      abortedCount: this.abortedCount,
      lastAbortReason: this.lastAbortReason,
    };
  }

  /**
   * 投入一个采样。
   * @returns 本次调用新闭合的完整挥拍；无则 null
   */
  push(sample: SegmentationSample): StrokeEvent | null {
    // 质量问题：unusable 帧不参与状态转移，但会污染当前挥拍 → 标记不完整
    if (sample.quality === "unusable") {
      this.skippedFrames++;
      if (this.currentStrokeId != null) {
        this.noteProblem("quality_unusable_during_stroke");
      }
      this.lastSampleAtMs = sample.sourceTimeMs;
      return null;
    }

    if (this.readyZoneCenterPx == null) {
      this.lastSampleAtMs = sample.sourceTimeMs;
      return null;
    }

    // 采样间断过大：直接异常结束当前挥拍，避免把两段拼成一次
    if (this.lastSampleAtMs != null) {
      const gap = sample.sourceTimeMs - this.lastSampleAtMs;
      if (gap > this.config.maxGapMs) {
        const aborted = this.abortCurrent("sampling_gap_too_large");
        this.lastSampleAtMs = sample.sourceTimeMs;
        // 间断后的第一帧不积分速度
        this.peakSpeedBodyScalePerSec = -1;
        return aborted;
      }
      if (gap <= 0) {
        // 非单调时间：不推进状态
        this.lastSampleAtMs = sample.sourceTimeMs;
        return null;
      }
    }

    const prevTime = this.lastSampleAtMs;
    this.lastSampleAtMs = sample.sourceTimeMs;

    if (sample.wristPx == null || sample.bodyScalePx == null || sample.bodyScalePx <= 0) {
      this.skippedFrames++;
      this.lastSampleTimeMs = sample.sourceTimeMs;
      if (this.currentStrokeId != null) {
        this.noteProblem("wrist_not_visible_during_stroke");
      }
      return null;
    }

    // 归一化到体尺度，使阈值不受拍摄距离影响
    const norm = (v: number) => v / sample.bodyScalePx!;
    const rel = {
      x: sample.wristPx.x - this.readyZoneCenterPx.x,
      y: sample.wristPx.y - this.readyZoneCenterPx.y,
    };
    const distBodyScale = norm(Math.hypot(rel.x, rel.y));

    // 因果速度：只用当前与上一采样，不偷看未来帧
    const speed = this.updatePeak(sample, norm, prevTime);

    const dtMs = sample.sourceTimeMs - this.lastSampleTimeMs;

    switch (this.phase) {
      // ── 准备：在准备区内稳定驻留，驻留够久就开启一次候选挥拍 ──
      case "idle":
      case "ready": {
        if (distBodyScale <= this.config.readyZoneRadiusBodyScale) {
          if (this.phase !== "ready") {
            this.enterPhase("ready", sample.sourceTimeMs);
            this.zoneDwellMs = 0;
          } else {
            // 连续驻留：只有与上一采样连续在区内才累加，中断即清零。
            if (this.lastDistBodyScale <= this.config.readyZoneRadiusBodyScale) {
              this.zoneDwellMs += dtMs;
            } else {
              this.zoneDwellMs = 0;
            }
            if (this.zoneDwellMs >= this.config.readyStableMinMs && this.currentStrokeId == null) {
              // 本组开始：从此刻起收集证据。
              // 这样引拍阶段不会被"离开准备区"这个瞬间切掉。
              this.beginStroke(sample);
            }
          }
        } else if (this.phase === "ready") {
          // 离开准备区：若有进行中的挥拍则进入引拍，否则回到 idle。
          // 使用比进入阈值更大的离开阈值，形成有界滞后。
          if (distBodyScale > this.readyZoneLeaveThreshold()) {
            this.zoneDwellMs = 0;
            if (this.currentStrokeId != null) {
              this.backswingMaxDistBodyScale = distBodyScale;
              this.enterPhase("backswing", sample.sourceTimeMs);
            } else {
              this.enterPhase("idle", sample.sourceTimeMs);
            }
          } else {
            // 缓冲区：驻留计时中断，但不切换阶段
            this.zoneDwellMs = 0;
          }
        }
        break;
      }

      // ── 引拍：持续远离准备区；确认回身后再转入向前挥拍 ──
      case "backswing": {
        this.collectFrame(sample);
        if (distBodyScale > this.backswingMaxDistBodyScale) {
          this.backswingMaxDistBodyScale = distBodyScale;
        }
        // "向前挥拍"需要同时满足：
        //   1) 已确认回身（最大偏离超过进入阈值，排除原地抖动）
        //   2) 距离正在收缩
        //   3) 速度达到配置门槛
        const confirmedBackswing =
          this.backswingMaxDistBodyScale > this.config.readyZoneRadiusBodyScale;
        const closingIn = distBodyScale < this.lastDistBodyScale - 0.01;
        const fastEnough = speed >= this.config.forwardMinSpeedBodyScalePerSec;
        if (confirmedBackswing && closingIn && fastEnough) {
          this.enterPhase("forward", sample.sourceTimeMs);
        }
        break;
      }

      // ── 向前挥拍：朝准备区方向运动 ──
      case "forward": {
        this.collectFrame(sample);
        if (distBodyScale <= this.config.readyZoneRadiusBodyScale) {
          // 进入还原观察期，从这里开始累计驻留时间
          this.enterPhase("returning", sample.sourceTimeMs);
          this.zoneDwellMs = 0;
        }
        break;
      }

      // ── 回到准备区：稳定驻留够久才算真的还原 ──
      case "returning": {
        this.collectFrame(sample);
        if (distBodyScale <= this.config.readyZoneRadiusBodyScale) {
          // 连续驻留：与上一采样连续在区内时才累加。
          // 中间断过（离开过）就必须清零重来，避免间歇性回踩被累加成"稳定"。
          if (this.lastDistBodyScale <= this.config.readyZoneRadiusBodyScale) {
            this.zoneDwellMs += dtMs;
          } else {
            this.zoneDwellMs = 0;
          }
          if (this.zoneDwellMs >= this.config.returnStableMinMs) {
            return this.completeStroke(sample);
          }
        } else if (distBodyScale > this.readyZoneLeaveThreshold()) {
          // 明确再次离开：退回引拍，重新等待一次真正的前挥，
          // 不在 forward / returning 之间来回弹跳。
          this.zoneDwellMs = 0;
          this.backswingMaxDistBodyScale = distBodyScale;
          this.enterPhase("backswing", sample.sourceTimeMs);
        } else {
          // 处于区内与离开阈值之间的缓冲区：驻留计时中断，但不切换阶段（有界滞后）
          this.zoneDwellMs = 0;
        }
        break;
      }

      case "aborted":
        this.enterPhase("idle", sample.sourceTimeMs);
        break;
    }

    this.lastDistBodyScale = distBodyScale;
    this.lastSampleTimeMs = sample.sourceTimeMs;

    // 单次挥拍超时即异常结束。
    //
    // ⚠️ `elapsedInStroke` 必须在这里**当场算**，不能用 switch 之前算好的那份（F-025）。
    // 原因：`beginStroke` 是在上面的 switch **里面**被调用的，它会把
    // `strokeStartMs` 设成本帧时间；而 `cleanupStroke` 会把它清零。
    // 若用 switch 之前的值，那么"本帧刚刚开启的这一次挥拍"会被拿去减
    // **上一笔**的 `strokeStartMs`（清算后是 0）—— 于是
    // `elapsed = sourceTimeMs - 0 = sourceTimeMs`，一旦会话跑过
    // `maxStrokeDurationMs`（默认 3s），每一次挥拍都会在**刚开启的那一帧**
    // 被判超时并丢弃。表现是：前 3 秒正常，之后再也记不到任何挥拍。
    if (this.currentStrokeId != null) {
      const elapsedInStroke = sample.sourceTimeMs - this.strokeStartMs;
      if (elapsedInStroke > this.config.maxStrokeDurationMs) {
        return this.abortCurrent("stroke_too_long");
      }
    }
    return null;
  }

  private lastDistBodyScale = Number.POSITIVE_INFINITY;
  /** 引拍期间到达过的最大偏离距离，用于确认"确实回过身" */
  private backswingMaxDistBodyScale = 0;
  /** 在准备区内的累计驻留时间，用于确认"真的停下来了" */
  private zoneDwellMs = 0;
  /** 上一采样的时间戳，用于累计驻留时间 */
  private lastSampleTimeMs = 0;

  /**
   * 离开准备区的判定阈值。
   * 比进入阈值大 20%，形成有界滞后，避免在边界上反复切换。
   */
  private readyZoneLeaveThreshold(): number {
    return this.config.readyZoneRadiusBodyScale * 1.2;
  }

  /**
   * 更新腕部速度峰值，并返回**当前这一采样**的速度（体尺度/秒）。
   *
   * 峰值的实际时间戳同时被记录，供 `return_after_wrist_peak_ms` 使用。
   * 注意：峰值是腕部速度峰值，不是已确认的击球时刻。
   */
  private updatePeak(
    sample: SegmentationSample,
    norm: (v: number) => number,
    prevTime: number | null,
  ): number {
    const cur = sample.wristPx;
    if (cur == null) return 0;

    if (prevTime == null || this.lastWrist == null) {
      this.lastWrist = { ...cur };
      return 0;
    }
    const dtSec = (sample.sourceTimeMs - prevTime) / 1000;
    if (dtSec <= 0) return 0;

    const dPx = Math.hypot(cur.x - this.lastWrist.x, cur.y - this.lastWrist.y);
    const speed = norm(dPx) / dtSec;

    if (speed > this.peakSpeedBodyScalePerSec) {
      this.peakSpeedBodyScalePerSec = speed;
      this.peakTimeMs = sample.sourceTimeMs;
      this.peakFrameId = sample.frameId;
    }
    this.lastWrist = { ...cur };
    return speed;
  }

  private lastWrist: { x: number; y: number } | null = null;

  private beginStroke(sample: SegmentationSample): void {
    this.strokeCounter++;
    this.currentStrokeId = `st_${sample.sourceTimeMs}_${this.strokeCounter}`;
    this.strokeStartMs = sample.sourceTimeMs;
    this.strokeFrames = [sample.frameId];
    this.strokeReasons = [];
    this.peakSpeedBodyScalePerSec = -1;
    this.peakTimeMs = null;
    this.peakFrameId = null;
    this.lastWrist = sample.wristPx ? { ...sample.wristPx } : null;
    this.backswingMaxDistBodyScale = 0;
    this.zoneDwellMs = 0;
  }

  private collectFrame(sample: SegmentationSample): void {
    this.strokeFrames.push(sample.frameId);
  }

  private noteProblem(reason: string): void {
    if (!this.strokeReasons.includes(reason)) this.strokeReasons.push(reason);
  }

  private enterPhase(phase: StrokePhase, timeMs: number): void {
    this.phase = phase;
    this.phaseSinceMs = timeMs;
  }

  private phaseElapsed(nowMs: number): number {
    return nowMs - this.phaseSinceMs;
  }

  /**
   * 完整闭合：只有在走完 准备→引拍→向前→回到准备区 时才成立。
   */
  private completeStroke(sample: SegmentationSample): StrokeEvent {
    const strokeId = this.currentStrokeId!;
    const anchorTime = this.peakTimeMs ?? this.strokeStartMs;
    const event: StrokeEvent = {
      strokeId,
      startMs: this.strokeStartMs,
      endMs: sample.sourceTimeMs,
      anchor: { type: "wrist_speed_peak", timeMs: anchorTime },
      // 未可靠识别球拍接触球 → 始终为 null
      impactTimeMs: null,
      complete: true,
      evidenceFrameIds: dedupe([
        ...this.strokeFrames,
        ...(this.peakFrameId ? [this.peakFrameId] : []),
      ]),
      reasons: [...this.strokeReasons],
    };
    this.cleanupStroke();
    // 回到准备区重新开始驻留计时，使连续挥拍能各自独立成立。
    this.enterPhase("ready", sample.sourceTimeMs);
    this.zoneDwellMs = 0;
    return event;
  }

  /**
   * 异常结束：遮挡、出画、长时间间断、换动作。
   * 返回不完整事件，供上层标记为待复查样本，**不计入有效挥拍数**。
   */
  private abortCurrent(reason: string): StrokeEvent | null {
    if (this.currentStrokeId == null) {
      this.enterPhase("idle", this.lastSampleAtMs ?? 0);
      return null;
    }
    this.noteProblem(reason);
    this.abortedCount++;
    this.lastAbortReason = reason;

    const strokeId = this.currentStrokeId;
    const anchorTime = this.peakTimeMs ?? this.strokeStartMs;
    const event: StrokeEvent = {
      strokeId,
      startMs: this.strokeStartMs,
      endMs: this.lastSampleAtMs,
      anchor: { type: "wrist_speed_peak", timeMs: anchorTime },
      impactTimeMs: null,
      complete: false,
      evidenceFrameIds: [...this.strokeFrames],
      reasons: [...this.strokeReasons],
    };
    this.cleanupStroke();
    this.enterPhase("idle", this.lastSampleAtMs ?? 0);
    return event;
  }

  private cleanupStroke(): void {
    this.currentStrokeId = null;
    this.strokeStartMs = 0;
    this.strokeFrames = [];
    this.strokeReasons = [];
    this.peakSpeedBodyScalePerSec = -1;
    this.peakTimeMs = null;
    this.peakFrameId = null;
    this.lastDistBodyScale = Number.POSITIVE_INFINITY;
    this.lastWrist = null;
    this.backswingMaxDistBodyScale = 0;
    this.zoneDwellMs = 0;
  }
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
