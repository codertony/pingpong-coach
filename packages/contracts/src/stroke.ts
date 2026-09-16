import { z } from "zod";

/**
 * 事件锚点。
 *
 * 首版锚点是腕部速度峰值。它**不是**已确认的击球时刻：
 * 未可靠识别球拍接触球之前，不得把指标命名为 recovery_after_impact_ms。
 */
export const strokeAnchorSchema = z.object({
  type: z.enum(["wrist_speed_peak", "impact_confirmed", "manual"]),
  timeMs: z.number().finite().nonnegative(),
});

export type StrokeAnchor = z.infer<typeof strokeAnchorSchema>;

/**
 * 阶段事件：这一板的**过程**，而不只是首尾两端。
 *
 * ## 为什么必须有它（外部评审 R4/R5）
 *
 * 在此之前，证据里只有"这一板从 1200ms 到 1900ms"和两个组级/逐板标量 ——
 * 模型没法说"引拍拖得太久""前挥来得太晚"，因为**没人告诉它这一板分几段、
 * 每段从何时开始**。而分段器**本来就知道**：它每一步都在切换阶段，
 * 只是那些时刻从来没被送出去。
 *
 * ## 事件是按**实际发生**记录的，不是一个固定模板
 *
 * 一次挥拍可能反复拉锯（回到区内但没稳住、又拉出去重来），
 * 所以这是一条**有序的转变序列**，长度不固定、可能重复。
 * 不要假设"每次挥拍都是四个事件"。
 *
 * ## 这里**没有**的东西，以及为什么
 *
 * - **没有触球事件**：单目二维没有可靠接触证据，红线 2 明确禁止把腕速峰值
 *   改名叫击球。评审 §6.1 也说首版可以完全不判触球。
 * - **没有随挥末端**：现在的状态机不产生这个转变，不编。
 * - **没有 confidence**：分段器**不产出概率**。给一个编出来的 0.8 比不给更糟
 *   （红线 1 的同一条精神：`null`/缺失是"不知道"，不是"不信"）。
 *   将来真有了带分数的事件检测器，再加这个字段 —— 现在加就是**没有读者的死字段**。
 * - **没有 method**：当前只有一种来源（阶段转变）。这个事实写在证据包的
 *   `limitations` 里说一次，不必在每个事件上重复。
 */
const phaseEventSchema = z.object({
  /**
   * 事件类型。**只覆盖分段器真实产生的转变**：
   * 离开准备区（引拍开始）、确认回身并加速向回（前挥开始）、
   * 重新进入准备区（还原开始）、在区内稳定驻留够久（这一板闭合）。
   */
  eventType: z.enum(["backswing_start", "forward_start", "return_start", "stroke_closed"]),
  /** 事件时刻（源时间，毫秒）。 */
  timeMs: z.number().finite().nonnegative(),
  /**
   * 支撑该事件的帧 id。
   *
   * 有它，事件才是**可核查**的：拿到时刻之后能直接回到那一帧去看。
   * 也让"事件定位"与"展示关键帧"能分开评估（评审 §6.2）——
   * 事件准不准与图清不清晰是两件事。
   */
  supportFrameIds: z.array(z.string()),
});

export type PhaseEvent = z.infer<typeof phaseEventSchema>;

/**
 * 一次挥拍分段。
 * endMs 为 null 表示尚未闭合（仍在进行或异常结束）。
 */
export const strokeEventSchema = z
  .object({
    strokeId: z.string().min(1),
    startMs: z.number().finite().nonnegative(),
    endMs: z.number().finite().nonnegative().nullable(),
    anchor: strokeAnchorSchema,
    /** 仅当锚点类型为 impact_confirmed 且有可靠接触证据时才非 null。 */
    impactTimeMs: z.number().finite().nonnegative().nullable(),
    /** 只有完整走完 准备→引拍→向前→回到准备区 才为 true。 */
    complete: z.boolean(),
    /**
     * 这一板的阶段事件，**按时间递增**（由 `.refine` 强制）。
     *
     * 与挥拍**一一对应**：事件嵌在挥拍里，而不是放在顶层再靠 strokeId 关联 ——
     * 这样"事件属于哪一板"是结构上保证的，不需要再写一条跨字段的约束去守
     * （本仓库已经为这类"必须对应"写过三条 refine 了，能不写就不写）。
     */
    phaseEvents: z.array(phaseEventSchema),
    /** 该次挥拍所用到的证据帧 ID，必须能回指到真实帧。 */
    evidenceFrameIds: z.array(z.string()),
    /** 不完整或低质量时的原因。 */
    reasons: z.array(z.string()),
  })
  /**
   * 事件必须按时间递增。
   *
   * 这条不是洁癖：事件序列是"过程"，顺序错了就等于把过程讲反了
   * （"先前挥再引拍"）。乱序在一维数组里读起来完全正常，肉眼看不出来，
   * 所以必须由 schema 守。
   */
  .refine(
    (s) => s.phaseEvents.every((e, i) => i === 0 || e.timeMs >= s.phaseEvents[i - 1]!.timeMs),
    {
      message: "phaseEvents 必须按 timeMs 递增 —— 顺序错了等于把过程讲反了",
      path: ["phaseEvents"],
    },
  );

export type StrokeEvent = z.infer<typeof strokeEventSchema>;

/** 状态机阶段。可解释状态机，首版不使用动作分类模型。 */
export const strokePhaseSchema = z.enum([
  "idle",
  "ready",
  "backswing",
  "forward",
  "returning",
  "aborted",
]);

export type StrokePhase = z.infer<typeof strokePhaseSchema>;

/** 分段配置。方向必须与机位、持拍手一起配置。 */
export const segmentationConfigSchema = z.object({
  strokeType: z.string().min(1),
  cameraView: z.string().min(1),
  handedness: z.enum(["left", "right"]),
  /** 准备区半径，单位为体尺度比例（不是厘米）。 */
  readyZoneRadiusBodyScale: z.number().positive(),
  /** 进入准备区后需要稳定的最短时间，防抖。 */
  readyStableMinMs: z.number().positive(),
  /** 离开准备区的最小位移，用于确认引拍开始。 */
  backswingMinDisplacementBodyScale: z.number().positive(),
  /** 判定向前挥拍所需的最小速度，单位为体尺度/秒。 */
  forwardMinSpeedBodyScalePerSec: z.number().positive(),
  /** 回到准备区后需要保持的时间，确认该次挥拍闭合。 */
  returnStableMinMs: z.number().positive(),
  /** 采样间断超过此值即标记不完整。 */
  maxGapMs: z.number().positive(),
  /** 一次挥拍的最大允许时长，超过即异常结束。 */
  maxStrokeDurationMs: z.number().positive(),
});

export type SegmentationConfig = z.infer<typeof segmentationConfigSchema>;
