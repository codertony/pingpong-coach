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
import {
  eventPercentileOfSorted,
  eventTimeErrors,
  matchSegments,
  type EventTimeErrorRow,
  type TimedEvent,
  type TimeWindow,
} from "@pingpong/motion-core";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

interface RawStroke {
  startMs?: unknown;
  endMs?: unknown;
  /** 观测侧：这一板的阶段事件（由 e2e 导出） */
  phaseEvents?: RawEvent[];
}
/** 人工标注的**阶段事件**真值（引拍/前挥/还原各在什么时候）。 */
interface RawEvent {
  eventType?: unknown;
  timeMs?: unknown;
}
interface Sample {
  id?: unknown;
  label?: unknown;
  racketSideVisibility?: unknown;
  /**
   * 人工/模型标注的真值：挥拍窗口 + 阶段事件 + **标注者**。
   *
   * `annotatorId` 不是可选项（`evaluation/samples.json` 的 honesty 一栏写明：
   * 标注者是谁必须写下来；模型标注只能当估计，至少要与真人标注**分开报告**）。
   * 这里允许它缺失，但缺了会被单列成一组并告警 —— 不许悄悄并进任何一边。
   */
  annotation?: { strokes?: RawStroke[]; events?: RawEvent[]; annotatorId?: unknown };
  /** 由 `e2e/segmentation-eval.e2e.ts` 导出的观测结果（含 detectedStrokes） */
  observedFile?: unknown;
}
interface ObservedFile {
  detectedStrokes?: RawStroke[];
  /** 源视频信息，用来**推导**事件容差（见下） */
  video?: { fps?: unknown };
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

/** 把 {eventType,timeMs} 形状的数组转成事件，过滤掉字段缺失/非数的条目并计数。 */
function toEvents(raw: RawEvent[] | undefined): { events: TimedEvent[]; dropped: number } {
  const events: TimedEvent[] = [];
  let dropped = 0;
  for (const e of raw ?? []) {
    if (
      typeof e?.eventType === "string" &&
      typeof e?.timeMs === "number" &&
      Number.isFinite(e.timeMs)
    ) {
      events.push({ eventType: e.eventType, timeMs: e.timeMs });
    } else {
      dropped++;
    }
  }
  return { events, dropped };
}

/**
 * 事件容差：**默认由源帧率推出，而不是写死一个毫秒数**。
 *
 * 评审 §10 给的探索目标是「明确可见的事件中位误差 ≤ 2 个源帧」——
 * 那是**帧**，不是毫秒：60fps 下 33ms、30fps 下 67ms。写死一个毫秒数会在
 * 换帧率时悄悄变松或变紧。所以这里从观测文件里的源帧率推，并**把用到的值打印出来**
 * （报告里必须能看到容差是多少，否则指标无从追责）。
 * 需要别的容差时用 `PPC_EVENT_TOLERANCE_MS` 覆盖。
 */
const EVENT_TOLERANCE_SOURCE_FRAMES = 2;

/**
 * 标注侧的事件词表 → 检测侧的事件类型。
 *
 * ⚠️ **两侧的词表本来就不一样，必须显式对齐**（`docs/annotation-agent-protocol.md` §4
 * 用的是标注员视角的词，检测侧用的是分段器真实产生的转变）。直接拿两边同名比对，
 * 会让 `forward_swing_start` 与 `forward_start` **互相算作漏检与误检** ——
 * 指标看起来像"检测极差"，实际只是**名字对不上**。这类"看起来是质量问题、
 * 其实是口径问题"的坑，本仓库已经踩过好几次。
 */
const ANNOTATION_TO_DETECTED: Record<string, string> = {
  backswing_start: "backswing_start",
  // 标注协议自己也写了：`forward_swing_start` 与 `backswing_end` 常常是同一格，
  // 所以这里只取前者，避免同一个转折被算两次
  forward_swing_start: "forward_start",
  return_to_ready: "return_start",
};

/**
 * 标注里**没有检测侧对应物**的事件类型 —— 它们不参与评分，但**必须被打印出来**。
 *
 * 为什么是"不参与"而不是"算漏检"：检测侧**刻意不产出**这些事件
 * （`contact_visible` 是红线 2：单目二维没有可靠接触证据；`follow_through_end`
 * 与 `backswing_end` 状态机里没有这个转变）。把它们算成漏检等于拿一份
 * **没承诺过的能力**去扣分。
 *
 * 这与"筛分母"的区别在于：这里排除的是**整个维度**并当场说明，
 * 不是把不方便的样本从分母里拿掉。
 */
const ANNOTATION_ONLY_TYPES = new Set([
  "backswing_end",
  "contact_visible",
  "follow_through_end",
  "ready_pose_reference",
  "next_stroke_start",
]);

/** 把标注侧事件映射到检测侧词表；同时分出"已知但不评分"与"**没见过的**"两类。 */
function mapAnnotationEvents(raw: RawEvent[] | undefined): {
  events: TimedEvent[];
  excluded: Map<string, number>;
  unknown: Map<string, number>;
  dropped: number;
} {
  const { events: parsed, dropped } = toEvents(raw);
  const events: TimedEvent[] = [];
  const excluded = new Map<string, number>();
  const unknown = new Map<string, number>();
  for (const e of parsed) {
    const mapped = ANNOTATION_TO_DETECTED[e.eventType];
    if (mapped != null) {
      events.push({ eventType: mapped, timeMs: e.timeMs });
    } else if (ANNOTATION_ONLY_TYPES.has(e.eventType)) {
      excluded.set(e.eventType, (excluded.get(e.eventType) ?? 0) + 1);
    } else {
      /*
       * 既不在映射表里、也不在"已知不评分"清单里 —— 很可能是**拼错或用了另一侧的词**。
       *
       * 这一条是刻意加的：如果不分开，拼错的类型会落进 `excluded` 被**静默丢掉**，
       * 表现为"这一类没有真值"，指标看起来一切正常 —— 而实际上标注白标了。
       * （本文件上方那段词表桥接要解决的正是同一件事，不能在这里又开一个静默口子。）
       */
      unknown.set(e.eventType, (unknown.get(e.eventType) ?? 0) + 1);
    }
  }
  return { events, excluded, unknown, dropped };
}

function deriveEventTolerance(fps: unknown): number | null {
  const override = Number(process.env.PPC_EVENT_TOLERANCE_MS);
  if (Number.isFinite(override) && override > 0) return override;
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) return null;
  return (EVENT_TOLERANCE_SOURCE_FRAMES * 1000) / fps;
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
  let evaluated = 0;
  const skipped: string[] = [];
  const perSample: Array<Record<string, unknown>> = [];

  interface EventAgg {
    errors: number[];
    matched: number;
    missed: number;
    spurious: number;
  }
  interface AnnotatorAgg {
    matched: number;
    detected: number;
    truth: number;
    samples: number;
    events: Map<string, EventAgg>;
  }

  /*
   * **按标注者分开累计**，而不是一个总数。
   *
   * 为什么必须分开：模型生成的标注只能当**估计**，不能当人工真值
   * （`evaluation/samples.json` 的 honesty 一栏与标注协议 §C 都写明了）。
   * 合成一个数之后，读的人只会看到一个"准确率"，而它里面混着估计。
   */
  const perAnnotator = new Map<string, AnnotatorAgg>();
  const aggOf = (key: string): AnnotatorAgg => {
    let cur = perAnnotator.get(key);
    if (!cur) {
      cur = { matched: 0, detected: 0, truth: 0, samples: 0, events: new Map() };
      perAnnotator.set(key, cur);
    }
    return cur;
  };
  /** 没写 annotatorId 的样本单独成组 —— 不能悄悄并进任何一边 */
  const UNKNOWN_ANNOTATOR = "（未注明 annotatorId）";

  /*
   * 事件误差的**合并**统计：把各样本的**原始误差**并到一起再取分位。
   * 不是"各样本的分位数再取平均" —— 那与"样本量与挥拍数无关地等权"是同一个口径错误。
   */
  const poolEvent = (agg: AnnotatorAgg, e: EventTimeErrorRow): void => {
    const cur = agg.events.get(e.eventType) ?? {
      errors: [],
      matched: 0,
      missed: 0,
      spurious: 0,
    };
    cur.errors.push(...e.signedErrorsMs);
    cur.matched += e.matched;
    cur.missed += e.missed;
    cur.spurious += e.spurious;
    agg.events.set(e.eventType, cur);
  };

  for (const [i, s] of samples.entries()) {
    const id = String(s.id ?? `#${i}`);
    const { windows: truth, dropped } = toWindows(s.annotation?.strokes);
    if (dropped > 0) {
      console.warn(`! ${id}: 标注里有 ${dropped} 条 startMs/endMs 缺失或非数，已丢弃`);
    }

    let detected: TimeWindow[] = [];
    let detectedEvents: TimedEvent[] = [];
    let sourceFps: unknown = null;
    let observedLoaded = false;
    if (typeof s.observedFile === "string") {
      try {
        const obs = JSON.parse(
          await readFile(resolve(repoRoot, s.observedFile), "utf8"),
        ) as ObservedFile;
        detected = toWindows(obs.detectedStrokes).windows;
        // 事件散在各板里，摊平成一条时间线再比对（事件评估不关心它属于哪一板）
        detectedEvents = (obs.detectedStrokes ?? []).flatMap(
          (st) => toEvents(st.phaseEvents).events,
        );
        sourceFps = obs.video?.fps ?? null;
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

    const annotatorKey =
      typeof s.annotation?.annotatorId === "string" && s.annotation.annotatorId.trim() !== ""
        ? s.annotation.annotatorId
        : UNKNOWN_ANNOTATOR;
    if (annotatorKey === UNKNOWN_ANNOTATOR) {
      console.warn(
        `! ${id}: 没有 annotatorId —— 该样本的数字会被单列在「${UNKNOWN_ANNOTATOR}」下，` +
          `不得与人工真值合并引用（协议要求标注者是谁必须写下来）`,
      );
    }

    const r = matchSegments(detected, truth);
    evaluated++;
    const agg = aggOf(annotatorKey);
    agg.matched += r.matched.length;
    agg.detected += detected.length;
    agg.truth += truth.length;
    agg.samples++;

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

    /*
     * ── 事件定位（R4 的配套口径）：这一板的**过程**有没有被找对 ──
     *
     * 与上面的分段指标是**独立**的两件事：一板可以被完整找到（IoU 高）
     * 而阶段时刻全错。所以分开报，不合成一个分数。
     */
    const mappedTruth = mapAnnotationEvents(s.annotation?.events);
    if (mappedTruth.dropped > 0) {
      console.warn(`! ${id}: 事件标注里有 ${mappedTruth.dropped} 条字段缺失或非数，已丢弃`);
    }
    if (mappedTruth.excluded.size > 0) {
      console.log(
        `  事件定位：标注里的 ${[...mappedTruth.excluded]
          .map(([k, v]) => `${k}×${v}`)
          .join("、")} 在本版检测侧**没有对应物**（刻意不产出的能力），不参与评分`,
      );
    }
    if (mappedTruth.unknown.size > 0) {
      // 大声报：这些标注**被丢掉了**，而且很可能只是拼错/用了另一侧的词
      console.warn(
        `! ${id}: 事件标注里出现**不认识**的类型 ${[...mappedTruth.unknown]
          .map(([k, v]) => `${k}×${v}`)
          .join("、")} —— 已丢弃。` +
          `允许的是检测侧四种（backswing_start / forward_start / return_start / stroke_closed）` +
          `或标注协议里的对应词（见脚本里的 ANNOTATION_TO_DETECTED）`,
      );
    }
    const tolerance = deriveEventTolerance(sourceFps);

    if (mappedTruth.events.length === 0) {
      // 没标注可评的事件就不给事件指标 —— 与"缺真值不给分段指标"同一条纪律
      console.log(
        mappedTruth.excluded.size > 0
          ? "  事件定位：标注里的事件本版都没有对应物，无法评分"
          : "  事件定位：未标注阶段事件（annotation.events 为空），不输出事件指标",
      );
    } else if (tolerance == null) {
      console.log(
        "  事件定位：拿不到源帧率，**推导不出容差** —— 在观测文件里补 video.fps，" +
          "或设 PPC_EVENT_TOLERANCE_MS 后重跑（不给默认值是刻意的：容差必须能被追责）",
      );
    } else {
      const rows = eventTimeErrors(detectedEvents, mappedTruth.events, tolerance);
      console.log(
        `  事件定位（容差 ±${tolerance.toFixed(0)}ms = ${EVENT_TOLERANCE_SOURCE_FRAMES} 个源帧）：`,
      );
      for (const e of rows) {
        /*
         * "检出有、真值里一条都没有"多为**两侧词表差异**，不是检测在乱报 ——
         * 例如检测侧的 `stroke_closed`（本板闭合）在标注协议里没有对应项。
         * 直接读成"误检 1"会把人引向错误的结论，所以这里明说一句。
         */
        const detectedOnly = e.matched === 0 && e.missed === 0 && e.spurious > 0;
        console.log(
          `    ${e.eventType}: 命中 ${e.matched}，漏 ${e.missed}，误 ${e.spurious}；` +
            `绝对误差 P50 ${fmt(e.absP50Ms, 1)}ms / P95 ${fmt(e.absP95Ms, 1)}ms；` +
            `带符号中位 ${fmt(e.signedMedianMs, 1)}ms` +
            (detectedOnly ? "（该类型标注侧没有对应项，多半是两侧词表差异，不是乱报）" : ""),
        );
        poolEvent(agg, e);
      }
    }
  }

  // ── 汇总：用**合并计数**算，而不是"各样本比值的平均" ──
  // 平均比值会让只有 1 次挥拍的样本与有 20 次挥拍的样本等权，是常见的口径错误。
  console.log("\n─────────────────────────────────────────────");
  if (evaluated === 0) {
    console.log(
      "没有任何样本同时具备**人工标注**与**回放观测**，因此不输出任何准确率数字。\n" +
        `未计入的样本：${skipped.length ? skipped.join("、") : "（无）"}\n\n` +
        "要为某段素材补齐评估，需要几步：\n" +
        "  1. 导出回放观测（需要真实素材）：\n" +
        "       PPC_VERIFY_VIDEO=<素材路径> pnpm --filter @pingpong/web test:e2e segmentation-eval\n" +
        "     它会写出 segmentation-observed.json（逐帧观测 + 检出的挥拍 + 阶段事件）与联系表 contact-sheet.png。\n" +
        "  2. 按联系表人工标注真值挥拍窗口，写进本清单该样本的 annotation.strokes。\n" +
        "  3. （要报**事件定位**就必须做）标注阶段事件时刻，写进 annotation.events，\n" +
        '     形如 [{ eventType: "backswing_start", timeMs: 1200 }, ...]；\n' +
        "     eventType 只允许 backswing_start / forward_start / return_start / stroke_closed。\n\n" +
        "在两步都完成之前，本脚本**不会**输出任何准确率数字 —— 没有真值时任何指标都是编造的。",
    );
    process.exitCode = 0;
    return;
  }

  console.log(
    `已评估 ${evaluated} / ${samples.length} 个样本` +
      (skipped.length ? `，未计入 ${skipped.length} 个：${skipped.join("、")}` : ""),
  );

  /*
   * ── 按标注者分开报告 ──
   *
   * **刻意不给一个跨标注者的合计**：模型生成的标注只能当**估计**，与人工真值混成
   * 一个数之后，读的人只看到一个"准确率"，而它里面掺着估计
   * （`evaluation/samples.json` 的 honesty 一栏与标注协议 §C 都写明了这条）。
   * 分母仍是**累计的全部**检出与真值 —— 不因为误检/漏检而从分母里剔除。
   */
  console.log("\n按标注者分开报告（**不提供跨标注者合计** —— 估计与真值不能混成一个数）：");
  for (const [annotator, agg] of perAnnotator) {
    const isModel = /^model[:@]/.test(annotator);
    console.log(`\n  ── ${annotator}${isModel ? "（模型标注：只能当估计）" : ""} ──`);
    console.log(`    样本 ${agg.samples} 个`);
    console.log(`    合并计数：命中 ${agg.matched} / 检出 ${agg.detected} / 真值 ${agg.truth}`);
    console.log(
      `    合并 precision：${fmt(agg.detected === 0 ? null : agg.matched / agg.detected)}`,
    );
    console.log(`    合并 recall：${fmt(agg.truth === 0 ? null : agg.matched / agg.truth)}`);

    if (agg.events.size === 0) {
      console.log("    事件定位：没有同时具备事件标注与事件观测的样本");
      continue;
    }
    console.log("    合并事件定位（原始误差**并起来**再取分位，不是把分位数平均）：");
    for (const [type, p] of [...agg.events.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const abs = p.errors.map((v) => Math.abs(v)).sort((a, b) => a - b);
      console.log(
        `      ${type}: 命中 ${p.matched}，漏 ${p.missed}，误 ${p.spurious}；` +
          `绝对误差 P50 ${fmt(eventPercentileOfSorted(abs, 0.5), 1)}ms / ` +
          `P95 ${fmt(eventPercentileOfSorted(abs, 0.95), 1)}ms`,
      );
    }
  }

  console.log(
    "\n提醒：以上是**分段**与**事件定位**指标，不是识别准确率。样本量与标注方式决定了它能支持什么结论，\n" +
      "报告时必须一并给出：样本数、每类的实际样本数、以及标注是谁做的。\n" +
      "事件容差也必须一并给出（它随源帧率变，不写出来指标无从追责）。",
  );
}

main().catch((err: unknown) => {
  console.error(`eval:replay 失败：${(err as Error).message}`);
  process.exit(1);
});
