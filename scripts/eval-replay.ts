#!/usr/bin/env tsx
/**
 * 回放评估入口。
 *
 * 用途：对真实片段重放，输出**分段**指标（temporal IoU / precision / recall / 边界误差）。
 *
 * 为什么是 `.ts` 而不是 `.mjs`：指标计算住在 `packages/motion-core`
 * （`segmentation-metrics.ts`，纯函数、有 18 项单测）。那个包的入口是 TS 源码，
 * 用 `node` 直接跑不了；而**把匹配逻辑在这里再抄一份是最坏的做法** ——
 * 抄出来的那份没有测试，而且会与被测的那份漂移。所以改用 `tsx` 运行。
 *
 * 两条口径纪律（与 `docs/acceptance.md` 一致，且由 motion-core 的单测守着）：
 *   1. **分母不筛**：precision 的分母是全部检出，recall 的分母是全部真值。
 *      不因为"某个检出明显是噪声"就把它剔掉 —— 剔分母是评估者最容易自欺的一步。
 *   2. **没有真值就不给数字**：缺标注的样本明确跳过并计入"未计入"，
 *      不产生任何指标，也不混进分母。
 *
 * 用法：
 *   pnpm eval:replay --manifest evaluation/samples.json
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { matchSegments, type TimeWindow } from "@pingpong/motion-core";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

interface RawStroke {
  startMs?: unknown;
  endMs?: unknown;
}
interface Sample {
  id?: unknown;
  label?: unknown;
  racketSideVisibility?: unknown;
  /** 人工标注的真值挥拍窗口 */
  annotation?: { strokes?: RawStroke[] };
  /** 由 `e2e/segmentation-eval.e2e.ts` 导出的观测结果（含 detectedStrokes） */
  observedFile?: unknown;
}
interface Manifest {
  samples?: Sample[];
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

/** 把 {startMs,endMs} 形状的数组转成窗口，顺带过滤掉字段缺失/非数的条目并计数。 */
function toWindows(raw: RawStroke[] | undefined): { windows: TimeWindow[]; dropped: number } {
  const windows: TimeWindow[] = [];
  let dropped = 0;
  for (const s of raw ?? []) {
    if (typeof s?.startMs === "number" && typeof s?.endMs === "number") {
      windows.push({ startMs: s.startMs, endMs: s.endMs });
    } else {
      dropped++;
    }
  }
  return { windows, dropped };
}

function fmt(x: number | null, digits = 3): string {
  return x == null ? "—（无数据）" : x.toFixed(digits);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifestArg = args.manifest;

  if (!manifestArg || manifestArg === true) {
    console.error("用法：pnpm eval:replay --manifest evaluation/samples.json");
    process.exit(2);
  }

  const manifestPath = resolve(repoRoot, String(manifestArg));
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  } catch (err) {
    console.error(`无法读取样本清单 ${manifestPath}：${(err as Error).message}`);
    process.exit(1);
  }

  const samples = manifest.samples ?? [];
  console.log(`样本清单：${manifestPath}`);
  console.log(`样本数：${samples.length}`);

  if (samples.length === 0) {
    console.log(
      "\n清单为空。按方案第 11.1 节，先准备 6–10 段约 10–20 秒的练习片段，\n" +
        "覆盖正常执行、目标问题、遮挡/模糊、捡球或走动，并完成人工标注。",
    );
    return;
  }

  // 分层统计样本构成。必须报告每类实际有多少样本，
  // 避免只展示一个总百分比。
  const byLabel = new Map<string, number>();
  const byVisibility = new Map<string, number>();
  for (const s of samples) {
    const label = String(s.label ?? "unlabeled");
    byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
    const vis = String(s.racketSideVisibility ?? "unknown");
    byVisibility.set(vis, (byVisibility.get(vis) ?? 0) + 1);
  }
  console.log("\n样本构成（按标注）：");
  for (const [k, v] of byLabel) console.log(`  ${k}: ${v}`);
  console.log("\n样本构成（按持拍侧可见性）：");
  for (const [k, v] of byVisibility) console.log(`  ${k}: ${v}`);

  // ── 逐样本评估 ──
  let sumMatched = 0;
  let sumDetected = 0;
  let sumTruth = 0;
  let evaluated = 0;
  const skipped: string[] = [];
  const perSample: Array<Record<string, unknown>> = [];

  for (const [i, s] of samples.entries()) {
    const id = String(s.id ?? `#${i}`);
    const { windows: truth, dropped } = toWindows(s.annotation?.strokes);
    if (dropped > 0) {
      console.warn(`! ${id}: 标注里有 ${dropped} 条 startMs/endMs 缺失或非数，已丢弃`);
    }

    let detected: TimeWindow[] = [];
    let observedLoaded = false;
    if (typeof s.observedFile === "string") {
      try {
        const obs = JSON.parse(await readFile(resolve(repoRoot, s.observedFile), "utf8")) as {
          detectedStrokes?: RawStroke[];
        };
        detected = toWindows(obs.detectedStrokes).windows;
        observedLoaded = true;
      } catch (err) {
        console.warn(
          `! ${id}: 读不到 observedFile（${s.observedFile}）：${(err as Error).message}`,
        );
      }
    }

    if (truth.length === 0 || !observedLoaded) {
      // 缺真值或缺观测 → **明确跳过，不给任何数字**，也不计入分母
      const why = truth.length === 0 ? "缺人工标注" : "缺回放观测";
      skipped.push(`${id}（${why}）`);
      perSample.push({ id, skipped: why });
      continue;
    }

    const r = matchSegments(detected, truth);
    evaluated++;
    sumMatched += r.matched.length;
    sumDetected += detected.length;
    sumTruth += truth.length;

    perSample.push({
      id,
      detected: detected.length,
      truth: truth.length,
      matched: r.matched.length,
      missed: r.missed.length,
      spurious: r.spurious.length,
      precision: r.precision,
      recall: r.recall,
      iouMeanOfMatched: r.matched.length
        ? r.matched.reduce((a, m) => a + m.iou, 0) / r.matched.length
        : null,
      boundaryErrorMs: r.boundaryErrorMs,
    });

    console.log(`\n── ${id} ──`);
    console.log(`  检出 ${detected.length}，真值 ${truth.length}，命中 ${r.matched.length}`);
    console.log(
      `  precision ${fmt(r.precision)}，recall ${fmt(r.recall)}，` +
        `漏检 ${r.missed.length}，误检 ${r.spurious.length}`,
    );
    console.log(
      `  边界误差（命中对）：起点 均值 ${fmt(r.boundaryErrorMs.startMean, 1)}ms / ` +
        `中位 ${fmt(r.boundaryErrorMs.startMedian, 1)}ms；` +
        `终点 均值 ${fmt(r.boundaryErrorMs.endMean, 1)}ms / 中位 ${fmt(r.boundaryErrorMs.endMedian, 1)}ms`,
    );
    for (const m of r.matched) {
      console.log(
        `    命中 IoU ${m.iou.toFixed(2)}：检出 ${m.detected.startMs}~${m.detected.endMs} vs 真值 ${m.truth.startMs}~${m.truth.endMs}`,
      );
    }
    for (const t of r.missed)
      console.log(`    漏检：真值 ${t.startMs}~${t.endMs} 没有任何检出对上`);
    for (const d of r.spurious)
      console.log(`    误检：检出 ${d.startMs}~${d.endMs} 不对应任何真值`);
  }

  // ── 汇总：用**合并计数**算，而不是"各样本比值的平均" ──
  // 平均比值会让只有 1 次挥拍的样本与有 20 次挥拍的样本等权，是常见的口径错误。
  console.log("\n─────────────────────────────────────────────");
  if (evaluated === 0) {
    console.log(
      "没有任何样本同时具备**人工标注**与**回放观测**，因此不输出任何准确率数字。\n" +
        `未计入的样本：${skipped.length ? skipped.join("、") : "（无）"}\n\n` +
        "要为某段素材补齐评估，需要两步：\n" +
        "  1. 导出回放观测（需要真实素材）：\n" +
        "       PPC_VERIFY_VIDEO=<素材路径> pnpm --filter @pingpong/web test:e2e segmentation-eval\n" +
        "     它会写出 segmentation-observed.json（逐帧观测 + 检出的挥拍）与联系表 contact-sheet.png。\n" +
        "  2. 按联系表人工标注真值挥拍窗口，写进本清单该样本的 annotation.strokes。\n\n" +
        "在两步都完成之前，本脚本**不会**输出任何准确率数字 —— 没有真值时任何指标都是编造的。",
    );
    process.exitCode = 0;
    return;
  }

  console.log(
    `已评估 ${evaluated} / ${samples.length} 个样本` +
      (skipped.length ? `，未计入 ${skipped.length} 个：${skipped.join("、")}` : ""),
  );
  // 分母是**累计的全部**检出与真值 —— 不因为误检/漏检而从分母里剔除
  console.log(`合并计数：命中 ${sumMatched} / 检出 ${sumDetected} / 真值 ${sumTruth}`);
  console.log(`合并 precision：${fmt(sumDetected === 0 ? null : sumMatched / sumDetected)}`);
  console.log(`合并 recall：${fmt(sumTruth === 0 ? null : sumMatched / sumTruth)}`);
  console.log(
    "\n提醒：以上是**分段**指标，不是识别准确率。样本量与标注方式决定了它能支持什么结论，\n" +
      "报告时必须一并给出：样本数、每类的实际样本数、以及标注是谁做的。",
  );
}

main().catch((err: unknown) => {
  console.error(`eval:replay 失败：${(err as Error).message}`);
  process.exit(1);
});
