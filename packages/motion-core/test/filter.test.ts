import { describe, expect, it } from "vitest";
import { ScalarFilter, SpeedEstimator, PointFilter, emaConfig, NO_FILTER } from "../src/filter.js";
import { computeSamplingStats, DEFAULT_QUALITY_CONFIG } from "../src/quality.js";

describe("ScalarFilter（因果滤波）", () => {
  it("kind=none 时原样透传", () => {
    const f = new ScalarFilter(NO_FILTER);
    expect(f.push(5, 0)).toBe(5);
    expect(f.push(99, 10)).toBe(99);
  });

  it("首个样本原样返回，不平滑", () => {
    const f = new ScalarFilter(emaConfig(0.5));
    expect(f.push(10, 0)).toBe(10);
  });

  it("EMA 按 alpha 收敛，且不需要未来样本", () => {
    const f = new ScalarFilter(emaConfig(0.5));
    f.push(0, 0);
    // 第二个样本：0 + 0.5*(10-0) = 5
    expect(f.push(10, 10)).toBeCloseTo(5, 10);
    // 第三个样本：5 + 0.5*(10-5) = 7.5
    expect(f.push(10, 20)).toBeCloseTo(7.5, 10);
    expect(f.value).toBeCloseTo(7.5, 10);
  });

  it("reset 后状态清空，首样本再次原样返回", () => {
    const f = new ScalarFilter(emaConfig(0.1));
    f.push(0, 0);
    f.push(100, 10);
    f.reset();
    expect(f.value).toBeNull();
    expect(f.push(42, 0)).toBe(42);
  });

  it("NaN 不污染滤波器状态", () => {
    const f = new ScalarFilter(emaConfig(0.5));
    f.push(10, 0);
    f.push(Number.NaN, 10);
    // 缺失值不推进滤波，后续样本仍按上一有效值平滑
    expect(f.push(20, 20)).toBeCloseTo(15, 10);
  });

  it("One-Euro 比固定 EMA 对快速变化响应更快", () => {
    const oneEuro = new ScalarFilter({ kind: "one_euro", minCutoff: 1, beta: 0.5, dCutoff: 1 });
    const ema = new ScalarFilter(emaConfig(0.3));
    oneEuro.push(0, 0);
    ema.push(0, 0);
    // 一个大幅度快速跳变
    const oe = oneEuro.push(100, 16);
    const em = ema.push(100, 16);
    expect(oe).toBeGreaterThan(em);
  });
});

describe("SpeedEstimator", () => {
  it("首个样本无速度", () => {
    const s = new SpeedEstimator();
    expect(s.push({ x: 0, y: 0 }, 0)).toBeNull();
  });

  it("按像素/秒计算，且只用过去样本", () => {
    const s = new SpeedEstimator();
    s.push({ x: 0, y: 0 }, 0);
    // 100ms 移动 10px → 100 px/s
    expect(s.push({ x: 10, y: 0 }, 100)).toBeCloseTo(100, 6);
  });

  it("缺失点会断开速度链，不产生假峰值", () => {
    const s = new SpeedEstimator();
    s.push({ x: 0, y: 0 }, 0);
    s.push({ x: Number.NaN, y: 0 }, 100);
    // 缺失后的下一个样本重新成为链起点，没有速度
    expect(s.push({ x: 500, y: 0 }, 200)).toBeNull();
  });

  it("时间不前进时返回 null，避免除零", () => {
    const s = new SpeedEstimator();
    s.push({ x: 0, y: 0 }, 100);
    expect(s.push({ x: 10, y: 0 }, 100)).toBeNull();
  });
});

describe("PointFilter", () => {
  it("x/y 独立平滑", () => {
    const f = new PointFilter(emaConfig(0.5));
    const p1 = f.push({ x: 0, y: 0 }, 0);
    expect(p1).toEqual({ x: 0, y: 0 });
    const p2 = f.push({ x: 10, y: 20 }, 10);
    expect(p2.x).toBeCloseTo(5, 10);
    expect(p2.y).toBeCloseTo(10, 10);
  });
});

describe("computeSamplingStats", () => {
  it("按间隔中位数反推处理频率", () => {
    // 每 40ms 一帧 → 25 FPS
    const times = [0, 40, 80, 120, 160];
    const stats = computeSamplingStats(times);
    expect(stats.processedFrames).toBe(5);
    expect(stats.processedFps).toBeCloseTo(25, 6);
    expect(stats.monotonic).toBe(true);
  });

  it("统计采样空隙，不隐藏慢帧", () => {
    const times = [0, 40, 80, 500, 540];
    const stats = computeSamplingStats(times, { ...DEFAULT_QUALITY_CONFIG, maxGapMs: 200 });
    expect(stats.gapCount).toBe(1);
    expect(stats.maxGapMs).toBe(420);
  });

  it("时间非单调时标记 monotonic=false", () => {
    const stats = computeSamplingStats([0, 40, 20, 60]);
    expect(stats.monotonic).toBe(false);
  });

  it("样本少于 2 个时不给频率", () => {
    const stats = computeSamplingStats([0]);
    expect(stats.processedFps).toBeNull();
    expect(stats.medianIntervalMs).toBeNull();
  });
});
