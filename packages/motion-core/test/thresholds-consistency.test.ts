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
import { FOCUS_IDS } from "@pingpong/contracts";
import { BUILTIN_RULES, DEFAULT_THRESHOLDS } from "../src/rules.js";

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
});
