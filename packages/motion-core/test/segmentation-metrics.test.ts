/**
 * 分段评估匹配的单元测试。
 *
 * 这一组测试守的**不是算法精度**，而是**口径**：
 * 指标一旦被算错（或分母被悄悄筛掉），对外就是一个看起来很像样的假数字，
 * 而假数字比没有数字更有害 —— 它会直接进决策。
 *
 * 所以这里针对每一处"容易被做手脚"的地方各钉一条。
 */

import { describe, expect, it } from "vitest";
import {
  IOU_MATCH_THRESHOLD,
  boundaryToleranceMs,
  matchSegments,
  temporalIoU,
  type TimeWindow,
} from "../src/segmentation-metrics.js";

const w = (startMs: number, endMs: number): TimeWindow => ({ startMs, endMs });

describe("temporalIoU", () => {
  it("完全重合为 1，完全不交为 0", () => {
    expect(temporalIoU(w(0, 100), w(0, 100))).toBeCloseTo(1, 10);
    expect(temporalIoU(w(0, 100), w(200, 300))).toBe(0);
  });

  it("部分重叠按 交 ÷ 并 计算", () => {
    // 交 50，并 150 → 1/3
    expect(temporalIoU(w(0, 100), w(50, 150))).toBeCloseTo(1 / 3, 10);
  });

  it("包含关系按 短 ÷ 长 计算", () => {
    // 交 50，并 200 → 0.25
    expect(temporalIoU(w(0, 200), w(50, 100))).toBeCloseTo(0.25, 10);
  });

  it("零长度区间给 0，**不给 NaN**", () => {
    // NaN 会顺着求平均一路污染上去，最后打印出一个 NaN 的"准确率"
    expect(temporalIoU(w(100, 100), w(100, 100))).toBe(0);
    expect(temporalIoU(w(0, 0), w(-10, 10))).toBe(0);
  });

  it("起始晚于结束的退化区间按 0 时长处理，不产生负值", () => {
    expect(temporalIoU(w(200, 100), w(0, 300))).toBe(0);
  });
});

describe("matchSegments · 配对", () => {
  it("一对一命中：precision 与 recall 都是 1", () => {
    const r = matchSegments([w(1000, 1500)], [w(1010, 1490)]);
    expect(r.matched).toHaveLength(1);
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(1);
    expect(r.missed).toHaveLength(0);
    expect(r.spurious).toHaveLength(0);
  });

  it("IoU 恰好在门槛上（0.5）算命中 —— 验收定义写的就是 ≥ 0.5", () => {
    // [0,100] 与 [50,150]：= 1/3，不够。构造恰好 0.5 的一对：
    // [0,100] 与 [0,200] → 100/200 = 0.5
    const r = matchSegments([w(0, 200)], [w(0, 100)]);
    expect(IOU_MATCH_THRESHOLD).toBe(0.5);
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(1);
  });

  it("IoU 差一点点就**不**算命中（门槛不是摆设）", () => {
    const r = matchSegments([w(0, 201)], [w(0, 100)]); // 100/201 ≈ 0.4975
    expect(r.matched).toHaveLength(0);
    expect(r.precision).toBe(0);
    expect(r.recall).toBe(0);
    expect(r.spurious).toHaveLength(1);
    expect(r.missed).toHaveLength(1);
  });

  it("漏检进 missed，误检进 spurious，**且都不从分母里被剔除**", () => {
    // 2 个检出、3 个真值，只有 1 对命中
    const r = matchSegments([w(0, 100), w(500, 600)], [w(0, 100), w(1000, 1100), w(2000, 2100)]);
    expect(r.matched).toHaveLength(1);
    expect(r.spurious).toHaveLength(1);
    expect(r.missed).toHaveLength(2);
    // 分母是**全部**检出（2）与**全部**真值（3），不是剔完剩下的
    expect(r.precision).toBeCloseTo(1 / 2, 10);
    expect(r.recall).toBeCloseTo(1 / 3, 10);
  });

  it("两个检出抢一个真值时，只有一个命中，另一个算误检", () => {
    const r = matchSegments([w(0, 100), w(10, 110)], [w(0, 100)]);
    expect(r.matched).toHaveLength(1);
    expect(r.spurious).toHaveLength(1);
    expect(r.precision).toBeCloseTo(0.5, 10);
    expect(r.recall).toBe(1);
  });

  it("贪心按 IoU 从高到低配对，而不是按输入顺序", () => {
    // 真值 A=[0,100]；检出 x=[0,60]（IoU 0.6）、y=[0,100]（IoU 1.0）
    // 正确做法是 y 配 A。若按输入顺序，x 会先抢走 A。
    const r = matchSegments([w(0, 60), w(0, 100)], [w(0, 100)]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.detected).toEqual(w(0, 100));
  });

  it("结果与输入顺序无关（同一份数据必须给出同一份报告）", () => {
    const det = [w(0, 100), w(1000, 1100), w(2000, 2100)];
    const tru = [w(5, 105), w(1005, 1105)];
    const a = matchSegments(det, tru);
    // 这里的 reverse 是**构造测试输入**，不是对帧序列做离线平滑 ——
    // 红线 7 禁止的是"靠未来帧平滑"，与此无关。
    // eslint-disable-next-line no-restricted-syntax -- 见上：测试输入的排列，不是时序滤波
    const b = matchSegments([...det].reverse(), [...tru].reverse());
    expect(b.matched).toHaveLength(a.matched.length);
    expect(b.precision).toBe(a.precision);
    expect(b.recall).toBe(a.recall);
  });
});

describe("matchSegments · 缺数据时必须返回 null 而不是编一个数", () => {
  it("**真值为空 → precision 与 recall 都是 null**", () => {
    const r = matchSegments([w(0, 100)], []);
    expect(r.recall).toBeNull();
    // precision 也必须是 null：真值为空时**无从判断对错**，
    // 给 0 会被读成"检出的全是错的" —— 那是编造，不是测量
    expect(r.precision).toBeNull();
  });

  it("**检出为空 → precision 是 null，但 recall 是 0**", () => {
    const r = matchSegments([], [w(0, 100)]);
    expect(r.precision).toBeNull();
    // 这个 0 是真信息：真值里有，而一次都没检出
    expect(r.recall).toBe(0);
    expect(r.missed).toHaveLength(1);
  });

  it("两边都空 → 两个都是 null，而不是 NaN", () => {
    const r = matchSegments([], []);
    expect(r.precision).toBeNull();
    expect(r.recall).toBeNull();
    expect(Number.isNaN(r.precision as number)).toBe(false);
  });

  it("没有命中对时边界误差是 null，不是 0", () => {
    // 0 会被读成"边界完全对齐"，而实际是"一对都没配上"
    const r = matchSegments([w(0, 100)], [w(5000, 6000)]);
    expect(r.boundaryErrorMs.startMean).toBeNull();
    expect(r.boundaryErrorMs.endMedian).toBeNull();
  });
});

describe("matchSegments · 边界误差", () => {
  it("报带符号的误差，起点与终点分开", () => {
    // 检出 [1010,1480]，真值 [1000,1500] → 起点 +10，终点 −20
    const r = matchSegments([w(1010, 1480)], [w(1000, 1500)]);
    expect(r.boundaryErrorMs.startMean).toBe(10);
    expect(r.boundaryErrorMs.endMean).toBe(-20);
    expect(r.boundaryErrorMs.startMedian).toBe(10);
  });

  it("多个命中时中位数与均值都算", () => {
    const r = matchSegments(
      [w(10, 100), w(30, 200), w(60, 300)],
      [w(0, 100), w(0, 200), w(0, 300)],
    );
    expect(r.matched).toHaveLength(3);
    expect(r.boundaryErrorMs.startMean).toBeCloseTo((10 + 30 + 60) / 3, 10);
    expect(r.boundaryErrorMs.startMedian).toBe(30);
  });
});

describe("boundaryToleranceMs — 标注要标多准（给人工标注者的指引）", () => {
  it("容差 = 时长 × (1 − 门槛) / 2；门槛 0.5 时正好是时长的 1/4", () => {
    expect(boundaryToleranceMs(1900)).toBeCloseTo(475, 6);
    expect(boundaryToleranceMs(1900)).toBeCloseTo(1900 / 4, 6);
    expect(boundaryToleranceMs(600)).toBeCloseTo(150, 6);
  });

  it("**与 IoU 实现一致**：在容差处 IoU 正好压线，再多偏一点就掉出门槛", () => {
    const L = 1900;
    const d = boundaryToleranceMs(L);
    const truth = { startMs: 1000, endMs: 1000 + L };
    const atTolerance = { startMs: 1000 + d, endMs: 1000 + L - d };
    expect(temporalIoU(truth, atTolerance)).toBeCloseTo(IOU_MATCH_THRESHOLD, 6);

    const beyond = { startMs: 1000 + d + 1, endMs: 1000 + L - d - 1 };
    expect(temporalIoU(truth, beyond)).toBeLessThan(IOU_MATCH_THRESHOLD);
  });

  it("退化输入给 0，不产生负数或 NaN", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(boundaryToleranceMs(bad)).toBe(0);
    }
  });
});
