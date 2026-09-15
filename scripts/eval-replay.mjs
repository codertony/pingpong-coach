#!/usr/bin/env node
/**
 * 回放评估入口。
 *
 * 用途：对同一批真实片段重放，输出测量、分段与反馈指标。
 *
 * 现状说明（重要）：
 * 本脚本当前只实现"清单校验 + 结构检查 + 明确的待实现提示"。
 * 它**不**产生任何准确率数字 —— 在没有真实样本和真人标注之前，
 * 任何 precision/recall 都是编造的。方案第 11 节明确要求这一点。
 *
 * 用法：
 *   node scripts/eval-replay.mjs --manifest evaluation/samples.json
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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

const args = parseArgs(process.argv.slice(2));
const manifestArg = args.manifest;

if (!manifestArg || manifestArg === true) {
  console.error("用法：node scripts/eval-replay.mjs --manifest evaluation/samples.json");
  process.exit(2);
}

const manifestPath = resolve(repoRoot, String(manifestArg));

async function main() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (err) {
    console.error(`无法读取样本清单 ${manifestPath}：${err.message}`);
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
  const byLabel = new Map();
  const byVisibility = new Map();
  for (const s of samples) {
    const label = s.label ?? "unlabeled";
    byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
    const vis = s.racketSideVisibility ?? "unknown";
    byVisibility.set(vis, (byVisibility.get(vis) ?? 0) + 1);
  }

  console.log("\n样本构成（按标注）：");
  for (const [k, v] of byLabel) console.log(`  ${k}: ${v}`);

  console.log("\n样本构成（按持拍侧可见性）：");
  for (const [k, v] of byVisibility) console.log(`  ${k}: ${v}`);

  const unlabeled = samples.filter((s) => !s.label || s.label === "unlabeled").length;
  if (unlabeled > 0) {
    console.warn(`\n! 有 ${unlabeled} 个样本没有标注，不能用于准确率评估。`);
  }

  console.log(
    "\n─────────────────────────────────────────────\n" +
      "评估流水线尚未接入。需要先完成：\n" +
      "  1. 在 Node 侧复用 motion-core 跑分段与特征（motion-core 不依赖 DOM，可直接引入）；\n" +
      "  2. 解码视频并按源媒体时间逐帧喂入姿态引擎；\n" +
      "  3. 与人工标注对比：分段 temporal IoU、边界误差、测量 MAE；\n" +
      "  4. 反馈层面的 precision / recall / 覆盖率。\n\n" +
      "在此之前本脚本不会输出任何准确率数字 —— 没有真实样本和标注时，\n" +
      "任何指标都是编造的，这会直接误导后续决策。\n" +
      "工具链接入后，真实结果记录到 docs/evaluation-log.md。",
  );
}

main().catch((err) => {
  console.error(`eval:replay 失败：${err.message}`);
  process.exit(1);
});
