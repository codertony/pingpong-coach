/**
 * 在线（因果）滤波。
 *
 * 方案第 8.3 节明确要求：
 * 滤波使用适合在线处理的因果方法。**不要**用依赖未来整段数据的离线平滑
 * 制造出无法实时复现的效果。保留原始轨迹与滤波配置，
 * 避免平滑延迟被误判为动作启动顺序。
 *
 * 因此本模块只提供单向、依赖历史样本的滤波器：
 * - 一阶指数平滑（EMA）
 * - 一维/二维 One-Euro 滤波（低速低抖动、高速低延迟）
 *
 * 注意：这些滤波器会引入相位延迟。任何"谁先谁后"的时序结论，
 * 必须同时考虑滤波延迟与采样间隔，无法分辨时必须报告"无法分辨"。
 */

export interface FilterConfig {
  /** 类型标识，写入证据与日志，便于复现 */
  kind: "ema" | "one_euro" | "none";
  /** EMA 平滑系数，0–1，越大越跟随原值 */
  alpha?: number;
  /** One-Euro 最低截止频率，越小越平滑 */
  minCutoff?: number;
  /** One-Euro 速度系数，越大对快速动作越敏感 */
  beta?: number;
  /** One-Euro 导数截止频率 */
  dCutoff?: number;
}

export const NO_FILTER: FilterConfig = { kind: "none" };

export function emaConfig(alpha = 0.5): FilterConfig {
  return { kind: "ema", alpha };
}

export function oneEuroConfig(
  minCutoff = 1.0,
  beta = 0.007,
  dCutoff = 1.0,
): FilterConfig {
  return { kind: "one_euro", minCutoff, beta, dCutoff };
}

/**
 * 一维标量因果滤波器。
 * 用法：每来一个样本调用一次 `push(value, timeMs)`。
 * 重置：在 sourceEpoch 变化（seek/重播/切摄像头）时必须调用 `reset()`。
 */
export class ScalarFilter {
  private readonly config: FilterConfig;
  private hasPrev = false;
  private prevRaw = 0;
  private prevFiltered = 0;
  private prevTimeMs = 0;
  private prevDeriv = 0;

  constructor(config: FilterConfig) {
    this.config = config;
  }

  /**
   * 投入一个新样本。
   * @param value 原始值
   * @param timeMs 单调递增的时间戳（毫秒）
   * @returns 滤波后的值；首个样本原样返回
   */
  push(value: number, timeMs: number): number {
    if (!Number.isFinite(value)) {
      // 缺失值不参与滤波，也不污染状态：保持缺失语义。
      return this.hasPrev ? this.prevFiltered : value;
    }

    if (this.config.kind === "none") {
      this.remember(value, value, timeMs);
      return value;
    }

    if (!this.hasPrev) {
      this.remember(value, value, timeMs);
      return value;
    }

    const dtSec = Math.max((timeMs - this.prevTimeMs) / 1000, 1e-6);

    if (this.config.kind === "ema") {
      const alpha = clamp(this.config.alpha ?? 0.5, 0, 1);
      const out = this.prevFiltered + alpha * (value - this.prevFiltered);
      this.remember(value, out, timeMs);
      return out;
    }

    // One-Euro：根据瞬时速度自适应调整截止频率，兼顾静止抖动与快速挥拍延迟。
    const rawDeriv = (value - this.prevRaw) / dtSec;
    const aDeriv = smoothingFactor(dtSec, this.config.dCutoff ?? 1.0);
    const deriv = this.prevDeriv + aDeriv * (rawDeriv - this.prevDeriv);

    const cutoff = (this.config.minCutoff ?? 1.0) + (this.config.beta ?? 0.007) * Math.abs(deriv);
    const a = smoothingFactor(dtSec, cutoff);
    const out = this.prevFiltered + a * (value - this.prevFiltered);

    this.prevDeriv = deriv;
    this.remember(value, out, timeMs);
    return out;
  }

  /** 当前滤波值，未收到任何样本时返回 null */
  get value(): number | null {
    return this.hasPrev ? this.prevFiltered : null;
  }

  /** 源切换时必须重置，避免把上一段视频的状态带到新片段 */
  reset(): void {
    this.hasPrev = false;
    this.prevRaw = 0;
    this.prevFiltered = 0;
    this.prevTimeMs = 0;
    this.prevDeriv = 0;
  }

  private remember(raw: number, filtered: number, timeMs: number): void {
    this.prevRaw = raw;
    this.prevFiltered = filtered;
    this.prevTimeMs = timeMs;
    this.hasPrev = true;
  }
}

/** 二维点滤波器。x/y 独立滤波，保持同一时间戳。 */
export class PointFilter {
  private readonly fx: ScalarFilter;
  private readonly fy: ScalarFilter;

  constructor(config: FilterConfig) {
    this.fx = new ScalarFilter(config);
    this.fy = new ScalarFilter(config);
  }

  push(point: { x: number; y: number }, timeMs: number): { x: number; y: number } {
    return {
      x: this.fx.push(point.x, timeMs),
      y: this.fy.push(point.y, timeMs),
    };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}

/**
 * One-Euro 的平滑系数。
 * cutoff 单位 Hz，dt 单位秒。
 */
function smoothingFactor(dtSec: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dtSec);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 因果速度估计。
 *
 * 只使用当前与上一个样本，不使用未来样本。
 * 采样间隔过小时速度估计噪声大，调用方应结合 `maxGapMs` 判断可信度。
 */
export class SpeedEstimator {
  private prev: { x: number; y: number } | null = null;
  private prevTimeMs = 0;

  /** 返回该点相对上一采样的速度（像素/秒）。首个样本返回 null。 */
  push(point: { x: number; y: number }, timeMs: number): number | null {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      // 缺失点：断开速度链，不产生假的速度峰值。
      this.prev = null;
      return null;
    }
    if (this.prev == null) {
      this.prev = point;
      this.prevTimeMs = timeMs;
      return null;
    }
    const dtSec = (timeMs - this.prevTimeMs) / 1000;
    if (dtSec <= 0) return null;
    const dist = Math.hypot(point.x - this.prev.x, point.y - this.prev.y);
    this.prev = point;
    this.prevTimeMs = timeMs;
    return dist / dtSec;
  }

  reset(): void {
    this.prev = null;
    this.prevTimeMs = 0;
  }
}
