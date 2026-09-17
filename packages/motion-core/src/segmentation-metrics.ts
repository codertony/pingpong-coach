/**
 * 分段评估的匹配与指标计算（纯函数）。
 *
 * 为什么放在 motion-core 而不是写在 `scripts/eval-replay.mjs` 里：
 * 这是**唯一**会把"识别准不准"变成数字的一段代码，它自己必须被测住。
 * 放在纯计算包里才能直接跑单测；写在脚本里就只能靠人工验算。
 *
 * 口径纪律（对应 `docs/acceptance.md` 的两条"容易作弊的口径"）：
 *
 * 1. **分母不筛**。precision 的分母是**全部**检出，recall 的分母是**全部**真值，
 *    包括那些算法"拒绝判断"或"看起来不合理"的。不允许靠多拒绝来抬高指标。
 * 2. **没有真值就不给数字**。真值为空时 recall 返回 `null` 而不是 `0` 或 `1` ——
 *    "没标注"与"标了但一个都没命中"是两件完全不同的事，混在一起会误导决策。
 */

export interface TimeWindow {
  startMs: number;
  endMs: number;
}

/** 判定"命中"的 temporal IoU 门槛。取 0.5 是 `docs/acceptance.md` 里的验收定义。 */
export const IOU_MATCH_THRESHOLD = 0.5;

/** 区间并集时长。退化区间（end < start）按 0 处理，不产生负长度。 */
function spanMs(w: TimeWindow): number {
  const len = w.endMs - w.startMs;
  return len > 0 ? len : 0;
}

/** 交叠时长。 */
function overlapMs(a: TimeWindow, b: TimeWindow): number {
  const lo = Math.max(a.startMs, b.startMs);
  const hi = Math.min(a.endMs, b.endMs);
  const len = hi - lo;
  return len > 0 ? len : 0;
}

/**
 * 两个时间区间的 temporal IoU。
 *
 * 定义与 `docs/acceptance.md` 一致：交叠时长 ÷ 并集时长。
 * 并集为 0（两侧都是零长度区间）时返回 0 —— 不返回 NaN，
 * 因为零长度的"挥拍"不是命中，而 NaN 会污染下游的求平均。
 */
/**
 * 人工标注的**边界容差**：两端各偏多少毫秒，IoU 仍 ≥ 门槛。
 *
 * ## 推导（不是拟合）
 *
 * 设挥拍时长 L，两端各向内偏 d（最常见的标注误差形态）：交集 = L − 2d，
 * 并集仍为 L（标注区间被真值包含），于是
 *
 *     IoU = (L − 2d) / L ≥ 门槛   ⟺   d ≤ L · (1 − 门槛) / 2
 *
 * 门槛 0.5 时就是 **L / 4** —— 即「两端各标在时长的 1/4 以内就算命中」。
 *
 * ## 为什么要有它
 *
 * 验收定义只说了"temporal IoU ≥ 0.5 计命中"，但没告诉标注者**要标多准**。
 * 这个函数把门槛翻译成毫秒，让标注任务从"尽量准"变成"1.9 秒的球标在 ±475ms 内"。
 *
 * ⚠️ 它只描述**几何关系**，与识别质量无关；也不改变任何阈值。
 * 另外：只偏**一端**时容差大得多（IoU ≥ 0.5 在单边近似要求 d ≤ L，即几乎无约束），
 * 所以人工指引应当按**两端同时偏**这个更严的情形给。
 */
export function boundaryToleranceMs(
  durationMs: number,
  threshold: number = IOU_MATCH_THRESHOLD,
): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return (durationMs * (1 - threshold)) / 2;
}

/**
 * 人工标注用的**联系表格子宽度**（毫秒）—— 由验收判据推出来，不是一个魔数。
 *
 * 判据是 IoU ≥ 0.5 ⇒ 两端各偏不超过单板时长的 25%（`boundaryToleranceMs`）。
 * 格子取**容差的一半**：这样相邻两格必然跨住真实边界，标注者照着格子读锚点，
 * 最坏也就差半格。
 *
 * 上下界是**可读性**约束，不是判据：再粗就标不准（250ms），再细会把表撑到没边（50ms）。
 * 输出与内层结果都取整到毫秒，避免出现 `83.333333` 这种格子宽度。
 *
 * ## 为什么要做成函数而不是在导出脚本里写一行
 *
 * 它此前就是导出脚本里的一行常量推导，而那个脚本**只打印**自检结论、不 assert ——
 * 于是有人把它改回写死的 250 时，测试**全绿**，只有一行警告变了（F-043 的回归）。
 * 移到这里，`segmentation-metrics.test.ts` 就能钉住"默认格子必然细于容差"这条关系。
 */
export function contactSheetStepMs(
  expectedStrokeMs: number,
  threshold: number = IOU_MATCH_THRESHOLD,
): number {
  const half = Math.floor(boundaryToleranceMs(expectedStrokeMs, threshold) / 2);
  return Math.min(250, Math.max(50, half));
}

export function temporalIoU(a: TimeWindow, b: TimeWindow): number {
  const inter = overlapMs(a, b);
  const union = spanMs(a) + spanMs(b) - inter;
  if (union <= 0) return 0;
  return inter / union;
}

export interface MatchedPair {
  truth: TimeWindow;
  detected: TimeWindow;
  iou: number;
}

export interface MatchResult {
  matched: MatchedPair[];
  /** 真值里没被命中的（漏检） */
  missed: TimeWindow[];
  /** 检出里没对上真值的（误检） */
  spurious: TimeWindow[];
  /**
   * 命中数 ÷ 检出总数。
   *
   * **任一侧为空都返回 `null`**，而不是 0：
   * 真值为空时根本**无从判断对错**，返回 0 会被读成"检出的全是错的"；
   * 检出为空时是 0÷0，同样无从谈起。
   * 这与红线 1 同一条纪律 —— 缺失就是缺失，不要拿 0 冒充一个测量值。
   */
  precision: number | null;
  /**
   * 命中数 ÷ 真值总数。
   *
   * **真值为空 → `null`**（没标注，不是"全漏了"）。
   * **检出为空而真值非空 → 0**：那是实打实的全漏，是真信息。
   */
  recall: number | null;
  /** 命中对的边界误差（毫秒），起点与终点分开报 */
  boundaryErrorMs: {
    startMean: number | null;
    startMedian: number | null;
    endMean: number | null;
    endMedian: number | null;
  };
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * 把检出的挥拍与人工标注的真值配对。
 *
 * 匹配策略：按 IoU 从高到低**贪心**配对，每侧每个区间最多用一次。
 * 选贪心而不是"最近起点"之类：贪心直接优化被报告的那个量（IoU），
 * 且结果确定（不依赖输入顺序，因为排序里带了次序键）。
 *
 * **刻意不做的事**：不因为"某个检出明显是噪声"就把它从分母里拿掉。
 * 剔除是评估者最容易自欺的一步；要剔除必须在报告里另立一行并写明规则。
 */
export function matchSegments(
  detected: readonly TimeWindow[],
  truth: readonly TimeWindow[],
  threshold: number = IOU_MATCH_THRESHOLD,
): MatchResult {
  const candidates: Array<{ di: number; ti: number; iou: number }> = [];
  for (let di = 0; di < detected.length; di++) {
    for (let ti = 0; ti < truth.length; ti++) {
      const iou = temporalIoU(detected[di]!, truth[ti]!);
      if (iou >= threshold) candidates.push({ di, ti, iou });
    }
  }
  // 次序键带上 di/ti：IoU 相同时结果也必须确定，否则同一份数据两次跑出不同报告
  candidates.sort((a, b) => b.iou - a.iou || a.di - b.di || a.ti - b.ti);

  const usedDetected = new Set<number>();
  const usedTruth = new Set<number>();
  const matched: MatchedPair[] = [];
  for (const c of candidates) {
    if (usedDetected.has(c.di) || usedTruth.has(c.ti)) continue;
    usedDetected.add(c.di);
    usedTruth.add(c.ti);
    matched.push({ detected: detected[c.di]!, truth: truth[c.ti]!, iou: c.iou });
  }

  const missed = truth.filter((_, ti) => !usedTruth.has(ti));
  const spurious = detected.filter((_, di) => !usedDetected.has(di));

  const startErrors = matched.map((m) => m.detected.startMs - m.truth.startMs);
  const endErrors = matched.map((m) => m.detected.endMs - m.truth.endMs);

  return {
    matched,
    missed,
    spurious,
    // 任一侧为空 → precision 无从谈起，给 null 而不是 0（见接口上的说明）
    precision:
      truth.length === 0 || detected.length === 0 ? null : matched.length / detected.length,
    // 真值为空 → 没标注（null）；检出为空但真值非空 → 全漏，那是 0
    recall: truth.length === 0 ? null : matched.length / truth.length,
    boundaryErrorMs: {
      startMean: mean(startErrors),
      startMedian: median(startErrors),
      endMean: mean(endErrors),
      endMedian: median(endErrors),
    },
  };
}

/** 一个带时刻的事件。只要 (类型, 时刻)，故意不依赖完整的事件契约 —— 标注侧也能直接用。 */
export interface TimedEvent {
  eventType: string;
  timeMs: number;
}

/** 逐类事件的定位质量。 */
export interface EventTimeErrorRow {
  eventType: string;
  /** 配对成功的事件数（每侧每条最多用一次） */
  matched: number;
  /** 真值里有、检出里没有 */
  missed: number;
  /** 检出里有、真值里没有 */
  spurious: number;
  /**
   * **配对事件的原始带符号误差**（检出 − 真值，毫秒）。
   *
   * 保留原始值是为了让调用方能**跨样本合并**：合并分位数必须建立在合并后的
   * 误差上，而不是"各样本分位数再取平均"（那与"样本量与挥拍数无关地等权"是同一个错误）。
   */
  signedErrorsMs: number[];
  /** 带符号误差（检出 − 真值）的均值/中位数，**仅配对事件**；无配对时为 null */
  signedMeanMs: number | null;
  signedMedianMs: number | null;
  /** 绝对误差的 P50 / P95，**仅配对事件**；无配对时为 null */
  absP50Ms: number | null;
  absP95Ms: number | null;
}

/**
 * 事件定位评估：逐类事件的时刻误差。
 *
 * ## 为什么与 `matchSegments` 分开
 *
 * 分段评估问的是「这一板有没有被找到」（区间重叠，IoU）；事件评估问的是
 * 「这一板的**过程**有没有被找对」（引拍/前挥/还原各在什么时候）。
 * 两者是**独立**的性质：一板可以被完整找到而阶段时刻全错，反过来也一样。
 * 合成一个分数只会让它们互相掩盖。
 *
 * ## 口径纪律（与 `matchSegments` 同源）
 *
 * 1. **分母不筛**：每类事件的 `matched + missed` 等于真值条数，
 *    `matched + spurious` 等于检出条数。不允许因为「这条看着像噪声」就把它
 *    从分母里拿掉 —— 那是评估者最容易自欺的一步。
 * 2. **该类没有真值就不给数字**：误差统计给 `null` 而不是 `0`。
 *    「没标注」与「标了且完全对齐」是两件完全不同的事。
 * 3. **容差由调用方给，且必须能被追责**。多久算「同一件事」取决于帧率与事件
 *    定义本身（评审 §10 的探索目标是「≤2 个源帧」：60fps 下 33ms、30fps 下 67ms）。
 *    所以这里**不给默认值** —— 有默认值，"容差是多少"这件事就会从报告里消失。
 */
export function eventTimeErrors(
  detected: readonly TimedEvent[],
  truth: readonly TimedEvent[],
  toleranceMs: number,
): EventTimeErrorRow[] {
  // 容差写错（NaN / 负数）时按 0 处理：宁可一条都配不上，也不能静默地"随便配"
  const tol = Number.isFinite(toleranceMs) && toleranceMs > 0 ? toleranceMs : 0;

  const types = [...new Set([...truth, ...detected].map((e) => e.eventType))].sort();

  return types.map((eventType) => {
    const t = truth.filter((e) => e.eventType === eventType);
    const d = detected.filter((e) => e.eventType === eventType);

    // 贪心：按绝对时间差从小到大配对，每侧每条最多用一次。
    // 次序键带上 di/ti，这样差相同时结果也是确定的（同一份数据两次跑出同一份报告）。
    const candidates: Array<{ di: number; ti: number; delta: number }> = [];
    for (let di = 0; di < d.length; di++) {
      for (let ti = 0; ti < t.length; ti++) {
        const delta = Math.abs(d[di]!.timeMs - t[ti]!.timeMs);
        if (delta <= tol) candidates.push({ di, ti, delta });
      }
    }
    candidates.sort((a, b) => a.delta - b.delta || a.di - b.di || a.ti - b.ti);

    const usedDetected = new Set<number>();
    const usedTruth = new Set<number>();
    const signed: number[] = [];
    for (const c of candidates) {
      if (usedDetected.has(c.di) || usedTruth.has(c.ti)) continue;
      usedDetected.add(c.di);
      usedTruth.add(c.ti);
      signed.push(d[c.di]!.timeMs - t[c.ti]!.timeMs);
    }

    const abs = signed.map((v) => Math.abs(v)).sort((a, b) => a - b);

    return {
      eventType,
      matched: signed.length,
      missed: t.length - usedTruth.size,
      spurious: d.length - usedDetected.size,
      signedErrorsMs: signed,
      signedMeanMs: mean(signed),
      signedMedianMs: median(signed),
      absP50Ms: median(abs),
      absP95Ms: percentileOfSorted(abs, 0.95),
    };
  });
}

export { percentileOfSorted as eventPercentileOfSorted };

/** 在**已排序**的数组上取分位（最近秩法）。空数组给 null，不给 0。 */
function percentileOfSorted(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * 人工标注的**机械合法性**（标注协议 §10 第 3 条）。
 *
 * ## 为什么必须有
 *
 * 在此之前这些规则只写在协议里**给人看**，没有任何东西执行。而违反它们的后果是
 * **静默产出无意义的数字**，不是报错：
 * - `startMs >= endMs`（标反了）→ IoU 恒为 0，报告读起来就是"算法全错"；
 * - 两板重叠 → 匹配阶段按 IoU 贪心配对，一板可能把另一板的命中抢走；
 * - 越界（超出素材时长）→ 永远配不上，同样读成"漏检"。
 *
 * 也就是说：**标注者的一处笔误会被记到算法头上**。协议 §10 第 4 条明确要求
 * "记作**标注错误**，不是记作算法漏检" —— 这里就是那条要求落地的地方。
 *
 * ## 处置：这一样本**不计入指标**，并大声说明
 *
 * 不是"修复后再算"（脚本无从知道应该改成什么），也不是"照样算"（那正是要避免的）。
 * 与"缺真值就不给数字"同一条纪律：**宁可不给，不给一个假的**。
 */
export function validateStrokeWindows(
  windows: readonly TimeWindow[],
  durationSec: number | null,
): string[] {
  const problems: string[] = [];
  for (const [i, w] of windows.entries()) {
    if (w.startMs >= w.endMs) {
      problems.push(`第 ${i + 1} 板起点 ${w.startMs} ≥ 终点 ${w.endMs}（标反了？IoU 会恒为 0）`);
    }
    if (w.startMs < 0) problems.push(`第 ${i + 1} 板起点为负（${w.startMs}）`);
    if (durationSec != null && w.endMs > durationSec * 1000 + 1) {
      problems.push(
        `第 ${i + 1} 板终点 ${w.endMs}ms 超出素材时长 ${Math.round(durationSec * 1000)}ms`,
      );
    }
  }
  // 重叠：按起点排序后，前一板的终点不该越过下一板的起点
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.startMs < prev.endMs) {
      problems.push(
        `第 ${i} 板（${prev.startMs}–${prev.endMs}）与第 ${i + 1} 板（${cur.startMs}–${cur.endMs}）重叠`,
      );
    }
  }
  return problems;
}
