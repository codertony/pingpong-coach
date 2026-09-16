#!/usr/bin/env tsx
/**
 * 标注需要的**边界精度**是多少？（给人工标注者的操作指引）
 *
 * ## 回答什么问题
 *
 * `docs/acceptance.md` 的验收判据是"temporal IoU ≥ 0.5 计命中"。
 * 那么人工标注的边界**差多少毫秒**才会把一次真正的挥拍判成"没命中"？
 * 这个数是纯数学（IoU 定义 + 区间长度），**不涉及任何识别质量**，
 * 所以机器可以算，而且必须算清楚 —— 否则标注者不知道要标多准。
 *
 * ## 它不是什么
 *
 * - **不是准确率**。这里没有真值，只有"误差多大就不再算命中"这个几何关系。
 * - **不改变任何阈值**。IoU 门槛 0.5 来自验收定义，这里只是把它翻译成毫秒。
 *
 * 用法：
 *   pnpm annotate:tolerance                      # 用默认时长集合
 *   pnpm annotate:tolerance --durations 1900,2200
 */
import { boundaryToleranceMs, IOU_MATCH_THRESHOLD, temporalIoU } from "@pingpong/motion-core";

const DEFAULT_DURATIONS_MS = [600, 1200, 1900, 2200];

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[a.slice(2)] = next;
        i++;
      } else out[a.slice(2)] = "";
    }
  }
  return out;
}

/** 只偏一端（起点不动，终点偏 d）。 */
function iouAfterOneSidedShift(durationMs: number, dMs: number): number {
  return temporalIoU(
    { startMs: 1000, endMs: 1000 + durationMs },
    { startMs: 1000, endMs: 1000 + durationMs + dMs },
  );
}

/** 二分找出「再差一点就不算命中」的那个毫秒数（用于单边那一列）。 */
function toleranceMs(durationMs: number, fn: (d: number) => number): number {
  let lo = 0;
  let hi = durationMs; // 超过时长就没有交集了
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fn(mid) >= IOU_MATCH_THRESHOLD) lo = mid;
    else hi = mid;
  }
  return lo;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const durations = (args.durations ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const list = durations.length > 0 ? durations : DEFAULT_DURATIONS_MS;

  console.log("标注边界差多少毫秒，IoU 才会掉到 0.5 以下？（门槛来自 docs/acceptance.md）\n");
  console.log("本组时长ms   两端同时偏(最严)   只偏一端(最宽)");
  for (const d of list) {
    // 用 motion-core 的公式（有单测），不在这里再实现一遍
    const sym = boundaryToleranceMs(d);
    const one = toleranceMs(d, (x) => iouAfterOneSidedShift(d, x));
    console.log(
      `${String(d).padStart(10)}   ${(sym.toFixed(0) + " ms").padStart(16)}   ${(one.toFixed(0) + " ms").padStart(13)}`,
    );
  }

  console.log(
    "\n怎么用：**按最严那一列标**。两端各差一点是最常见的误差形态，\n" +
      "只偏一端是最宽的边界 —— 拿最宽的那个当目标，实际标注会经常掉出门槛。\n" +
      "\n⚠️ 这是**几何关系**，不是识别质量：它只告诉你「标到多准才算命中」，\n" +
      "不告诉你识别对不对（那要真实标注出来才知道）。",
  );
}

main();
