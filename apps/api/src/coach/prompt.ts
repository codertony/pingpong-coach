/**
 * 提示词构建（方案第 9.4 节）。
 *
 * 提示词只是一道防线，**不能只依赖它**。
 * 服务端必须实际检查 ID、schema、目标匹配和参考审核状态。
 */

import type { EvidencePacket } from "@pingpong/contracts";
import type { AllowedOutputs, KnowledgeEntry } from "./knowledge.js";

/** 系统提示词。逐条对应方案 9.4 的约束。 */
export const SYSTEM_PROMPT = `你是乒乓球动作观察与训练辅助程序。只评价本组当前关注点。
用所给测量、原始关键帧和适用知识组织结论；观察、推测和不可判断要区分。
不把单目骨架解释为肌肉紧张、肌肉发力大小、足底承重或确定的力量传递效率。
不把 wrist_speed_peak 当作已确认的击球时刻。
缺失数据不是零，低质量片段不能用于精细判断。
没有适用的已审核参考时，使用 observation_only；证据不足使用 insufficient_evidence。
只返回约定 JSON；evidenceRefs 必须来自本次证据包；最多给一条短提示。
下一练习只能从本次允许的训练项中选择；不适用时返回 null。`;

/** 模型必须返回的 JSON 结构说明。 */
export const OUTPUT_SCHEMA_HINT = `只返回如下 JSON，不要包含任何解释文字或 Markdown 代码块：
{
  "status": "target_met" | "suggest_adjustment" | "observation_only" | "insufficient_evidence",
  "observation": string,          // 一段观察，区分事实与推测
  "evidenceRefs": string[],       // 必须是本次证据包中存在的 id
  "cue": string | null,           // 最多一条短提示，不超过 30 个汉字
  "nextDrillId": string | null,   // 只能来自允许的训练项
  "limitations": string[]         // 本次结论的边界
}`;

export interface PromptPayload {
  system: string;
  user: string;
}

/** 把知识条目转成紧凑的文本块，避免把整份知识塞进提示词。 */
function renderKnowledge(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) return "（本轮无适用的已审核知识）";
  return entries
    .map((e) => {
      const lines = [
        `- 条目 ${e.id} v${e.version}（审核状态：${e.status}）`,
        `  背景：${e.context}`,
      ];
      if (e.observable.length > 0) lines.push(`  可观察：${e.observable.join("；")}`);
      if (e.notApplicable.length > 0)
        lines.push(`  不适用/易混淆：${e.notApplicable.join("；")}`);
      return lines.join("\n");
    })
    .join("\n");
}

/** 把测量值渲染成文本。缺失值必须写明原因，不能写成 0。 */
function renderFeatures(packet: EvidencePacket): string {
  if (packet.features.length === 0) return "（无测量值）";
  return packet.features
    .map((f) => {
      if (f.value == null) {
        return `- ${f.id}: 无可用值（原因：${f.reasonIfMissing ?? "未说明"}），质量=${f.quality}`;
      }
      return `- ${f.id}: ${f.value} ${f.unit}（坐标空间=${f.coordinateSpace}，质量=${f.quality}，区间=${f.intervalMs[0]}–${f.intervalMs[1]}ms）`;
    })
    .join("\n");
}

function renderStrokes(packet: EvidencePacket): string {
  if (packet.strokes.length === 0) return "（本组无有效挥拍）";
  return packet.strokes
    .map((s) => {
      const parts = [
        `- ${s.strokeId}: ${s.startMs}–${s.endMs ?? "未闭合"}ms`,
        `锚点=${s.anchor.type}@${s.anchor.timeMs}ms`,
        s.complete ? "完整" : "不完整",
      ];
      if (s.reasons.length > 0) parts.push(`问题=${s.reasons.join(",")}`);
      return parts.join(" | ");
    })
    .join("\n");
}

export function buildPrompt(
  packet: EvidencePacket,
  entries: KnowledgeEntry[],
  allowed: AllowedOutputs,
): PromptPayload {
  const keyframeList = packet.keyframes
    .map(
      (k) =>
        `- ${k.id} @${k.sourceTimeMs}ms，角色=${k.role}，${k.width}x${k.height}`,
    )
    .join("\n");

  const user = `# 本次训练任务
动作类型：${packet.strokeType}
持拍手：${packet.handedness}
机位：${packet.cameraView}
本组关注点：${packet.focusId}
规则版本：${packet.ruleVersion}
参考片段：${packet.referenceId ?? "无（不得输出技术动作「合格」）"}

# 本组挥拍
${renderStrokes(packet)}

# 程序测量值
${renderFeatures(packet)}

# 可用原始关键帧
${keyframeList || "（无关键帧）"}

# 适用知识
${renderKnowledge(entries)}

# 输出约束
允许的提示（cue 必须从此列表选择，或为 null）：
${allowed.cues.length > 0 ? allowed.cues.map((c) => `- ${c}`).join("\n") : "（无，cue 必须为 null）"}

允许的下一练习（nextDrillId 必须从此列表选择，或为 null）：
${allowed.drillIds.length > 0 ? allowed.drillIds.map((d) => `- ${d}`).join("\n") : "（无，nextDrillId 必须为 null）"}

本轮是否存在已审核参考：${allowed.hasReviewedReference ? "是" : "否（必须使用 observation_only，不得判断达标）"}

# 本组已知限制
${packet.limitations.length > 0 ? packet.limitations.map((l) => `- ${l}`).join("\n") : "（无）"}

${OUTPUT_SCHEMA_HINT}`;

  return { system: SYSTEM_PROMPT, user };
}
