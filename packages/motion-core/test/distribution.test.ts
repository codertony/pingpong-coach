/**
 * 谷底判据的单测（F-022 的诊断工具）。
 *
 * 这个函数是个**启发式**，而启发式最危险的失败形态是"**给出一个看着像结论的数**"。
 * 第一版就那样翻过车：它在分布的**稀疏尾巴**上报了个"谷底"，
 * 于是对外打印出"可行区间 0.3 ~ 2.0" —— 而真实分布根本没有两团。
 * 根因是判据写成"找一个低于两侧的箱"，而 `0 * 3 <= 任何值` 恒成立。
 *
 * 所以这里重点钉**它应该说"看不出来"的那些情形**，而不是它算得准不准。
 */

import { describe, expect, it } from "vitest";
import {
  DISTRIBUTION_BIN,
  PEAK_MIN_SHARE,
  findDipBracket,
  histogram,
} from "../src/distribution.js";

/** 按 [取值, 出现次数] 造样本。 */
function samples(spec: Array<[number, number]>): number[] {
  const out: number[] = [];
  for (const [value, count] of spec) {
    for (let i = 0; i < count; i++) out.push(value);
  }
  return out;
}

describe("histogram", () => {
  it("按 0.1 分箱，且把最大值也放得进去", () => {
    const h = histogram([0.05, 0.15, 0.35, 1.02]);
    expect(h.bins[0]).toBe(1); // 0.0~0.1
    expect(h.bins[1]).toBe(1); // 0.1~0.2
    expect(h.bins[3]).toBe(1); // 0.3~0.4
    // 1.02 落在最后一箱，不能被 maxBin 截掉
    expect(h.bins.reduce((a, b) => a + b, 0)).toBe(4);
    expect(h.total).toBe(4);
  });

  it("空输入不崩", () => {
    const h = histogram([]);
    expect(h.total).toBe(0);
    expect(h.dipBin).toBeNull();
  });
});

describe("findDipBracket · 该找出谷底的情形", () => {
  it("清楚的两团（近处一团 + 远处一团）→ 找到中间的谷底", () => {
    // 0.2~0.5 一团，1.3~1.6 一团；中间 0.5~1.3 基本是空的（只有一个样本在 0.95）
    const v = samples([
      [0.25, 20],
      [0.35, 25],
      [0.45, 20],
      [0.95, 1],
      [1.35, 20],
      [1.45, 22],
      [1.55, 15],
    ]);
    const r = findDipBracket(v);
    expect(r.dipBin, "两团之间应当能找到谷底").not.toBeNull();
    // 断言"谷底落在那段空隙里"，而**不是**钉死某一箱 ——
    // 空隙里多箱都是 0，取哪一箱是并列问题，钉死会把一个并列细节固化成行为。
    // 空隙 = 下标 5（0.5）~ 12（1.2），两团分别在 4（0.4）与 13（1.3）。
    expect(r.dipBin).toBeGreaterThanOrEqual(5);
    expect(r.dipBin).toBeLessThanOrEqual(12);
    expect(r.dipShare).toBeLessThan(0.05);
  });
});

describe("findDipBracket · **应该说看不出来**的情形（这才是重点）", () => {
  it("单峰分布 → 不给谷底（第一版在这里翻过车）", () => {
    // 一个宽的单峰，尾部逐渐变稀 —— 没有任何"两团"
    const v = samples([
      [0.15, 15],
      [0.25, 33],
      [0.35, 38],
      [0.45, 10],
      [0.55, 12],
      [0.65, 17],
      [0.75, 11],
      [0.85, 8],
      [0.95, 4],
      [1.05, 2],
      [1.15, 5],
      [1.25, 7],
    ]);
    const r = findDipBracket(v);
    expect(r.dipBin, "单峰分布不该报出谷底 —— 那会把'分布变稀的尾巴'当成两团的分界").toBeNull();
  });

  it("**稀疏的尾巴不算一团**：只有两个样本的远处凸起不能当峰", () => {
    // 主峰在 0.3，远处 1.5 只有 2 个样本（占 3%，低于 PEAK_MIN_SHARE）
    const v = samples([
      [0.25, 30],
      [0.35, 40],
      [0.45, 20],
      [1.55, 2],
    ]);
    const r = findDipBracket(v);
    expect(r.dipBin, "远处那 2 个样本只是噪声，不足以构成'一团'").toBeNull();
  });

  it("只有一团、后面什么都没有 → 不给谷底", () => {
    const v = samples([
      [0.25, 30],
      [0.35, 40],
    ]);
    expect(findDipBracket(v).dipBin).toBeNull();
  });

  it("**真实素材的形态**：主峰 + 一条长肩，远处那个弱凸起够不上『一团』→ 不给谷底", () => {
    // 这支真实素材（225 帧可用）的分箱原样抄下来。它看起来"有两处高"，
    // 但 1.3~1.4 那处只占 17/225 = 7.6%，低于 PEAK_MIN_SHARE(10%)，
    // 整条 0.5~1.9 其实是**主峰右侧的长肩**，不是第二个团。
    // 这条用例把"真实数据正好落在门槛哪一侧"钉住：
    // 若有人把门槛调到 5% 以便"能出个数"，它会立刻红 —— 而那个数是编的。
    const v = samples([
      [0.05, 5],
      [0.15, 15],
      [0.25, 33],
      [0.35, 38],
      [0.45, 10],
      [0.55, 12],
      [0.65, 17],
      [0.75, 11],
      [0.85, 8],
      [0.95, 4],
      [1.05, 2],
      [1.15, 5],
      [1.25, 7],
      [1.35, 17],
      [1.45, 13],
      [1.55, 10],
      [1.65, 4],
      [1.75, 6],
      [1.85, 7],
      [2.15, 1],
    ]);
    expect(v.length).toBe(225);
    expect(17 / 225).toBeLessThan(PEAK_MIN_SHARE); // 前提：第二个凸起确实在门槛之下
    expect(findDipBracket(v).dipBin).toBeNull();
  });

  it("分箱宽度与导出一致（0.1）", () => {
    expect(DISTRIBUTION_BIN).toBe(0.1);
  });
});
