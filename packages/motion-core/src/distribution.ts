/**
 * 从"某个量的分布"里框出阈值的**可行区间**。
 *
 * 用在准备区半径上（F-022）：准备区要**装得下"手停着等球"那一团**，
 * 又要**装不下"挥拍摆幅"那一团** —— 两团之间的谷底就是数据给出的分界。
 *
 * 为什么放在 motion-core 而不是写在 `scripts/threshold-diagnostic.ts` 里：
 * **它是个启发式，而启发式最容易悄悄给出错答案**，必须有单测钉住它的失败形态。
 * 脚本目录没有测试运行器；这个包有。
 * （第一版就翻过车：见 `findDipBracket` 的注释。）
 */

/** 直方图分箱宽度（体尺度/距离的无量纲倍数）。 */
export const DISTRIBUTION_BIN = 0.1;

/** 一个"峰"至少占全部样本的比例。低于它的只算噪声/尾巴，不算"一团"。 */
export const PEAK_MIN_SHARE = 0.1;

export interface Distribution {
  /** 每个分箱的样本数，下标 = 取值 / DISTRIBUTION_BIN 向下取整 */
  bins: number[];
  total: number;
  /** 谷底所在的分箱下标；找不到显著谷底时为 null */
  dipBin: number | null;
  /** 谷底箱占全部样本的比例。越小说明谷底越干净 */
  dipShare: number;
}

/** 把一组取值分箱。 */
export function histogram(values: readonly number[]): Distribution {
  const maxBin = values.length === 0 ? 0 : Math.floor(Math.max(...values) / DISTRIBUTION_BIN);
  const bins = new Array<number>(maxBin + 1).fill(0);
  for (const x of values) {
    const i = Math.min(maxBin, Math.max(0, Math.floor(x / DISTRIBUTION_BIN)));
    bins[i] = (bins[i] ?? 0) + 1;
  }
  return { bins, total: values.length, dipBin: null, dipShare: Number.NaN };
}

/**
 * 找**两团之间的谷底**。
 *
 * 判据是：**先找两个足够大的峰，再取它们之间的最低点** ——
 * 而不是"找一个低于两侧的箱"。
 *
 * ⚠️ 第一版就是后者，实测被自己坑了一次：它在 **1.9~2.0（0 个样本）** 处
 * 报了个"谷底"，于是对外打印"可行区间 0.3 ~ 2.0" ——
 * 那只是分布**变稀的尾巴**，不是两个团之间的分界。
 * 根因：`0 * 3 <= 任何值` 恒成立，所以"只看低不低"的判据**在尾巴上永远为真**。
 * 这个形态留在注释里，因为它不是笔误，是判据选错了。
 *
 * 现在的判据：
 * 1. 找所有局部极大箱；
 * 2. 每个峰至少占全部样本的 {@link PEAK_MIN_SHARE}，否则不算"一团"；
 * 3. 在相邻的两个合格峰之间取最低箱；
 * 4. 该箱还必须低于较小那个峰的三分之一。
 *
 * 不满足就返回 `dipBin: null` —— **宁可说"这两团之间没有清晰分界"，
 * 也不要给一个看着像结论的数**。
 */
export function findDipBracket(values: readonly number[]): Distribution {
  const base = histogram(values);
  const { bins, total } = base;
  if (total === 0) return base;

  let dipBin: number | null = null;
  let dipShare = Number.NaN;

  const peaks: number[] = [];
  for (let i = 1; i < bins.length - 1; i++) {
    const here = bins[i] ?? 0;
    if (here > (bins[i - 1] ?? 0) && here >= (bins[i + 1] ?? 0)) peaks.push(i);
  }
  const substantial = peaks.filter((i) => (bins[i] ?? 0) / total >= PEAK_MIN_SHARE);

  for (let k = 0; k + 1 < substantial.length; k++) {
    const lo = substantial[k]!;
    const hi = substantial[k + 1]!;
    let lowest = lo + 1;
    for (let i = lo + 1; i < hi; i++) {
      if ((bins[i] ?? 0) < (bins[lowest] ?? 0)) lowest = i;
    }
    const dipCount = bins[lowest] ?? 0;
    const smallerPeak = Math.min(bins[lo] ?? 0, bins[hi] ?? 0);
    if (dipCount * 3 <= smallerPeak) {
      if (dipBin == null || dipCount < (bins[dipBin] ?? 0)) {
        dipBin = lowest;
        dipShare = dipCount / total;
      }
    }
  }

  return { bins, total, dipBin, dipShare };
}
