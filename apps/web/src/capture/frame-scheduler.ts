/**
 * 帧调度与时间戳。
 *
 * 时间约定（方案第 7 节）：
 * - sourceTimeMs 来自源视频媒体时间。导入视频以媒体时间为准，
 *   **不能**用播放耗时计算运动速度。
 * - receivedAtMonoMs 是浏览器收到帧时的单调时钟，只用于记录处理耗时，
 *   不冒充相机曝光时间。
 *
 * 调度约束（方案第 5 节）：
 * - 同时只保留一个正在推理的帧任务。
 * - 繁忙时用最新待处理帧替换旧待处理帧（而不是排队等）。
 * - 所有丢帧计入质量指标。
 */

import type { PoseFrame } from "@pingpong/contracts";

export interface FrameEnvelope {
  frameId: string;
  /** 源媒体时间（毫秒） */
  sourceTimeMs: number;
  /** 浏览器收到该帧的单调时钟（毫秒） */
  receivedAtMonoMs: number;
  /** 源代次。seek/重播/换摄像头时递增 */
  sourceEpoch: number;
  /** 待推理的图像位图 */
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export interface SchedulerStats {
  /** 实际提交给推理的帧数 */
  submitted: number;
  /** 因繁忙被丢弃的帧数（用最新帧替换时计数） */
  dropped: number;
  /** 估算的实际处理频率 */
  actualFps: number | null;
}

/**
 * 单任务帧调度器。
 *
 * 关键行为：繁忙时不排队，而是**用最新帧替换待处理帧**，
 * 并把这个替换计为一次丢帧。这样处理的永远是新鲜数据。
 */
export class FrameScheduler {
  private pending: FrameEnvelope | null = null;
  private busy = false;
  private submitted = 0;
  private dropped = 0;
  private timestamps: number[] = [];

  constructor(private readonly handler: (frame: FrameEnvelope) => Promise<void>) {}

  /** 提交一帧。若当前正忙，则替换掉旧的待处理帧。 */
  submit(frame: FrameEnvelope): void {
    if (this.busy) {
      if (this.pending) {
        // 旧待处理帧被替换 → 计入丢帧，并释放其位图避免泄漏
        this.pending.bitmap.close();
        this.dropped++;
      }
      this.pending = frame;
      return;
    }
    void this.run(frame);
  }

  private async run(frame: FrameEnvelope): Promise<void> {
    this.busy = true;
    try {
      this.submitted++;
      this.timestamps.push(frame.receivedAtMonoMs);
      if (this.timestamps.length > 240) this.timestamps.shift();
      await this.handler(frame);
    } catch (err) {
      // 单帧处理失败不应中断整个训练循环。
      // 记录后继续，避免一个坏帧让摄像头链路停摆。
      this.lastError = err instanceof Error ? err.message : String(err);
      this.errorCount++;
    } finally {
      // 处理完成即释放，绝不缓存全分辨率原始图像
      frame.bitmap.close();
      this.busy = false;

      const next = this.pending;
      this.pending = null;
      if (next) void this.run(next);
    }
  }

  /** 最近一次处理错误（供界面展示），以及累计错误数。 */
  private lastError: string | null = null;
  private errorCount = 0;

  get lastErrorMessage(): string | null {
    return this.lastError;
  }

  get errors(): number {
    return this.errorCount;
  }

  /** 停止训练时清空待处理帧并释放资源。 */
  drain(): void {
    if (this.pending) {
      this.pending.bitmap.close();
      this.pending = null;
    }
    this.busy = false;
  }

  get stats(): SchedulerStats {
    let fps: number | null = null;
    if (this.timestamps.length >= 2) {
      const first = this.timestamps[0]!;
      const last = this.timestamps[this.timestamps.length - 1]!;
      const span = last - first;
      if (span > 0) fps = ((this.timestamps.length - 1) / span) * 1000;
    }
    return { submitted: this.submitted, dropped: this.dropped, actualFps: fps };
  }

  resetStats(): void {
    this.submitted = 0;
    this.dropped = 0;
    this.timestamps = [];
  }
}

/** 生成帧 ID。时间戳 + 序号，保证同一毫秒内也可区分。 */
let frameSeq = 0;
export function nextFrameId(sourceEpoch: number, sourceTimeMs: number): string {
  frameSeq++;
  return `e${sourceEpoch}_t${Math.round(sourceTimeMs)}_${frameSeq}`;
}

/**
 * 单调时钟。优先使用 performance.now()，
 * 缺失时退化到 Date.now()（仅用于耗时记录，不用于媒体时间）。
 */
export function monotonicNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * 源代次管理。在 seek / 重播 / 切换摄像头时必须递增，
 * 并通知下游重置跟踪与分段状态。
 */
export class SourceEpochTracker {
  private epoch = 0;
  private listeners: Array<(epoch: number) => void> = [];

  get current(): number {
    return this.epoch;
  }

  /** 递增代次并通知监听者。返回新的代次。 */
  bump(): number {
    this.epoch++;
    for (const l of this.listeners) l(this.epoch);
    return this.epoch;
  }

  onReset(listener: (epoch: number) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}

/** 从姿态结果构造 PoseFrame 的公共形状（不含关键点，由 vision 层补充）。 */
export type PoseFrameBase = Omit<
  PoseFrame,
  | "modelId"
  | "keypointSet"
  | "imageWidth"
  | "imageHeight"
  | "keypoints2D"
  | "quality"
  | "qualityReasons"
>;
