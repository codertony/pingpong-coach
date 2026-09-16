#!/usr/bin/env tsx
/**
 * 阈值诊断：从回放数据里算出**准备区半径的可行区间**。
 *
 * ## 它回答什么问题
 *
 * F-022 的结论是"连续对拉时相邻几板被合并"，而根因之一是
 * **准备区半径（`readyZoneRadiusBodyScale`，当前 0.3）相对这个人的回位位置太小**：
 * 实测回位落点 0.29~0.40 正压在 0.3 上，落点在区外时检出**直接归零**。
 *
 * 但"该调到多少"原先我说要等人工标注。**这句话对了一半** ——
 * 标注能验证"哪一板到哪一板算一次"，但半径的**可行区间**可以由数据本身框出来：
 *
 *   准备区要**装得下"手停着等球"那一团**（否则 `ready` 永远满足不了），
 *   又要**装不下"挥拍摆幅"那一团**（否则挥拍途中也会被当成在准备区）。
 *
 * 把 244 帧的"腕部到准备区中心距离"画成直方图，**两团之间的谷底**就是数据给出的分界。
 *
 * ## 它**不是**什么（重要）
 *
 * - **不是准确率。** 这里没有任何真值参与，也就没有任何 precision/recall。
 * - **不是自动调参。** 它给出区间与依据，**不改任何阈值**。改阈值要按
 *   `docs/acceptance.md` 记录理由与版本，且样本量只有一支素材时不足以定值。
 * - **谷底是启发式**，不是定理。样本少或动作不规律时谷底会很浅，
 *   脚本会**明确说出"这个谷底不够显著"**，而不是硬给一个数。
 *
 * 用法：
 *   pnpm diagnose:thresholds --timeline apps/web/.tmp-eval/pose-timeline.json
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_SEGMENTATION, DISTRIBUTION_BIN, findDipBracket } from "@pingpong/motion-core";

interface Frame {
  tMs: number;
  poseDetected: boolean;
  wristX: number | null;
  wristY: number | null;
  phase?: string | null;
  zoneXPx?: number | null;
  zoneYPx?: number | null;
  zoneRadiusPx?: number | null;
  bodyScalePx?: number | null;
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const timelineArg = args.timeline;
  if (!timelineArg || timelineArg === true) {
    console.error("用法：pnpm diagnose:thresholds --timeline <pose-timeline.json 路径>");
    process.exit(2);
  }

  const path = resolve(process.cwd(), String(timelineArg));
  let frames: Frame[];
  try {
    frames = JSON.parse(await readFile(path, "utf8")) as Frame[];
  } catch (err) {
    console.error(`读不到回放数据 ${path}：${(err as Error).message}`);
    console.error(
      "\n先跑一次回放导出（需要真实素材）：\n" +
        "  PPC_VERIFY_VIDEO=<素材路径> pnpm --filter @pingpong/web test:e2e segmentation-eval",
    );
    process.exit(1);
  }

  // 用**逐帧记录下来的**准备区算距离 —— 不用"前若干帧的均值"去估，
  // 那是拿分段器的视角当基准，等于循环论证（这一点踩过）。
  const usable = frames.filter(
    (f) =>
      f.wristX != null &&
      f.wristY != null &&
      f.zoneXPx != null &&
      f.zoneYPx != null &&
      f.zoneRadiusPx != null &&
      f.zoneRadiusPx > 0,
  );
  if (usable.length === 0) {
    console.error(
      "这份回放数据里没有准备区坐标 —— 它是旧版本导出的。\n" +
        "重新跑一次 segmentation-eval 即可（新版本会逐帧记录当时生效的准备区）。",
    );
    process.exit(1);
  }

  const configured = DEFAULT_SEGMENTATION.readyZoneRadiusBodyScale;

  // 体尺度**直接读导出里的实测值**，不从上式反推。
  // 反推依赖"半径是按当前配置算的"这个前提 —— 配置一改，反推就错。
  const withScale = usable.filter((f) => f.bodyScalePx != null && f.bodyScalePx > 0);
  if (withScale.length === 0) {
    console.error(
      "这份回放数据里没有体尺度 —— 它是旧版本导出的，或者整段都没测到肩与髋。\n" +
        "重新跑一次 segmentation-eval 即可（新版本会逐帧记录体尺度）。",
    );
    process.exit(1);
  }
  const scales = withScale.map((f) => f.bodyScalePx!).sort((a, b) => a - b);
  const medianScale = scales[Math.floor(scales.length / 2)]!;

  const distances = withScale.map(
    (f) => Math.hypot(f.wristX! - f.zoneXPx!, f.wristY! - f.zoneYPx!) / f.bodyScalePx!,
  );
  const dist = findDipBracket(distances);

  console.log(`回放数据：${path}`);
  console.log(
    `可用帧 ${distances.length} / ${frames.length}；体尺度中位 ${medianScale.toFixed(1)} px` +
      `（实测范围 ${scales[0]!.toFixed(0)}~${scales[scales.length - 1]!.toFixed(0)} px）`,
  );
  console.log(`\n腕部到准备区中心的距离分布（体尺度，分箱 ${DISTRIBUTION_BIN}）：`);
  const maxCount = Math.max(...dist.bins);
  for (let i = 0; i < dist.bins.length; i++) {
    const n = dist.bins[i] ?? 0;
    if (n === 0) continue;
    const mark = i === dist.dipBin ? "  ← 谷底" : "";
    console.log(
      `  ${(i * DISTRIBUTION_BIN).toFixed(1)}~${((i + 1) * DISTRIBUTION_BIN).toFixed(1)}  ` +
        `${"#".repeat(Math.ceil((n / maxCount) * 40))} ${n}${mark}`,
    );
  }

  const insideNow = distances.filter((d) => d <= configured).length;
  console.log(
    `\n当前配置半径 ${configured}：有 ${insideNow} / ${distances.length} 帧算"在准备区内"` +
      `（${((insideNow / distances.length) * 100).toFixed(0)}%）`,
  );

  if (dist.dipBin == null) {
    console.log(
      "\n⚠️ 没找到显著的谷底 —— 这两团之间没有清晰的分界。\n" +
        `  可能原因：素材太短、动作不规律、或准备姿势本身就在漂。\n` +
        `  **不给建议值**：谷底不显著时硬给一个数，等于换个方式猜。\n` +
        `  这种情况更需要人工标注来定段，而不是靠分布。`,
    );
  } else {
    const dipValue = dist.dipBin * DISTRIBUTION_BIN;
    console.log(
      `\n谷底在 **${dipValue.toFixed(1)}~${(dipValue + DISTRIBUTION_BIN).toFixed(1)}** 体尺度` +
        `（该箱只有 ${dist.bins[dist.dipBin]} 帧，占 ${(dist.dipShare * 100).toFixed(1)}%）`,
    );
    console.log(
      `\n⇒ 数据给出的**可行区间**大约是 **${configured} ~ ${(dipValue + DISTRIBUTION_BIN).toFixed(1)}**：\n` +
        `  · 下界：不能小于当前值，否则"手停着等球"那一团会被切碎（现在就已经切碎了一半）\n` +
        `  · 上界：不能超过谷底，否则挥拍摆幅那一团会被当成在准备区\n`,
    );
    console.log(
      "**这不是自动调参**：脚本不改任何阈值。它把「该调到多少」从一个开放问题\n" +
        "缩小到一个区间，剩下的由人工标注确认（见 evaluation/samples.json 的 $howToEvaluate）。\n" +
        "样本量只有一支素材时，这个区间仅供参考，不足以定值。",
    );
  }
}

main().catch((err: unknown) => {
  console.error(`阈值诊断失败：${(err as Error).message}`);
  process.exit(1);
});
