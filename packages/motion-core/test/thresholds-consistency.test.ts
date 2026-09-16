/**
 * `configs/thresholds.json` 与代码的一致性检查。
 *
 * ══ 为什么需要 ══
 *
 * `configs/thresholds.json` 自述是"训练预设、阈值与功能开关"的**真相源**，
 * 而 AGENTS.md 的文档入口表、`acceptance.md` 的阈值变更记录、
 * README 的"依据实测结果修正它"—— **六个地方**都把它当成改阈值的地方。
 *
 * 但**代码从不读它**：`DEFAULT_THRESHOLDS` 是硬编码在
 * `packages/motion-core/src/rules.ts` 里的。于是"改 JSON"没有任何运行时效果 ——
 * 一个照着 README 做的人会以为改了阈值，其实什么都没改。
 *
 * ══ 这个文件做什么 ══
 *
 * 不把 JSON 接进运行时（那需要跨包路径解析与打包处理，收益不抵复杂度），
 * 而是**断言两边一致**：改了任一边而忘了另一边，测试当场红。
 *
 * 这样"改阈值"这件事就变成**要么两边一起改、要么改不动** ——
 * 比"写一段注释提醒大家同步"可靠得多。
 *
 * ══ 也检查 ruleId 的真实性 ══
 *
 * `focuses` 里声明的 `ruleId` 必须真的存在于 `BUILTIN_RULES`。
 * 实测发现这两个曾经都是**幽灵引用**（`elbow_extension_pattern_v1` /
 * `elbow_relative_torso_drift_v1` 从未被实现），而 JSON 让它们看起来已实现。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FOCUS_IDS, segmentationConfigSchema } from "@pingpong/contracts";
import { BUILTIN_RULES, DEFAULT_THRESHOLDS } from "../src/rules.js";
import { DEFAULT_SEGMENTATION } from "../src/segmentation.js";

const repoRoot = resolve(__dirname, "../../..");
const cfg = JSON.parse(readFileSync(resolve(repoRoot, "configs/thresholds.json"), "utf8"));

describe("configs/thresholds.json 与代码一致", () => {
  it("rules.returnAfterWristPeakMaxMs 两边一致", () => {
    expect(
      cfg.thresholds.rules.returnAfterWristPeakMaxMs,
      "configs/thresholds.json 与 DEFAULT_THRESHOLDS 不一致 —— 两边必须一起改",
    ).toBe(DEFAULT_THRESHOLDS.returnAfterWristPeakMaxMs);
  });

  it("thresholds.json 里出现的阈值键，都在代码的 ThresholdConfig 里有对应", () => {
    const codeKeys = new Set(Object.keys(DEFAULT_THRESHOLDS));
    const jsonKeys = Object.keys(cfg.thresholds.rules).filter((k) => !k.startsWith("$"));
    for (const k of jsonKeys) {
      expect(codeKeys.has(k), `JSON 里有 ${k}，但代码的 ThresholdConfig 没有它`).toBe(true);
    }
  });

  it("focuses 里声明的 ruleId 必须真的存在于 BUILTIN_RULES（不留幽灵引用）", () => {
    const implemented = new Set(BUILTIN_RULES.map((r) => r.id));
    for (const [focus, def] of Object.entries<{ ruleId?: string }>(cfg.focuses)) {
      if (def.ruleId == null) continue;
      expect(
        implemented.has(def.ruleId),
        `${focus} 声明了 ruleId「${def.ruleId}」，但 BUILTIN_RULES 里没有这条规则 —— ` +
          `这会让读者以为它已实现。要么实现它，要么把 ruleId 置为 null。`,
      ).toBe(true);
    }
  });

  it("enabled 的关注点必须都在契约的 FOCUS_IDS 里", () => {
    for (const [focus, def] of Object.entries<{ enabled?: boolean }>(cfg.focuses)) {
      if (def.enabled === false) continue;
      expect(
        FOCUS_IDS as readonly string[],
        `${focus} 在 configs 里启用，但不在契约的 FOCUS_IDS 里`,
      ).toContain(focus);
    }
  });

  // ── 分段阈值（F-026）──
  //
  // 这组断言是**补**出来的：JSON 里一直有一个 `segmentation` 块，
  // 而本文件此前**一个字都没提它** —— 也就是 F-019 修好之后，
  // "分段"这一子集仍然是**没人校的幽灵快照**（而那正是 F-022 说最需要标定的那几个值）。
  // 所以下面**两个方向都断言**：值要对得上，"有没有少写一个"也要管。
  it("segmentation 块的每个值都与代码的 DEFAULT_SEGMENTATION 一致", () => {
    const json = cfg.thresholds.segmentation as Record<string, unknown>;
    for (const [k, v] of Object.entries(DEFAULT_SEGMENTATION)) {
      expect(
        json[k],
        `segmentation.${k} 两边不一致（JSON 是 ${String(json[k])}，代码是 ${String(v)}）`,
      ).toBe(v);
    }
  });

  it("代码里的每个分段阈值在 JSON 里都有对应（**不许漏写**）", () => {
    // 单向断言会放过"漏写"：`maxGapMs` 就曾经是这样 ——
    // 它在 SegmentationConfig 里有、在代码里用着，JSON 里却没有，谁都没发现。
    const jsonKeys = new Set(
      Object.keys(cfg.thresholds.segmentation as Record<string, unknown>).filter(
        (k) => !k.startsWith("$"),
      ),
    );
    for (const k of Object.keys(DEFAULT_SEGMENTATION)) {
      expect(jsonKeys.has(k), `代码里有 ${k}，但 JSON 的 segmentation 块里漏了它`).toBe(true);
    }
    // 反向：JSON 里也不该有多余的键（那种键永远对不上运行时行为）
    const codeKeys = new Set(Object.keys(DEFAULT_SEGMENTATION));
    for (const k of jsonKeys) {
      expect(codeKeys.has(k), `JSON 的 segmentation 里有 ${k}，但代码里没有这个阈值`).toBe(true);
    }
  });

  it("DEFAULT_SEGMENTATION 覆盖了 SegmentationConfig 的全部数值字段", () => {
    // 用契约里的字段名反查，防止将来给 SegmentationConfig 加了字段却忘了给默认值。
    // 这三个是每次会话由用户选的，不是标定值，故排除。
    const perSession = new Set(["strokeType", "cameraView", "handedness"]);
    const contractKeys = Object.keys(
      segmentationConfigSchema.shape as Record<string, unknown>,
    ).filter((k) => !perSession.has(k));
    const codeKeys = new Set(Object.keys(DEFAULT_SEGMENTATION));
    for (const k of contractKeys) {
      expect(
        codeKeys.has(k),
        `SegmentationConfig 有 ${k}，但 DEFAULT_SEGMENTATION 没给默认值`,
      ).toBe(true);
    }
  });
});
