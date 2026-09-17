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
  contactSheetStepMs,
  eventTimeErrors,
  validateStrokeWindows,
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

/**
 * 事件定位评估（R4 的配套口径）。
 *
 * 分段评估问「这一板有没有被找到」，事件评估问「这一板的**过程**有没有被找对」。
 * 两者独立：一板可以被完整找到而阶段时刻全错。所以这里针对每一处
 * "容易被做手脚"的地方各钉一条 —— 与上面分段的做法一致。
 */
describe("eventTimeErrors — 逐类事件的时刻误差", () => {
  const ev = (eventType: string, timeMs: number) => ({ eventType, timeMs });

  it("完全对齐：0 误差，全部配对，无漏检无误检", () => {
    const truth = [ev("forward_start", 1000), ev("stroke_closed", 1500)];
    const rows = eventTimeErrors(truth, truth, 50);

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.matched).toBe(1);
      expect(r.missed).toBe(0);
      expect(r.spurious).toBe(0);
      expect(r.absP50Ms).toBe(0);
      expect(r.signedMeanMs).toBe(0);
    }
  });

  it("容差内配对，并报**带符号**的误差（早/晚要能区分）", () => {
    const truth = [ev("forward_start", 1000), ev("return_start", 2000)];
    const detected = [ev("forward_start", 1030), ev("return_start", 1980)];
    const rows = eventTimeErrors(detected, truth, 50);

    const fwd = rows.find((r) => r.eventType === "forward_start")!;
    const ret = rows.find((r) => r.eventType === "return_start")!;
    expect(fwd.signedMeanMs).toBe(30); // 检出比真值晚 30ms
    expect(ret.signedMeanMs).toBe(-20); // 早 20ms
    // 只报绝对值就分不出"系统性偏晚"和"随机抖动"——这正是要看的东西
    expect(ret.absP50Ms).toBe(20);
  });

  it("超出容差**不配对**：进 missed 与 spurious，统计给 null 而不是 0", () => {
    const truth = [ev("forward_start", 1000)];
    const detected = [ev("forward_start", 1200)];
    const [row] = eventTimeErrors(detected, truth, 50);

    expect(row!.matched).toBe(0);
    expect(row!.missed).toBe(1);
    expect(row!.spurious).toBe(1);
    // 一对都没配上，"误差 0"是编的 —— 必须是 null
    expect(row!.absP50Ms).toBeNull();
    expect(row!.absP95Ms).toBeNull();
    expect(row!.signedMeanMs).toBeNull();
  });

  it("**该类没有真值就不给数字**（与 precision 同一条纪律）", () => {
    const truth: Array<{ eventType: string; timeMs: number }> = [];
    const detected = [ev("forward_start", 1000), ev("forward_start", 1400)];
    const [row] = eventTimeErrors(detected, truth, 50);

    expect(row!.matched).toBe(0);
    expect(row!.missed).toBe(0);
    expect(row!.spurious, "分母不筛：没真值也要如实报出误检条数").toBe(2);
    expect(row!.absP50Ms, "没标注 ≠ 完全对齐").toBeNull();
  });

  it("真值有、检出为空：全算漏检，容差统计仍为 null", () => {
    const truth = [ev("backswing_start", 100), ev("forward_start", 300)];
    const rows = eventTimeErrors([], truth, 50);

    expect(rows.find((r) => r.eventType === "backswing_start")!.missed).toBe(1);
    expect(rows.find((r) => r.eventType === "forward_start")!.missed).toBe(1);
    for (const r of rows) expect(r.absP95Ms).toBeNull();
  });

  it("贪心按**最近**配对，而不是按输入顺序", () => {
    const truth = [ev("forward_start", 1000)];
    // 990 差 10，1050 差 50 —— 应当配 990，1050 算误检
    const detected = [ev("forward_start", 1050), ev("forward_start", 990)];
    const [row] = eventTimeErrors(detected, truth, 100);

    expect(row!.matched).toBe(1);
    expect(row!.signedMeanMs).toBe(-10);
    expect(row!.spurious).toBe(1);
  });

  it("**同类事件可重复**（拉锯会产生两次引拍）并一一配对", () => {
    const truth = [ev("backswing_start", 1000), ev("backswing_start", 2000)];
    const detected = [ev("backswing_start", 1010), ev("backswing_start", 2020)];
    const [row] = eventTimeErrors(detected, truth, 50);

    expect(row!.matched).toBe(2);
    expect(row!.missed).toBe(0);
    expect(row!.spurious).toBe(0);
    expect(row!.signedMeanMs).toBe(15);
  });

  it("P50 与 P95 在已知集合上取对", () => {
    // 绝对误差 10/20/30/40/50
    const truth = [1000, 2000, 3000, 4000, 5000].map((t) => ev("forward_start", t));
    const detected = [1010, 2020, 3030, 4040, 5050].map((t) => ev("forward_start", t));
    const [row] = eventTimeErrors(detected, truth, 100);

    expect(row!.absP50Ms).toBe(30);
    expect(row!.absP95Ms, "P95 取最近秩，5 条时就是最大值").toBe(50);
  });

  it("**容差写错时不静默乱配**：NaN / 负数按 0 处理，只认时刻完全相同的一对", () => {
    // 第一版这条写错了：我断言"不该配对"，但精确相等的一对本来就不是"乱配"。
    // 真正要守住的是**非零差**不能被放过 —— 那才是"容差失效"的后果。
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const [loose] = eventTimeErrors(
        [ev("forward_start", 1010)],
        [ev("forward_start", 1000)],
        bad,
      );
      expect(loose!.matched, `容差 ${String(bad)} 时不该放过 10ms 的差`).toBe(0);
      expect(loose!.missed).toBe(1);
      expect(loose!.spurious).toBe(1);

      const [exact] = eventTimeErrors(
        [ev("forward_start", 1000)],
        [ev("forward_start", 1000)],
        bad,
      );
      expect(exact!.matched, "时刻完全相同的一对仍然应当配上").toBe(1);
      expect(exact!.absP50Ms).toBe(0);
    }
  });

  it("结果与输入顺序无关（同一份数据必须给出同一份报告）", () => {
    const truth = [ev("forward_start", 1000), ev("return_start", 1500)];
    const detected = [ev("return_start", 1510), ev("forward_start", 990)];
    const a = eventTimeErrors(detected, truth, 50);
    // 这里的 reverse 是**构造测试输入**，不是对帧序列做离线平滑 ——
    // 红线 7 禁止的是"靠未来帧平滑"，与此无关。（与上面 matchSegments 的同类用例一致。）
    // eslint-disable-next-line no-restricted-syntax -- 见上：测试输入的排列，不是时序滤波
    const b = eventTimeErrors([...detected].reverse(), [...truth].reverse(), 50);

    expect(b.map((r) => r.eventType)).toEqual(a.map((r) => r.eventType));
    expect(b.map((r) => r.signedMeanMs)).toEqual(a.map((r) => r.signedMeanMs));
  });
});

/**
 * 标注用的格子宽度（F-043）。
 *
 * 这个推导原先写在导出脚本里，而脚本的自检**只打印不 assert** ——
 * 于是有人把它改回写死的 250 时，`pnpm verify` **全绿**，只有一行警告变了。
 * 后果不是"多一条警告"：默认导出的联系表会**粗于它自己声明的判据**，
 * 标注者照着标就会系统性低报识别质量，而那正是 B4 唯一剩下的关键路径。
 */
describe("contactSheetStepMs —— 格子宽度必须由判据推出来", () => {
  it("**默认格子必然细于容差**（写死 250 会让这条红）", () => {
    for (const expected of [600, 800, 1000, 1500, 2200]) {
      const step = contactSheetStepMs(expected);
      expect(
        step,
        `${expected}ms 单板：格子 ${step}ms 粗于容差 ±${boundaryToleranceMs(expected)}ms`,
      ).toBeLessThanOrEqual(boundaryToleranceMs(expected));
    }
  });

  it("取容差的**一半**，且是整数毫秒（相邻两格必然跨住真实边界）", () => {
    // 800ms 单板、IoU 0.5 ⇒ 容差 ±200ms ⇒ 格子 100ms
    expect(contactSheetStepMs(800)).toBe(100);
    expect(Number.isInteger(contactSheetStepMs(800))).toBe(true);
  });

  it("上下界是**可读性**约束：再粗不超 250、再细不低 50", () => {
    expect(contactSheetStepMs(100_000)).toBe(250);
    expect(contactSheetStepMs(10)).toBe(50);
  });

  it("非法输入落到下限，而不是 NaN / 负数", () => {
    expect(contactSheetStepMs(Number.NaN)).toBe(50);
    expect(contactSheetStepMs(0)).toBe(50);
    expect(contactSheetStepMs(-800)).toBe(50);
  });
});

/**
 * 人工标注的机械合法性（标注协议 §10 第 3 条）。
 *
 * 这些规则此前只写在协议里**给人看**，没有任何东西执行 —— 而违反它们的后果是
 * **静默产出无意义的数字**：标反 → IoU 恒为 0（报告读起来像"算法全错"）；
 * 重叠 → 匹配阶段一次命中被两板抢走；越界 → 永远配不上，同样读成"漏检"。
 * 也就是说，**标注者的一处笔误会被记到算法头上**，而协议第 4 条明确要求
 * "记作标注错误，不是记作算法漏检"。
 */
describe("validateStrokeWindows —— 标注的机械合法性", () => {
  it("合法的标注没有问题", () => {
    expect(
      validateStrokeWindows(
        [
          { startMs: 1000, endMs: 1800 },
          { startMs: 2000, endMs: 2900 },
        ],
        8,
      ),
    ).toEqual([]);
  });

  it("**标反了**要报（否则 IoU 恒为 0，看起来像算法全错）", () => {
    const p = validateStrokeWindows([{ startMs: 2000, endMs: 1200 }], 8);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("起点 2000 ≥ 终点 1200");
  });

  it("**两板重叠**要报（否则一次命中会被两板抢）", () => {
    const p = validateStrokeWindows(
      [
        { startMs: 1000, endMs: 2000 },
        { startMs: 1900, endMs: 2600 },
      ],
      8,
    );
    expect(p.some((x) => x.includes("重叠"))).toBe(true);
  });

  it("**超出素材时长**要报（越界的真值永远配不上，会被读成漏检）", () => {
    const p = validateStrokeWindows([{ startMs: 7000, endMs: 9000 }], 8);
    expect(p.some((x) => x.includes("超出素材时长"))).toBe(true);
  });

  it("起点为负要报", () => {
    const p = validateStrokeWindows([{ startMs: -100, endMs: 500 }], 8);
    expect(p.some((x) => x.includes("为负"))).toBe(true);
  });

  it("**拿不到素材时长时不查越界**（不因为不知道就报错）", () => {
    expect(validateStrokeWindows([{ startMs: 7000, endMs: 9000 }], null)).toEqual([]);
  });

  it("相邻不重叠的板不算重叠（首尾相接是合法的）", () => {
    expect(
      validateStrokeWindows(
        [
          { startMs: 1000, endMs: 2000 },
          { startMs: 2000, endMs: 2600 },
        ],
        8,
      ),
    ).toEqual([]);
  });
});
