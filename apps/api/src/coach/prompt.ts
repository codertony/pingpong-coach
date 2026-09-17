/**
 * 提示词构建（方案第 9.4 节）。
 *
 * 提示词只是一道防线，**不能只依赖它**。
 * 服务端必须实际检查 ID、schema、目标匹配和参考审核状态。
 */

import type { EvidencePacket, PhaseEvent } from "@pingpong/contracts";
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
  "keyPoints": string[],          // 2~5 条要点，每条一句具体结论（见下）
  "evidenceRefs": string[],       // 必须是本次证据包中存在的 id
  "cue": string | null,           // 最多一条短提示，不超过 30 个汉字（这句会被念出来）
  "nextDrillId": string | null,   // 只能来自允许的训练项
  "limitations": string[]         // 本次结论的边界
}`;

/**
 * 逐条要点的写法。
 *
 * 为什么单独写这么一段：`observation` 是一段话，模型很容易写成
 * "整体节奏还可以，注意回位"这种**没有信息量**的复述。
 * 要点是逐条的，就能要求它**每条对准一个测量**，也便于用户逐条核对。
 */
const KEY_POINT_RULES = `# keyPoints 怎么写
- 2~5 条，**每条只说一件事**（不超过 60 字）。细节多的就多列一条，不要挤成一段。
- 每条都要能对上本包里的某个测量或关键帧，写清"哪个量、多少、与门槛差多少"。
  反例（没有信息量，不要写）："动作不错""注意回位""节奏还需加强"。
- 不要与 observation 重复：observation 讲整体印象，keyPoints 讲具体事实。
- 只写证据支持得了的事；不确定就写"不确定"，不要替它补全。
- 不许出现发力大小、肌肉紧张、足底承重、力量传递效率这类结论。`;

/**
 * 渲染**本关注点所用的判据**（测量口径与门槛）。
 *
 * 用户明确要求"把本地规则的实测结论喂给模型"，这样它才能围绕具体判据讲话，
 * 而不是泛泛说一段。（此前模型只拿到测量值，不知道门槛是多少，
 * 于是只能说"回位稍慢"这种没有参照系的话。）
 *
 * 数值来自 `packet.criterion` —— 由发起端按**它实际在用的**阈值填入
 * （判据数值住在 motion-core，而服务端只依赖 contracts，见 AGENTS.md 依赖方向）。
 * 服务端在这里**只做措辞**，不重算、不推断。
 *
 * ⚠️ 刻意**不给**"本地规则判定为达标/未达标"：那个判定还依赖画面质量是否达到
 * 可判门槛，而质量结论不在证据包里。服务端只能去猜，猜错了就会给模型一个
 * **与界面自相矛盾**的结论 —— 那比不给更糟。达标与否仍由模型根据证据判断。
 */
function renderFocusCriterion(packet: EvidencePacket): string {
  const c = packet.criterion;
  if (c == null) {
    return `（本关注点 ${packet.focusId} 没有可陈述的程序门槛 —— 不得输出达标结论）`;
  }
  return [
    `关注点 ${packet.focusId} 采用的测量：${c.featureId}（数值见上面的测量表）`,
    `训练门槛：${c.featureId} ≤ ${c.threshold}${c.unit}，` +
      `且有效挥拍 ≥ ${c.minValidStrokes} 次（这是**训练约束**，不是"动作正确"的标准）`,
  ].join("\n");
}

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
      if (e.notApplicable.length > 0) lines.push(`  不适用/易混淆：${e.notApplicable.join("；")}`);
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

/**
 * 渲染**逐板**测量值（R5）。
 *
 * 为什么单列一段：模型此前只拿到**组级标量**（"本组中位数 880ms"），
 * 于是它只能讲"整体节奏"这类没有落点的话 —— 不是它不肯说细，是**没人给它逐板的数**。
 * 而这些数本来就在手里，只是在聚合时被丢掉了。
 *
 * 每板都标上「第 N 板 + strokeId + 起止」，这样模型引用时能指向具体哪一板。
 * 缺失照样带原因：`无可用值（原因：…）` —— 不写成 0（红线 1）。
 */
function renderPerStroke(packet: EvidencePacket): string {
  if (packet.strokes.length === 0) return "（本组无有效挥拍）";
  const byStroke = new Map(packet.perStrokeFeatures.map((e) => [e.strokeId, e.features]));
  return packet.strokes
    .map((s, i) => {
      const values = byStroke.get(s.strokeId) ?? [];
      const body =
        values.length === 0
          ? "（本板无可用测量）"
          : values
              .map((f) =>
                f.value == null
                  ? `${f.id}=无可用值（原因：${f.reasonIfMissing ?? "未说明"}），缺失不等于 0`
                  : `${f.id}=${f.value} ${f.unit}（质量=${f.quality}）`,
              )
              .join("；");
      return `- 第 ${i + 1} 板 ${s.strokeId}（${s.startMs}–${s.endMs ?? "未闭合"}ms）：${body}`;
    })
    .join("\n");
}

/** 事件类型的中文说法。给模型看的是意思，不是我们的字段名。 */
const EVENT_LABEL: Record<PhaseEvent["eventType"], string> = {
  backswing_start: "引拍开始",
  forward_start: "前挥开始",
  return_start: "还原开始",
  stroke_closed: "本板闭合",
};

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
      /*
       * 这一板的**过程**（R4）。没有它，模型只能对首尾两端讲话 ——
       * "引拍拖太久""前挥来得太晚"这类话都无从说起，因为没人告诉它分段在哪。
       */
      parts.push(
        s.phaseEvents.length > 0
          ? `过程=${s.phaseEvents.map((e) => `${EVENT_LABEL[e.eventType]}@${e.timeMs}ms`).join(" → ")}`
          : "过程=（未记录到阶段转变）",
      );
      return parts.join(" | ");
    })
    .join("\n");
}

/**
 * 一张关键帧在提示词里的说头。
 *
 * 板号与「距事件偏移」都是 R4 加的：在此之前每张图只有 `角色=forward`，
 * 而"forward"当时只是**按区间时间比例挑的位置**，不是任何事件 ——
 * 模型分不出「前挥刚开始那一刻」与「前挥中段」，也不知道这张图属于哪一板
 * （一组最多 4 板、二十几张图，只能靠时间戳猜）。
 *
 * 现在每张图都锚在**检出的阶段转变**上，偏移就是它与那一刻的差：
 * - `恰在转变时刻` = 就取在事件上；
 * - `距事件 +220ms` = 同一相位内靠后（典型是腕速峰值帧）。
 *
 * 锚点是腕部速度峰值而**不是击球**（红线 2），所以文案里一律说「事件」，
 * 不说「击球」。
 */
function renderKeyframeLine(k: EvidencePacket["keyframes"][number]): string {
  const offset =
    k.eventTimeOffsetMs === 0
      ? "恰在转变时刻"
      : `距事件 ${k.eventTimeOffsetMs > 0 ? "+" : ""}${k.eventTimeOffsetMs}ms`;
  return `- ${k.id} @${k.sourceTimeMs}ms，板=${k.strokeId}，角色=${k.role}，${offset}，${k.width}x${k.height}`;
}

export function buildPrompt(
  packet: EvidencePacket,
  entries: KnowledgeEntry[],
  allowed: AllowedOutputs,
): PromptPayload {
  const keyframeList = packet.keyframes.map(renderKeyframeLine).join("\n");

  const user = `# 本次训练任务
动作类型：${packet.strokeType}
持拍手：${packet.handedness}
机位：${packet.cameraView}
本组关注点：${packet.focusId}
规则版本：${packet.ruleVersion}
参考片段：${packet.referenceId ?? "无（不得输出技术动作「合格」）"}

# 本组挥拍
（"过程"里的时刻来自分段状态机的**阶段转变**，不是击球时刻；本组**没有**触球与随挥事件）
${renderStrokes(packet)}

# 逐板测量值（每一板各自的数 —— 要讲"哪一板"就用这里的）
${renderPerStroke(packet)}

# 程序测量值（组级汇总）
${renderFeatures(packet)}

# 本关注点的判据（程序口径与门槛 —— 这是给你对齐语言用的，不是给你的结论）
${renderFocusCriterion(packet)}

# 可用原始关键帧
每张图都锚在**检出的阶段转变**上：「板=」是它属于哪一板（就是上面挥拍列表每行的 strokeId），
「恰在转变时刻」表示这一张就取在那个事件上，「距事件 +Nms」表示同一相位内偏后 N 毫秒。
本组**没有触球与随挥事件**，所以任何一张图都**不是**击球瞬间的照片。
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

${KEY_POINT_RULES}

${OUTPUT_SCHEMA_HINT}`;

  return { system: SYSTEM_PROMPT, user };
}
