/**
 * 本地规则。
 *
 * 用途：对**明确、已校准的训练目标**即时提示，不等大模型。
 * 大模型调用始终不阻塞摄像头与本地分析（方案第 1 节）。
 *
 * 纪律：
 * - 每条规则必须带 status：`observation_only | reviewed`。
 * - 只有 `reviewed` 的规则才允许输出"达到/未达到"这类判断。
 * - 没有适用参考或规则未审核时，禁止输出技术动作"合格"。
 * - `target_met` 仅表示当前训练约束达到，不表示整体动作正确。
 */

import type { FeatureValue, QualityState } from "@pingpong/contracts";
import { FEATURE_IDS } from "@pingpong/contracts";

export type RuleStatus = "observation_only" | "reviewed";

export interface RuleDefinition {
  id: string;
  version: string;
  strokeType: string;
  cameraViews: string[];
  focusId: string;
  /** 所需证据 */
  requiredFeatureIds: string[];
  /** 明确的不适用条件 */
  notApplicableWhen: string[];
  status: RuleStatus;
  /** 已审核参考来源。未审核时必须为 null。 */
  referenceId: string | null;
  /** 允许的短提示 */
  allowedCues: string[];
  /** 允许建议的下一练习 */
  allowedDrillIds: string[];
}

export interface RuleEvaluationInput {
  rule: RuleDefinition;
  features: FeatureValue[];
  /** 本组有效挥拍数 */
  validStrokeCount: number;
  /** 本组质量汇总是否达到可判门槛 */
  judgeable: boolean;
}

export type LocalVerdict =
  | { kind: "target_met"; cue: string; evidenceRefs: string[] }
  | { kind: "suggest_adjustment"; cue: string; evidenceRefs: string[] }
  | { kind: "observation_only"; observation: string; evidenceRefs: string[] }
  | { kind: "insufficient_evidence"; reason: string };

/**
 * 门槛：本组返回准备区时间的中位数上限。
 * 这是**训练约束**，不是"正确动作"标准。
 */
export interface ThresholdConfig {
  /** 本组关注目标：返回准备区时间的期望上限（毫秒） */
  returnAfterWristPeakMaxMs: number;
  /** 达到目标所需的最少有效挥拍数 */
  minValidStrokes: number;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  returnAfterWristPeakMaxMs: 700,
  minValidStrokes: 3,
};

function findFeature(features: FeatureValue[], id: string): FeatureValue | undefined {
  return features.find((f) => f.id === id);
}

/** 质量是否足以支撑精细结论。limited 不足以支撑数值判定。 */
function isUsableForJudgement(q: QualityState): boolean {
  return q === "usable";
}

/**
 * 评估本地规则。
 *
 * 返回 insufficient_evidence 时上层不应播报任何结论。
 */
export function evaluateRule(
  input: RuleEvaluationInput,
  thresholds: ThresholdConfig = DEFAULT_THRESHOLDS,
): LocalVerdict {
  const { rule, features, validStrokeCount, judgeable } = input;

  // 证据不足的各种情形，一律明确拒绝给结论
  if (!judgeable) {
    return {
      kind: "insufficient_evidence",
      reason: "本组画质未达到可判门槛，暂不判断目标",
    };
  }
  if (validStrokeCount < thresholds.minValidStrokes) {
    return {
      kind: "insufficient_evidence",
      reason: `有效挥拍 ${validStrokeCount} 次，少于所需 ${thresholds.minValidStrokes} 次`,
    };
  }

  for (const need of rule.requiredFeatureIds) {
    const f = findFeature(features, need);
    if (!f) {
      return {
        kind: "insufficient_evidence",
        reason: `缺少规则所需特征 ${need}`,
      };
    }
    if (f.value == null) {
      return {
        kind: "insufficient_evidence",
        reason: f.reasonIfMissing ?? `特征 ${need} 无可用测量值`,
      };
    }
  }

  // 回到准备区规则
  if (rule.focusId === "return_to_ready_zone") {
    const f = findFeature(features, FEATURE_IDS.RETURN_AFTER_WRIST_PEAK);
    if (!f || f.value == null) {
      return { kind: "insufficient_evidence", reason: "缺少返回准备区时间测量" };
    }

    // limited 质量不足以做数值判定，降为观察
    if (!isUsableForJudgement(f.quality)) {
      return {
        kind: "observation_only",
        observation: `本组返回准备区中位时间约 ${Math.round(f.value)} 毫秒，但该区间测量质量为 ${f.quality}，仅作观察。`,
        evidenceRefs: [f.id],
      };
    }

    // 未审核或没有适用参考时，只报告观察，禁止输出"达到/未达到"这类判定。
    // 这是硬约束：不能让一条尚未被教练认可的规则冒充结论。
    //
    // ⚠️ 这里**刻意只查两个字段**，而知识条目的门禁要查五项
    // （审核人／来源／许可／适用条件／参考片段 id，见 `apps/api/src/coach/knowledge.ts`）。
    // 差别在**信任模型**，不是严格程度：
    // - 知识条目是**内容文件**（`knowledge/*.json`），改它不需要改代码、不过 CI；
    // - 规则是**代码**（本文件的 `BUILTIN_RULES`），改它要走代码评审，
    //   溯源头是 `ruleVersion` 与 `docs/acceptance.md` 的阈值变更记录。
    // 所以不要"为了对称"往这里加同名字段 —— 那是给代码写的规则补一份没人填的凭据。
    if (rule.status !== "reviewed" || rule.referenceId == null) {
      return {
        kind: "observation_only",
        observation: `本组返回准备区中位时间约 ${Math.round(f.value)} 毫秒。当前关注点尚无已审核参考，因此只报告测量结果，不判断是否达标。`,
        evidenceRefs: [f.id],
      };
    }

    if (f.value <= thresholds.returnAfterWristPeakMaxMs) {
      return {
        kind: "target_met",
        cue: "保持这个节奏，回到准备区的时间在目标范围内。",
        evidenceRefs: [f.id],
      };
    }
    return {
      kind: "suggest_adjustment",
      cue: "击球后先把重心带回准备位置，然后再看下一拍。",
      evidenceRefs: [f.id],
    };
  }

  // 未审核规则只能输出观察
  if (rule.status === "observation_only") {
    const refs = rule.requiredFeatureIds.filter((id) => findFeature(features, id)?.value != null);
    return {
      kind: "observation_only",
      observation: "本关注点尚无已审核参考，仅报告本组测量结果。",
      evidenceRefs: refs,
    };
  }

  return {
    kind: "insufficient_evidence",
    reason: `规则 ${rule.id} 未覆盖关注点 ${rule.focusId}`,
  };
}

/** 首版规则集。内容与 knowledge/ 下条目一一对应。 */
export const BUILTIN_RULES: RuleDefinition[] = [
  {
    id: "return_to_ready_zone_v1",
    version: "1.0.0",
    strokeType: "forehand_drive",
    cameraViews: ["front", "front_left_diagonal", "front_right_diagonal", "right_side"],
    focusId: "return_to_ready_zone",
    requiredFeatureIds: [FEATURE_IDS.RETURN_AFTER_WRIST_PEAK],
    notApplicableWhen: [
      "未识别到可靠的腕部速度峰值",
      "回到准备区发生在速度峰值之前",
      "持拍侧手臂在本组内被遮挡",
    ],
    // 首版没有教练认可的参考片段 → 保持 observation_only，不输出"合格"
    status: "observation_only",
    referenceId: null,
    allowedCues: [
      "击球后先把重心带回准备位置，然后再看下一拍。",
      "保持这个节奏，回到准备区的时间在目标范围内。",
    ],
    allowedDrillIds: ["shadow_forehand_return_ready", "multi_ball_forehand_rhythm"],
  },
];
