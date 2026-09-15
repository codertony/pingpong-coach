import { describe, expect, it } from "vitest";
import type { FeatureValue } from "@pingpong/contracts";
import { FEATURE_IDS } from "@pingpong/contracts";
import {
  BUILTIN_RULES,
  DEFAULT_THRESHOLDS,
  evaluateRule,
  type RuleDefinition,
} from "../src/rules.js";

function feature(
  id: string,
  value: number | null,
  quality: "usable" | "limited" | "unusable" = "usable",
  reasonIfMissing: string | null = null,
): FeatureValue {
  return {
    id,
    value,
    unit: "ms",
    coordinateSpace: "image_2d",
    intervalMs: [0, 1000],
    quality,
    reasonIfMissing,
  };
}

const RULE: RuleDefinition = {
  id: "test_rule",
  version: "1.0.0",
  strokeType: "forehand_drive",
  cameraViews: ["front"],
  focusId: "return_to_ready_zone",
  requiredFeatureIds: [FEATURE_IDS.RETURN_AFTER_WRIST_PEAK],
  notApplicableWhen: [],
  status: "reviewed",
  referenceId: "ref_1",
  allowedCues: ["cue"],
  allowedDrillIds: [],
};

const OK = {
  validStrokeCount: 3,
  judgeable: true,
};

describe("evaluateRule", () => {
  it("画质未达门槛时拒绝判断，不给任何结论", () => {
    const v = evaluateRule({
      rule: RULE,
      features: [feature(FEATURE_IDS.RETURN_AFTER_WRIST_PEAK, 500)],
      validStrokeCount: 3,
      judgeable: false,
    });
    expect(v.kind).toBe("insufficient_evidence");
  });

  it("有效挥拍不足时拒绝判断", () => {
    const v = evaluateRule({
      rule: RULE,
      features: [feature(FEATURE_IDS.RETURN_AFTER_WRIST_PEAK, 500)],
      validStrokeCount: 1,
      judgeable: true,
    });
    expect(v.kind).toBe("insufficient_evidence");
    if (v.kind === "insufficient_evidence") {
      expect(v.reason).toContain("1 次");
    }
  });

  it("所需特征缺失时拒绝判断", () => {
    const v = evaluateRule({
      rule: RULE,
      features: [],
      ...OK,
    });
    expect(v.kind).toBe("insufficient_evidence");
  });

  it("特征 value 为 null 时把原因的传递出来，且不当成 0", () => {
    const v = evaluateRule({
      rule: RULE,
      features: [
        feature(FEATURE_IDS.RETURN_AFTER_WRIST_PEAK, null, "unusable", "未检测到腕部速度峰值"),
      ],
      ...OK,
    });
    expect(v.kind).toBe("insufficient_evidence");
    if (v.kind === "insufficient_evidence") {
      expect(v.reason).toContain("未检测到腕部速度峰值");
    }
  });

  it("测量质量为 limited 时只给观察，不做数值判定", () => {
    const v = evaluateRule({
      rule: RULE,
      features: [feature(FEATURE_IDS.RETURN_AFTER_WRIST_PEAK, 500, "limited")],
      ...OK,
    });
    expect(v.kind).toBe("observation_only");
  });

  it("已审核规则 + 达标数值 → target_met，并给出证据引用", () => {
    const v = evaluateRule({
      rule: RULE,
      features: [feature(FEATURE_IDS.RETURN_AFTER_WRIST_PEAK, 500)],
      ...OK,
    });
    expect(v.kind).toBe("target_met");
    if (v.kind === "target_met") {
      expect(v.evidenceRefs).toContain(FEATURE_IDS.RETURN_AFTER_WRIST_PEAK);
    }
  });

  it("已审核规则 + 超标数值 → suggest_adjustment", () => {
    const v = evaluateRule({
      rule: RULE,
      features: [feature(FEATURE_IDS.RETURN_AFTER_WRIST_PEAK, 1200)],
      ...OK,
    });
    expect(v.kind).toBe("suggest_adjustment");
  });

  it("门槛边界值恰好等于上限时算达标", () => {
    const v = evaluateRule({
      rule: RULE,
      features: [
        feature(FEATURE_IDS.RETURN_AFTER_WRIST_PEAK, DEFAULT_THRESHOLDS.returnAfterWristPeakMaxMs),
      ],
      ...OK,
    });
    expect(v.kind).toBe("target_met");
  });

  it("未审核规则只输出观察，不输出达标结论", () => {
    const v = evaluateRule({
      rule: { ...RULE, status: "observation_only", referenceId: null },
      features: [feature(FEATURE_IDS.RETURN_AFTER_WRIST_PEAK, 500)],
      ...OK,
    });
    expect(v.kind).toBe("observation_only");
  });

  it("自定义门槛可覆盖默认值", () => {
    const v = evaluateRule(
      {
        rule: RULE,
        features: [feature(FEATURE_IDS.RETURN_AFTER_WRIST_PEAK, 900)],
        ...OK,
      },
      { ...DEFAULT_THRESHOLDS, returnAfterWristPeakMaxMs: 1000 },
    );
    expect(v.kind).toBe("target_met");
  });
});

describe("BUILTIN_RULES", () => {
  it("首版规则覆盖回到准备区关注点", () => {
    const rule = BUILTIN_RULES.find((r) => r.focusId === "return_to_ready_zone");
    expect(rule).toBeDefined();
  });

  it("没有教练认可参考时，规则保持 observation_only，不冒充已审核", () => {
    const rule = BUILTIN_RULES.find((r) => r.focusId === "return_to_ready_zone")!;
    expect(rule.referenceId).toBeNull();
    expect(rule.status).toBe("observation_only");
  });

  it("每条规则都声明了所需证据与不适用条件", () => {
    for (const r of BUILTIN_RULES) {
      expect(r.requiredFeatureIds.length).toBeGreaterThan(0);
      expect(r.notApplicableWhen.length).toBeGreaterThan(0);
      expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
