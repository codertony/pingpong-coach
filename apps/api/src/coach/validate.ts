/**
 * 模型输出校验。
 *
 * 方案第 9.4 节的硬要求：
 * 「服务端必须实际检查 ID、schema、目标匹配和参考审核状态，
 *   不能只依赖提示词。结构错误、伪造证据引用、旧会话响应或不允许的
 *   训练项，均不直接播报。」
 *
 * 另：模型输出中出现禁止的发力结论，应拒绝或降为待复查；
 * 不要把正则过滤等同于完整事实核查 —— 语义准确性还要通过人工标注集评估。
 */

import type { CoachFeedback, EvidencePacket } from "@pingpong/contracts";
import { errorCodeSchema } from "@pingpong/contracts";
import { z } from "zod";
import type { AllowedOutputs } from "./knowledge.js";

const MAX_CUE_CHARS = 30;

/** 模型被要求返回的原始结构。仅做形状校验，语义另查。 */
export const modelOutputSchema = z.object({
  status: z.enum([
    "target_met",
    "suggest_adjustment",
    "observation_only",
    "insufficient_evidence",
  ]),
  observation: z.string(),
  evidenceRefs: z.array(z.string()),
  cue: z.string().nullable(),
  nextDrillId: z.string().nullable(),
  limitations: z.array(z.string()),
});

export type ModelOutput = z.infer<typeof modelOutputSchema>;

export type ValidationIssueCode =
  | "model_invalid_json"
  | "evidence_ref_unknown"
  | "stale_session_response"
  | "disallowed_drill"
  | "reference_not_reviewed"
  | "model_forbidden_claim";

export interface ValidationIssue {
  code: ValidationIssueCode;
  detail: string;
}

export interface ValidationOutcome {
  /** 校验通过后可用于播报的反馈；被拒绝时为 null */
  feedback: Omit<
    CoachFeedback,
    "modelId" | "mock" | "serverElapsedMs" | "createdAtMonoMs"
  > | null;
  issues: ValidationIssue[];
  /** 被拒绝或降级的禁用语结论 */
  rejectedClaims: string[];
}

/**
 * 语义禁用语检查。
 *
 * 这些结论无法由单目二维骨架支撑，出现即拒绝或降级。
 * 明确说明：这只是粗筛，**不等于**事实核查。
 */
const FORBIDDEN_CLAIM_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /肌肉(紧张|僵硬|发力|力量)/, label: "肌肉发力或紧张" },
  { pattern: /足底(承重|压力)/, label: "足底承重" },
  { pattern: /(力量|能量)(传递|传导)(效率|顺序)/, label: "力量传递效率" },
  { pattern: /击球(瞬间|时刻)(的)?(力量|大小)/, label: "击球力量大小" },
  { pattern: /(确定|精确)(的)?拍面(角度|朝向)/, label: "精确拍面姿态" },
  { pattern: /(毫米|毫秒)级(的)?(传力|顺序)/, label: "毫秒级传力顺序" },
];

export function scanForbiddenClaims(text: string): string[] {
  const hits: string[] = [];
  for (const { pattern, label } of FORBIDDEN_CLAIM_PATTERNS) {
    if (pattern.test(text)) hits.push(label);
  }
  return hits;
}

/**
 * 校验模型输出。
 *
 * @param raw 模型返回的已解析对象（未通过 schema 时传 null）
 * @param packet 本次证据包，用于核对 evidenceRefs
 * @param allowed 允许的提示与训练项
 * @param expected 期望的会话标识，用于拒绝旧会话响应
 */
export function validateModelOutput(
  raw: unknown,
  packet: EvidencePacket,
  allowed: AllowedOutputs,
  expected: { sessionId: string; groupId: string; focusId: string; requestId: string },
): ValidationOutcome {
  const issues: ValidationIssue[] = [];

  const parsed = modelOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      feedback: null,
      issues: [
        {
          code: "model_invalid_json",
          detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      ],
      rejectedClaims: [],
    };
  }
  const out = parsed.data;

  // 可引用 ID 集合：测量值 ID ∪ 关键帧 ID
  const knownIds = new Set<string>([
    ...packet.features.map((f) => f.id),
    ...packet.keyframes.map((k) => k.id),
    ...packet.strokes.map((s) => s.strokeId),
  ]);

  // 1) evidenceRefs 必须全部存在，杜绝伪造引用
  const unknownRefs = out.evidenceRefs.filter((r) => !knownIds.has(r));
  if (unknownRefs.length > 0) {
    issues.push({
      code: "evidence_ref_unknown",
      detail: `引用了证据包中不存在的 ID：${unknownRefs.join(", ")}`,
    });
  }

  // 2) 未给任何证据引用却又输出结论，也是不合格的
  if (
    out.evidenceRefs.length === 0 &&
    (out.status === "target_met" || out.status === "suggest_adjustment")
  ) {
    issues.push({
      code: "evidence_ref_unknown",
      detail: "输出达标/调整结论但未引用任何证据",
    });
  }

  // 3) 目标必须与本组关注点一致
  if (packet.focusId !== expected.focusId) {
    issues.push({
      code: "stale_session_response",
      detail: `反馈关注点 ${packet.focusId} 与请求关注点 ${expected.focusId} 不一致`,
    });
  }
  if (packet.sessionId !== expected.sessionId || packet.groupId !== expected.groupId) {
    issues.push({
      code: "stale_session_response",
      detail: "证据包会话或分组与请求不一致，判定为陈旧响应",
    });
  }

  // 4) 下一练习必须在允许集合内
  if (out.nextDrillId != null && !allowed.drillIds.includes(out.nextDrillId)) {
    issues.push({
      code: "disallowed_drill",
      detail: `下一练习 ${out.nextDrillId} 不在允许的训练项中`,
    });
  }

  // 5) 反馈中引用的参考必须已审核
  if (
    (out.status === "target_met" || out.status === "suggest_adjustment") &&
    !allowed.hasReviewedReference
  ) {
    issues.push({
      code: "reference_not_reviewed",
      detail: "没有已审核参考，不得输出达标或调整结论",
    });
  }

  // 6) 禁用语结论
  const rejectedClaims = scanForbiddenClaims(`${out.observation}\n${out.cue ?? ""}`);

  // 硬性错误：直接拒绝播报
  const hardCodes: ValidationIssueCode[] = [
    "model_invalid_json",
    "evidence_ref_unknown",
    "stale_session_response",
    "disallowed_drill",
  ];
  const hasHard = issues.some((i) => hardCodes.includes(i.code));
  if (hasHard) {
    return { feedback: null, issues, rejectedClaims };
  }

  // 软性问题：降级为观察，并保留问题记录
  let status = out.status;
  const limitations = [...out.limitations];
  if (rejectedClaims.length > 0) {
    issues.push({
      code: "model_forbidden_claim",
      detail: `模型输出含无法由二维骨架支撑的结论：${rejectedClaims.join("、")}`,
    });
    status = "observation_only";
    limitations.push("模型原始输出包含无法验证的发力类结论，已降级为观察");
  }
  if (status !== "observation_only" && status !== "insufficient_evidence" && !allowed.hasReviewedReference) {
    issues.push({
      code: "reference_not_reviewed",
      detail: "无已审核参考，降级为 observation_only",
    });
    status = "observation_only";
    limitations.push("当前关注点尚无已审核参考，本次不判断是否达标");
  }

  // cue 只允许来自允许集合
  let cue = out.cue;
  if (cue != null) {
    if (!allowed.cues.includes(cue)) {
      limitations.push("模型给出的提示不在允许集合中，已移除");
      cue = null;
    } else if ([...cue].length > MAX_CUE_CHARS) {
      limitations.push(`提示超过 ${MAX_CUE_CHARS} 字上限，已移除以适配语音播报`);
      cue = null;
    }
  }

  // 训练项在软性问题下也需要复核
  const nextDrillId = out.nextDrillId;

  return {
    feedback: {
      schemaVersion: packet.schemaVersion,
      requestId: expected.requestId,
      sessionId: packet.sessionId,
      groupId: packet.groupId,
      focusId: packet.focusId,
      status,
      observation: out.observation,
      evidenceRefs: out.evidenceRefs,
      cue,
      nextDrillId,
      limitations,
      rejectedClaims,
    },
    issues,
    rejectedClaims,
  };
}

/** 便于日志输出：把 issue 转成带错误码的行。 */
export function formatIssues(issues: ValidationIssue[]): string[] {
  return issues.map((i) => {
    const code = errorCodeSchema.safeParse(i.code);
    return `[${code.success ? code.data : "internal_error"}] ${i.detail}`;
  });
}
