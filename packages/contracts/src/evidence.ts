import { z } from "zod";
import { schemaVersionSchema, strokeTypeSchema } from "./primitives.js";
import { strokeEventSchema } from "./stroke.js";
import { featureValueSchema } from "./feature.js";

/**
 * 发送给模型服务的一张原始关键帧。
 *
 * 预算（见方案 9.2）：最多 6 张，优先覆盖引拍/向前挥拍/还原；
 * 按目标部位裁剪并保留必要身体背景；初始最长边不超过 960 像素。
 * 图片压缩导致目标关节不清晰时，必须降低该目标的可判性，
 * 不能为了满足大小预算继续给精细判断。
 */
export const evidenceKeyframeSchema = z.object({
  id: z.string().min(1),
  sourceTimeMs: z.number().finite().nonnegative(),
  /** JPEG base64，不含 data URL 前缀。 */
  jpegBase64: z.string().min(1),
  /** 该帧在姿态链路中的 frameId，用于与数值严格对齐。 */
  frameId: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** 该帧被选中的理由，例如 backswing / forward / return。 */
  role: z.enum(["backswing", "forward", "return", "ready", "other"]),
});

export type EvidenceKeyframe = z.infer<typeof evidenceKeyframeSchema>;

/**
 * 证据包：前端已准备好的、自包含的一次分析输入。
 *
 * 关键约束：
 * - keyframes[].frameId 必须与 strokes[].evidenceFrameIds 对齐，
 *   不能拿后来的图片配前一帧骨架。**这条由下面的 `.refine` 强制**
 *   （以前只是注释，见 F-029）。
 * - limitations 必须显式列出本次无法判断的内容，
 *   让模型和用户都知道边界在哪。
 */
export const evidencePacketSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    groupId: z.string().min(1),
    focusId: z.string().min(1),
    // 复用 primitives 中的定义，避免同一约束在两处各写一遍后走样。
    strokeType: strokeTypeSchema,
    handedness: z.enum(["left", "right"]),
    cameraView: z.string().min(1),
    strokes: z.array(strokeEventSchema),
    features: z.array(featureValueSchema),
    keyframes: z.array(evidenceKeyframeSchema),
    ruleVersion: z.string().min(1),
    /** 参考片段 ID。null 表示本轮没有适用参考，只能观察。 */
    referenceId: z.string().nullable(),
    limitations: z.array(z.string()),
    /** 本组的准备区定义，作为明确训练约束而非姿势认可。 */
    readyZone: z
      .object({
        xPx: z.number().finite(),
        yPx: z.number().finite(),
        radiusPx: z.number().finite().positive(),
      })
      .nullable(),
  })
  /**
   * 关键帧必须属于某一板挥拍的证据帧。
   *
   * 上面那条"必须对齐"原先**只是注释**：schema 里没有任何东西执行它
   * （`keyframes` 只是个普通数组）。后果不只是文档没落实 ——
   * 服务端的 `validate.ts` 会把关键帧 id 并进**可引用集合**，
   * 于是模型可以引用一张**不属于它正在讲的那一板**的图。
   *
   * 改成 `.refine` 让"必须"成为真的：不对齐的包直接判不合法。
   * 客户端侧也已收窄候选（只从本板证据帧里挑，见 F-029），正常链路不会撞上它。
   */
  .refine(
    (p) => {
      const evidenceIds = new Set(p.strokes.flatMap((s) => s.evidenceFrameIds));
      return p.keyframes.every((k) => evidenceIds.has(k.frameId));
    },
    {
      message:
        "keyframes[].frameId 必须与 strokes[].evidenceFrameIds 对齐 —— 不能拿后来的图片配前一帧骨架",
      path: ["keyframes"],
    },
  );

export type EvidencePacket = z.infer<typeof evidencePacketSchema>;

/**
 * 反馈状态。
 *
 * target_met 仅表示**当前训练约束**达到，不表示整体动作正确。
 * 没有适用参考或规则未审核时，禁止输出技术动作"合格"。
 */
export const feedbackStatusSchema = z.enum([
  "target_met",
  "suggest_adjustment",
  "observation_only",
  "insufficient_evidence",
]);

export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;

/**
 * 模型输出经服务端校验后的最终反馈。
 */
export const coachFeedbackSchema = z.object({
  schemaVersion: schemaVersionSchema,
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  groupId: z.string().min(1),
  focusId: z.string().min(1),
  status: feedbackStatusSchema,
  /** 一段观察。 */
  observation: z.string(),
  /** 必须引用本包中的测量/图片 ID。服务端强制校验。 */
  evidenceRefs: z.array(z.string()),
  /** 一条短提示，语音播报用。null 表示本轮不给提示。 */
  cue: z.string().nullable(),
  /** 下一练习 ID，只能来自允许的训练项。 */
  nextDrillId: z.string().nullable(),
  limitations: z.array(z.string()),
  /** 产生该反馈的模型标识，便于评估与费用归因。 */
  modelId: z.string(),
  /** mock 模式标记。绝不用 mock 结果填充真实延迟或准确率。 */
  mock: z.boolean(),
  /** 服务端处理的耗时，单位为毫秒。 */
  serverElapsedMs: z.number().finite().nonnegative(),
  /** 被拒绝或降级的禁用语结论，用于评估提示词效果。 */
  rejectedClaims: z.array(z.string()),
  createdAtMonoMs: z.number().finite().nonnegative(),
});

export type CoachFeedback = z.infer<typeof coachFeedbackSchema>;
