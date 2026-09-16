/**
 * 连续对拉时"相邻几板会被合并"—— 用**合成数据**把机制量化清楚（F-022）。
 *
 * ## 为什么用合成数据，以及它能/不能说明什么
 *
 * `AGENTS.md` 的纪律是：**合成样本适合验证计算与程序边界；真实动作的识别质量
 * 必须用真人标注数据验证**。这条测试严格待在允许的那一半里 ——
 * 它不声称任何"识别准不准"，只回答一个**确定**的问题：
 *
 *   当两板之间的"回位驻留"短于 `returnStableMinMs` 时，状态机**必然**把它们
 *   合并成一次；那这个临界点在哪里、形状如何？
 *
 * 为什么这个问题值得单独测：真实素材的逐帧回放（见 `docs/evaluation-log.md`）
 * 量到回位只停留 **33~67ms**、而门槛是 **120ms**，于是整段 8.15s
 * 只闭合了 2 次挥拍。真值（哪一板到哪一板算一次）只有人工标注能给，
 * 但"门槛与合并的因果关系"可以在这里用已知边界钉死。
 *
 * ## 合成的依据
 *
 * 相位序列与回位距离**照抄实测值**，不是随手编的：
 *   - 回位在准备区内停留 D 毫秒（扫描变量）—— 实测落在 33 / 67 / 100 / 166ms；
 *   - 引拍峰值 0.45 体尺度、前挥速度足够过 0.5 体尺度/秒的门槛；
 *   - 每板时长约 0.5~0.8s，与真实素材里两板之间的间隔同量级。
 */

import { describe, expect, it } from "vitest";
import type { SegmentationConfig, StrokeEvent } from "@pingpong/contracts";
import {
  DEFAULT_SEGMENTATION,
  StrokeSegmenter,
  type SegmentationSample,
} from "../src/segmentation.js";

/**
 * 产品真实用的那套值 —— **直接取默认值本身，不在这里再抄一份**。
 * 抄一份就等于又多一处"同一事实两处各写各的"（F-026 的形态）。
 */
const PRODUCT_CONFIG: SegmentationConfig = {
  strokeType: "forehand_drive",
  cameraView: "front",
  handedness: "right",
  ...DEFAULT_SEGMENTATION,
};

const READY_CENTER = { x: 640, y: 420 };
const BODY_SCALE = 155; // px，取自真实素材那次运行的遥测
const STEP_MS = 40;

/**
 * 跑一段"连续对拉"并返回**检出的挥拍**与**构造时的真值板数**。
 *
 * 真值是确定的：每循环 = 一板，所以真值板数 = cycles。
 * 这里刻意只比**数量**，不比边界 —— 边界的真值需要人工标注，
 * 而数量已经足以回答"会不会合并"。
 */
function runRally(opts: {
  cycles: number;
  /** 两板之间在准备区内停留多久（毫秒）—— 实测 33~67ms 会导致合并 */
  returnDwellMs: number;
  /** 回位落点相对准备区中心的距离（体尺度倍数）—— 实测 0.29~0.40 */
  returnDistBodyScale: number;
  config?: Partial<SegmentationConfig>;
}): { detected: StrokeEvent[]; truthCycles: number } {
  const config = { ...PRODUCT_CONFIG, ...opts.config };
  const seg = new StrokeSegmenter(config);
  seg.setReadyZone(READY_CENTER);

  const detected: StrokeEvent[] = [];
  let t = 0;
  const push = (offset: number, dist = offset) => {
    const s: SegmentationSample = {
      frameId: `f${t}_${offset}`,
      sourceTimeMs: t,
      wristPx: {
        x: READY_CENTER.x + dist * BODY_SCALE,
        y: READY_CENTER.y,
      },
      wristRelReadyZonePx: { x: dist * BODY_SCALE, y: 0 },
      bodyScalePx: BODY_SCALE,
      quality: "usable",
    };
    const e = seg.push(s);
    if (e) detected.push(e);
    t += STEP_MS;
  };

  // 开局先给一小段稳定驻留，让状态机进入 ready（否则第一板起不来）
  for (let i = 0; i < 5; i++) push(0, 0);

  for (let c = 0; c < opts.cycles; c++) {
    // ① 回位驻留：停在 returnDist（可能落在区外）D 毫秒
    const dwellFrames = Math.max(1, Math.round(opts.returnDwellMs / STEP_MS));
    for (let i = 0; i < dwellFrames; i++) push(0, opts.returnDistBodyScale);

    // ② 引拍：逐步远离，并在峰值停留让因果滤波收敛
    for (const d of [0.2, 0.45, 0.45, 0.45]) push(d);

    // ③ 向前挥拍：偏移快速减小 = 明显速度
    for (const d of [0.3, 0.15, 0.02]) push(d);
  }

  return { detected, truthCycles: opts.cycles };
}

/** 扫描"回位驻留时长"，看检出板数从什么时候开始塌下来。 */
function sweepDwell(cycles: number): Array<{ dwellMs: number; detected: number; truth: number }> {
  const out = [];
  for (const dwellMs of [0, 20, 40, 60, 80, 100, 120, 160, 200, 240]) {
    const { detected, truthCycles } = runRally({
      cycles,
      returnDwellMs: dwellMs,
      returnDistBodyScale: 0.2, // 先放在区内，单独看驻留时长这一个变量
    });
    out.push({
      dwellMs,
      detected: detected.filter((e) => e.complete).length,
      truth: truthCycles,
    });
  }
  return out;
}

describe("F-022 · 回位驻留时长与挥拍合并的关系（合成数据，已知真值）", () => {
  it("驻留短于 returnStableMinMs 时相邻板被合并；够长时逐板分开", () => {
    const table = sweepDwell(10);
    if (process.env.PPC_DEBUG_MERGE === "1") {
      console.log("\n回位驻留 → 检出板数（真值 10）：");
      for (const r of table) {
        console.log(`  ${String(r.dwellMs).padStart(4)}ms  →  ${r.detected} 板`);
      }
    }

    const at = (ms: number) => table.find((r) => r.dwellMs === ms)!.detected;
    const truth = table[0]!.truth;

    // ① 驻留短 → 必然合并。实测十板被压成 **5** 笔（两板并一笔），
    //    所以这里按真值的比例断言，而不是钉死一个具体数字。
    expect(
      at(0),
      `驻留 0ms 时检出 ${at(0)} 板 / 真值 ${truth} —— 没有呈现合并，说明合成数据没重现出问题形态`,
    ).toBeLessThanOrEqual(Math.ceil(truth * 0.6));

    // ② 驻留足够长 → 逐板分开
    //
    // ⚠️ 实测的**交叉点在 200ms 附近，而不是名义上的 `returnStableMinMs = 120`**：
    //    160ms 仍然合并，200ms 才分开。原因与"驻留计时从进入区内的**下一帧**才开始累计"
    //    有关（进入那一帧会把 `zoneDwellMs` 清零）。
    //    这里只断言"足够长就分开"，**不把 200 这个具体数字写成契约** ——
    //    它依赖 40ms 的采样步长，换个帧率就不一样，钉死会把一个采样细节固化成行为。
    expect(at(100), "驻留远短于门槛时却没有合并").toBeLessThan(9);
    expect(at(200), "驻留远超门槛时仍在大幅合并").toBeGreaterThanOrEqual(9);
    expect(at(240), "驻留远超门槛时仍在大幅合并").toBeGreaterThanOrEqual(9);

    // ③ 单调性：驻留越长，检出越多（允许小抖动，不要求严格单调）
    expect(at(240)).toBeGreaterThanOrEqual(at(0));
    expect(at(200)).toBeGreaterThanOrEqual(at(100));
  });

  it("回位落点骑在准备区半径边界上时，即使驻留够长也会合并", () => {
    // 真实素材实测：回位距离 0.29~0.40，而半径是 0.3 —— 一半在区内、一半在区外。
    // 这一条把"落点"与"驻留"两个因素分开：
    // 只要回位落在**区外**，状态机就认为"还没回来"，驻留计时根本不会开始累计。
    const inside = runRally({ cycles: 10, returnDwellMs: 200, returnDistBodyScale: 0.15 });
    const straddle = runRally({ cycles: 10, returnDwellMs: 200, returnDistBodyScale: 0.35 });

    const insideCount = inside.detected.filter((e) => e.complete).length;
    const straddleCount = straddle.detected.filter((e) => e.complete).length;

    if (process.env.PPC_DEBUG_MERGE === "1") {
      console.log(
        `\n回位落点 0.15（区内） → ${insideCount} 板；` +
          `0.35（区外） → ${straddleCount} 板（真值均 10）`,
      );
    }

    expect(insideCount, "回位落在区内、且驻留足够时应当逐板分开").toBeGreaterThanOrEqual(9);
    // 实测：落点在区外时**一板都检不出**（不是"少检"，是整体静默）——
    // 因为 `beginStroke` 要求先在区内稳定驻留，腕部从不进区就永远开不了头。
    // 这解释了为什么真实素材上"半径恰好压在回位距离上"会这么致命。
    expect(straddleCount, "回位落在区外时没有被合并 —— 那与真实素材观察到的形态不符").toBeLessThan(
      insideCount,
    );
  });

  it("合并是**少算**：检出板数只会少于或等于真值，不会凭空多出来", () => {
    // 这条守的是"合并"与"误检"不是一回事。若某次改动让检出**多于**真值，
    // 那是另一个缺陷（虚假挥拍，F-001 的形态），必须单独发现。
    for (const dwellMs of [0, 60, 120, 240]) {
      for (const dist of [0.15, 0.35]) {
        const { detected, truthCycles } = runRally({
          cycles: 8,
          returnDwellMs: dwellMs,
          returnDistBodyScale: dist,
        });
        const complete = detected.filter((e) => e.complete).length;
        expect(
          complete,
          `驻留 ${dwellMs}ms / 落点 ${dist} 时检出 ${complete} 板 > 真值 ${truthCycles} —— 出现了虚假挥拍`,
        ).toBeLessThanOrEqual(truthCycles);
      }
    }
  });
});
