/**
 * 契约一致性测试。
 *
 * 已有 contracts.test.ts 验证「单个 schema 接受/拒绝什么」。
 * 这个文件验证的是不同 schema **之间**的一致性 ——
 * 枚举、版本号、错误码是否在多个定义处保持同步。
 *
 * 这类问题不会让任何单个测试失败，但会让上下游静默脱节。
 */

import { describe, expect, it } from "vitest";
import {
  CAMERA_VIEWS,
  ERROR_CODES,
  FOCUS_IDS,
  KEYPOINT_NAMES,
  RULE_VERSION,
  SCHEMA_VERSION,
  cameraViewSchema,
  evidencePacketSchema,
  featureSetSchema,
  focusIdSchema,
  keypointNameSchema,
  schemaVersionSchema,
  strokeTypeSchema,
  errorCodeSchema,
  qualityStateSchema,
  handednessSchema,
} from "../src/index.js";

describe("版本常量", () => {
  it("SCHEMA_VERSION 是字符串且非空", () => {
    expect(typeof SCHEMA_VERSION).toBe("string");
    expect(SCHEMA_VERSION.length).toBeGreaterThan(0);
  });

  it("RULE_VERSION 采用语义化三段式", () => {
    expect(RULE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("schemaVersionSchema 实际接受当前 SCHEMA_VERSION", () => {
    expect(schemaVersionSchema.safeParse(SCHEMA_VERSION).success).toBe(true);
  });

  it("schemaVersionSchema 拒绝其他版本号（防止未来版本被误当当前）", () => {
    expect(schemaVersionSchema.safeParse("999").success).toBe(false);
    expect(schemaVersionSchema.safeParse(SCHEMA_VERSION + "x").success).toBe(false);
  });

  it("featureSetSchema 的 schemaVersion 跟随 SCHEMA_VERSION（不是硬编码）", () => {
    // 这条锁死一个曾经的隐患：feature.ts 里写的是 z.literal("1")，
    // 一旦 SCHEMA_VERSION 提升，这里就会静默脱节。
    const ok = featureSetSchema.safeParse({
      schemaVersion: SCHEMA_VERSION,
      sessionId: "s",
      groupId: "g",
      strokeIds: [],
      features: [],
      computedAtMonoMs: 0,
    });
    expect(ok.success).toBe(true);

    const bad = featureSetSchema.safeParse({
      schemaVersion: "definitely-not-current",
      sessionId: "s",
      groupId: "g",
      strokeIds: [],
      features: [],
      computedAtMonoMs: 0,
    });
    expect(bad.success).toBe(false);
  });
});

describe("枚举数组与 Zod enum 保持同步", () => {
  it("KEYPOINT_NAMES 与 keypointNameSchema 接受的集合一致", () => {
    for (const name of KEYPOINT_NAMES) {
      expect(keypointNameSchema.safeParse(name).success).toBe(true);
    }
    expect(keypointNameSchema.safeParse("landmark_99").success).toBe(false);
  });

  it("CAMERA_VIEWS 与 cameraViewSchema 一致", () => {
    for (const v of CAMERA_VIEWS) {
      expect(cameraViewSchema.safeParse(v).success).toBe(true);
    }
    expect(cameraViewSchema.safeParse("top_down").success).toBe(false);
  });

  it("FOCUS_IDS 与 focusIdSchema 一致", () => {
    for (const f of FOCUS_IDS) {
      expect(focusIdSchema.safeParse(f).success).toBe(true);
    }
    expect(focusIdSchema.safeParse("nonexistent_focus").success).toBe(false);
  });

  it("ERROR_CODES 与 errorCodeSchema 一致，且无重复项", () => {
    for (const c of ERROR_CODES) {
      expect(errorCodeSchema.safeParse(c).success).toBe(true);
    }
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("KEYPOINT_NAMES 恰好 13 个，且左右成对", () => {
    expect(KEYPOINT_NAMES).toHaveLength(13);
    const names = new Set<string>(KEYPOINT_NAMES as readonly string[]);
    for (const base of ["shoulder", "elbow", "wrist", "hip", "knee", "ankle"]) {
      expect(names.has(`left_${base}`)).toBe(true);
      expect(names.has(`right_${base}`)).toBe(true);
    }
    expect(names.has("nose")).toBe(true);
  });

  it("质量状态三态齐备（不是布尔）", () => {
    for (const s of ["usable", "limited", "unusable"]) {
      expect(qualityStateSchema.safeParse(s).success).toBe(true);
    }
    // 布尔式表达必须被拒绝，否则会丢失「看不清」与「确有偏差」的区分。
    expect(qualityStateSchema.safeParse(true).success).toBe(false);
    expect(qualityStateSchema.safeParse("ok").success).toBe(false);
  });

  it("左右手标签只有两种取值", () => {
    expect(handednessSchema.safeParse("left").success).toBe(true);
    expect(handednessSchema.safeParse("right").success).toBe(true);
    expect(handednessSchema.safeParse("both").success).toBe(false);
  });

  it("strokeTypeSchema 只接受 forehand_drive（首版范围受限）", () => {
    expect(strokeTypeSchema.safeParse("forehand_drive").success).toBe(true);
    expect(strokeTypeSchema.safeParse("backhand_drive").success).toBe(false);
  });
});

describe("EvidencePacket 与 strokeType 定义同源", () => {
  it("evidencePacketSchema 拒绝非 forehand_drive，与 strokeTypeSchema 行为一致", () => {
    const base = {
      schemaVersion: SCHEMA_VERSION,
      requestId: "r",
      sessionId: "s",
      groupId: "g",
      focusId: FOCUS_IDS[0],
      strokeType: "forehand_drive",
      handedness: "right",
      cameraView: CAMERA_VIEWS[0],
      strokes: [],
      features: [],
      keyframes: [],
      ruleVersion: RULE_VERSION,
      referenceId: null,
      limitations: [],
      readyZone: null,
    };
    expect(evidencePacketSchema.safeParse(base).success).toBe(true);
    expect(evidencePacketSchema.safeParse({ ...base, strokeType: "backhand" }).success).toBe(false);
  });
});

describe("证据包关键帧与挥拍引用必须能对齐", () => {
  /** 一板挥拍 + 一张对齐的关键帧；下面用它在"对齐/不对齐"之间切换。 */
  const alignedPacket = () => ({
    schemaVersion: SCHEMA_VERSION,
    requestId: "r",
    sessionId: "s",
    groupId: "g",
    focusId: FOCUS_IDS[0],
    strokeType: "forehand_drive",
    handedness: "right",
    cameraView: CAMERA_VIEWS[0],
    strokes: [
      {
        strokeId: "st-1",
        startMs: 0,
        endMs: 100,
        anchor: { type: "wrist_speed_peak", timeMs: 50 },
        impactTimeMs: null,
        complete: true,
        evidenceFrameIds: ["f-1"],
        reasons: [],
      },
    ],
    features: [],
    keyframes: [
      {
        id: "kf-1",
        sourceTimeMs: 50,
        jpegBase64: "x",
        frameId: "f-1",
        width: 100,
        height: 100,
        role: "forward" as const,
      },
    ],
    ruleVersion: RULE_VERSION,
    referenceId: null,
    limitations: [],
    readyZone: null,
  });

  it("对齐的包通过校验", () => {
    const parsed = evidencePacketSchema.safeParse(alignedPacket());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const strokeFrameIds = new Set(parsed.data.strokes.flatMap((s) => s.evidenceFrameIds));
      for (const kf of parsed.data.keyframes) {
        expect(strokeFrameIds.has(kf.frameId)).toBe(true);
      }
    }
  });

  it("**不对齐的包被拒绝**（不能拿后来的图片配前一帧骨架）", () => {
    // 这条以前做不到，注释里写着"不是 schema 能强制的" —— 而现在由
    // `evidencePacketSchema` 的 `.refine` 强制。
    //
    // 为什么值得强制：服务端的 `validate.ts` 会把关键帧 id 并进**可引用集合**，
    // 于是模型可以引用一张**不属于它正在讲的那一板**的图。
    // 而客户端侧也已收窄候选（只从本板证据帧里挑，见 F-029），正常链路撞不上。
    const misaligned = alignedPacket();
    misaligned.keyframes[0]!.frameId = "f-不存在";

    const parsed = evidencePacketSchema.safeParse(misaligned);
    expect(parsed.success, "关键帧与挥拍证据不对齐，却通过了校验").toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.includes("keyframes"))).toBe(true);
    }
  });

  it("没有关键帧时不受这条约束影响（空数组恒满足）", () => {
    const noKeyframes = alignedPacket();
    noKeyframes.keyframes = [];
    expect(evidencePacketSchema.safeParse(noKeyframes).success).toBe(true);
  });
});
