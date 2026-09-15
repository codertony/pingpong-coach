/**
 * motion-core 边界与退化行为测试。
 *
 * 这些用例针对的是「输入处在合法与非法之间」的情形。
 * 它们不追求覆盖率数字，只覆盖那些**出错时静默产生错误数值**的路径 ——
 * 返回 0 而不是 null、拿 NaN 当测量值、把退化三角形算成有效角度。
 */

import { describe, expect, it } from "vitest";
import {
  angleDeg,
  angleDegFromNormalized,
  bodyScale,
  coefficientOfVariation,
  distance,
  isUsablePoint,
  mean,
  median,
  midpoint,
  quantile,
  relativeToReference,
} from "../src/geometry.js";
import {
  NO_FILTER,
  PointFilter,
  ScalarFilter,
  SpeedEstimator,
  emaConfig,
  oneEuroConfig,
} from "../src/filter.js";

describe("geometry — 非法输入一律返回 null 而不是 0", () => {
  it("isUsablePoint 拒绝 null / undefined / NaN 坐标", () => {
    expect(isUsablePoint(null)).toBe(false);
    expect(isUsablePoint(undefined)).toBe(false);
    expect(isUsablePoint({ x: NaN, y: 0 })).toBe(false);
    expect(isUsablePoint({ x: 0, y: Infinity })).toBe(false);
    expect(isUsablePoint({ x: 0, y: 0 })).toBe(true);
    // (0,0) 是合法点，必须与「缺失」区分开。
    expect(isUsablePoint({ x: 0, y: 0 })).not.toBe(false);
  });

  it("distance 对非法点返回 null，不返回 0", () => {
    expect(distance({ x: NaN, y: 0 }, { x: 0, y: 0 })).toBeNull();
    expect(distance({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(0);
  });

  it("angleDeg 三点重合返回 null（退化，不是 0 度）", () => {
    const p = { x: 10, y: 10 };
    expect(angleDeg(p, p, p)).toBeNull();
  });

  it("angleDeg 顶点与端点重合返回 null", () => {
    expect(angleDeg({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
    expect(angleDeg({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });

  it("angleDeg 对含 NaN 的输入返回 null", () => {
    expect(angleDeg({ x: NaN, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });

  it("angleDeg 结果落在 [0,180] 闭区间", () => {
    // 各种极端水平偏移：极小、大量级、符号相反
    const xOffsets = [0, -5, 1e6, -1e6, 0.0001, -0.0001];
    for (const a1 of xOffsets) {
      for (const c1 of xOffsets) {
        const a = angleDeg({ x: a1, y: 0 }, { x: 0, y: 0 }, { x: c1, y: 0 });
        if (a != null) {
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThanOrEqual(180);
        }
      }
    }
  });
});

describe("geometry — 长宽比修正的极端情形", () => {
  it("宽高非法（0 或负数）返回 null，不做静默近似", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 0.5, y: 0 };
    const c = { x: 1, y: 0 };
    expect(angleDegFromNormalized(a, b, c, 0, 720)).toBeNull();
    expect(angleDegFromNormalized(a, b, c, 1280, 0)).toBeNull();
    expect(angleDegFromNormalized(a, b, c, -1, 720)).toBeNull();
    expect(angleDegFromNormalized(a, b, c, 1280, -1)).toBeNull();
    expect(angleDegFromNormalized(a, b, c, NaN, 720)).toBeNull();
  });

  it("正方形画面下，归一化计算与像素计算一致", () => {
    const a = { x: 0.2, y: 0.5 };
    const b = { x: 0.5, y: 0.5 };
    const c = { x: 0.5, y: 0.2 };
    const fromNorm = angleDegFromNormalized(a, b, c, 1000, 1000);
    const fromPx = angleDeg({ x: 200, y: 500 }, { x: 500, y: 500 }, { x: 500, y: 200 });
    expect(fromNorm).not.toBeNull();
    expect(fromNorm).toBeCloseTo(fromPx as number, 6);
    expect(fromNorm).toBeCloseTo(90, 6);
  });

  it("轴向直角不受长宽比影响（两条臂各自沿一个轴缩放）", () => {
    // 水平臂 + 垂直臂：缩放各自沿自身轴，角度不变。
    const v = angleDegFromNormalized(
      { x: 0, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 1 },
      1280,
      720,
    );
    expect(v).toBeCloseTo(90, 6);
  });

  it("极窄画面（1x1000）产生极端失真但仍返回有限值而非 NaN", () => {
    const v = angleDegFromNormalized({ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }, 1, 1000);
    expect(v).not.toBeNull();
    expect(Number.isFinite(v as number)).toBe(true);
  });
});

describe("geometry — 统计函数对空集与常数列的处理", () => {
  it("mean 空数组返回 null 而不是 0", () => {
    expect(mean([])).toBeNull();
  });

  it("mean 过滤掉 NaN 与 Infinity", () => {
    expect(mean([1, 2, NaN, Infinity, 3])).toBeCloseTo(2, 6);
  });

  it("median 空数组返回 null", () => {
    expect(median([])).toBeNull();
  });

  it("median 偶数个取中间两数均值", () => {
    expect(median([1, 2, 3, 4])).toBeCloseTo(2.5, 6);
  });

  it("coefficientOfVariation 单个样本返回 null（无法谈离散度）", () => {
    expect(coefficientOfVariation([5])).toBeNull();
    expect(coefficientOfVariation([])).toBeNull();
  });

  it("coefficientOfVariation 均值为 0 时返回 null（避免除零产生 Infinity）", () => {
    // [+1, -1] 均值恰为 0，此时 CV 无定义，必须返回 null 而不是 Infinity。
    expect(coefficientOfVariation([1, -1])).toBeNull();
  });

  it("coefficientOfVariation 常数列为 0（离散度为零是有效结论）", () => {
    expect(coefficientOfVariation([7, 7, 7, 7])).toBeCloseTo(0, 9);
  });

  it("coefficientOfVariation 恒非负", () => {
    const v = coefficientOfVariation([1, 5, 9, 3]);
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThanOrEqual(0);
  });

  it("quantile 空数组返回 null", () => {
    expect(quantile([], 0.5)).toBeNull();
  });

  it("quantile 边界 q<=0 与 q>=1 被夹到两端", () => {
    const xs = [1, 2, 3, 4, 5];
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, -1)).toBe(1);
    expect(quantile(xs, 1)).toBe(5);
    expect(quantile(xs, 99)).toBe(5);
  });

  it("quantile 中位数与 median 一致（两种实现不能互相矛盾）", () => {
    const xs = [3, 1, 4, 1, 5, 9, 2, 6];
    expect(quantile(xs, 0.5)).toBeCloseTo(median(xs) as number, 9);
  });

  it("quantile 不修改传入数组（输入被排序时不得原地改动调用方数据）", () => {
    const xs = [3, 1, 2];
    quantile(xs, 0.5);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("geometry — 体尺度与相对位移", () => {
  it("bodyScale 两点重合返回 null（除零保护）", () => {
    expect(bodyScale({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeNull();
  });

  it("bodyScale 非法点返回 null", () => {
    expect(bodyScale({ x: NaN, y: 0 }, { x: 0, y: 1 })).toBeNull();
  });

  it("bodyScale 恒为正", () => {
    expect(bodyScale({ x: 0, y: 0 }, { x: 3, y: 4 }) as number).toBeCloseTo(5, 9);
  });

  it("midpoint 任一点非法则整体为 null", () => {
    expect(midpoint({ x: NaN, y: 0 }, { x: 1, y: 1 })).toBeNull();
    expect(midpoint({ x: 0, y: 0 }, { x: 2, y: 2 })).toEqual({ x: 1, y: 1 });
  });

  it("relativeToReference 消除整体平移：同向等量移动后结果不变", () => {
    const p1 = relativeToReference({ x: 10, y: 10 }, { x: 5, y: 5 });
    const p2 = relativeToReference({ x: 110, y: 210 }, { x: 105, y: 205 });
    expect(p1).toEqual(p2);
  });

  it("relativeToReference 非法输入返回 null", () => {
    expect(relativeToReference({ x: NaN, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });
});

describe("filter — 极端输入与状态边界", () => {
  it("NO_FILTER 原样透传", () => {
    const f = new ScalarFilter(NO_FILTER);
    expect(f.push(1, 0)).toBe(1);
    expect(f.push(999, 16)).toBe(999);
  });

  it("首个样本原样返回（滤波不能凭空造出历史）", () => {
    const f = new ScalarFilter(emaConfig(0.1));
    expect(f.push(42, 0)).toBe(42);
  });

  it("EMA alpha=1 时退化为原样透传", () => {
    const f = new ScalarFilter(emaConfig(1));
    f.push(0, 0);
    expect(f.push(100, 16)).toBe(100);
  });

  it("EMA alpha=0 时彻底不更新（保持首值）", () => {
    const f = new ScalarFilter(emaConfig(0));
    f.push(10, 0);
    expect(f.push(1000, 16)).toBe(10);
  });

  it("NaN 输入不污染滤波状态（否则之后所有输出都会变 NaN）", () => {
    const f = new ScalarFilter(emaConfig(0.5));
    f.push(10, 0);
    const afterNaN = f.push(NaN, 16);
    // 关键：NaN 不应把状态毁掉。返回上次值或跳过都算合理，但不能是 NaN。
    expect(Number.isNaN(afterNaN as number)).toBe(false);
    const after = f.push(20, 32);
    expect(Number.isNaN(after as number)).toBe(false);
  });

  it("时间倒流时 EMA 不产生倒退结果", () => {
    const f = new ScalarFilter(emaConfig(0.5));
    f.push(10, 100);
    const v = f.push(20, 50); // 时间倒退
    expect(v).not.toBeNull();
    expect(Number.isNaN(v as number)).toBe(false);
  });

  it("reset 后回到首样本语义", () => {
    const f = new ScalarFilter(emaConfig(0.5));
    f.push(10, 0);
    f.push(100, 16);
    f.reset();
    expect(f.push(7, 32)).toBe(7);
  });

  it("One-Euro 在大步长变化上比 EMA 更跟手（这是选它的理由）", () => {
    const ema = new ScalarFilter(emaConfig(0.2));
    const oe = new ScalarFilter(oneEuroConfig(1, 0.007, 1));
    ema.push(0, 0);
    oe.push(0, 0);
    let e = 0;
    let o = 0;
    for (let i = 1; i <= 5; i++) {
      e = ema.push(100, i * 16) as number;
      o = oe.push(100, i * 16) as number;
    }
    expect(o).toBeGreaterThanOrEqual(e);
  });

  it("SpeedEstimator 首样本无速度（缺少上一帧，不能假设为 0）", () => {
    const s = new SpeedEstimator();
    expect(s.push({ x: 0, y: 0 }, 0)).toBeNull();
  });

  it("SpeedEstimator 时间不前进时返回 null 而不是 Infinity", () => {
    const s = new SpeedEstimator();
    s.push({ x: 0, y: 0 }, 100);
    const v = s.push({ x: 10, y: 0 }, 100);
    expect(v).toBeNull();
  });

  it("SpeedEstimator 用 NaN 表示缺失点：断链后不产生假速度峰值", () => {
    const s = new SpeedEstimator();
    s.push({ x: 0, y: 0 }, 0);
    // 注意契约：这两个 filter 用 NaN（而非 null）表示「本帧没有该点」，
    // 因为函数签名要求 {x,y}，null 不在类型里。调用方负责把缺失点转成 NaN。
    expect(s.push({ x: NaN, y: NaN }, 16)).toBeNull();
    // 关键：断链后重新出现，首个速度必须仍为 null ——
    // 不能跨过缺失区间拿两帧前的点去算速度，那会凭空造出一个速度峰值。
    expect(s.push({ x: 100, y: 0 }, 32)).toBeNull();
  });

  it("SpeedEstimator 断链后第二次有效样本才恢复速度输出", () => {
    const s = new SpeedEstimator();
    s.push({ x: 0, y: 0 }, 0);
    s.push({ x: NaN, y: NaN }, 16);
    expect(s.push({ x: 100, y: 0 }, 32)).toBeNull();
    // 再给一帧，这时才有可比的上一采样点。
    expect(s.push({ x: 110, y: 0 }, 48)).not.toBeNull();
  });

  it("SpeedEstimator 速度恒非负", () => {
    const s = new SpeedEstimator();
    s.push({ x: 0, y: 0 }, 0);
    const v = s.push({ x: -30, y: -40 }, 16);
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThanOrEqual(0);
  });

  it("PointFilter 遇到 NaN 时该轴输出不是 NaN（避免污染整条链路）", () => {
    const pf = new PointFilter(emaConfig(0.5));
    pf.push({ x: 10, y: 10 }, 0);
    const out = pf.push({ x: NaN, y: 20 }, 16);
    expect(Number.isNaN(out.x)).toBe(false);
    expect(Number.isNaN(out.y)).toBe(false);
  });

  it("PointFilter 首个有效样本原样返回", () => {
    const pf = new PointFilter(emaConfig(0.5));
    expect(pf.push({ x: 3, y: 4 }, 0)).toEqual({ x: 3, y: 4 });
  });

  it("PointFilter 收敛向稳定目标值", () => {
    const pf = new PointFilter(emaConfig(0.5));
    pf.push({ x: 0, y: 0 }, 0);
    let last = { x: 0, y: 0 };
    for (let i = 1; i <= 20; i++) {
      last = pf.push({ x: 100, y: 100 }, i * 16) as { x: number; y: number };
    }
    expect(last.x).toBeCloseTo(100, 3);
    expect(last.y).toBeCloseTo(100, 3);
  });
});
