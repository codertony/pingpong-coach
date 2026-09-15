import { describe, expect, it } from "vitest";
import {
  coachFeedbackSchema,
  evidencePacketSchema,
  poseFrameSchema,
  SCHEMA_VERSION,
} from "../src/index.js";

const basePoseFrame = {
  schemaVersion: SCHEMA_VERSION,
  sessionId: "s1",
  frameId: "f1",
  sourceEpoch: 0,
  sourceTimeMs: 100,
  receivedAtMonoMs: 50,
  modelId: "pose_landmarker_full",
  keypointSet: "blaze_33",
  imageWidth: 1280,
  imageHeight: 720,
  keypoints2D: [{ name: "right_elbow", xPx: 640, yPx: 360, score: 0.9, visible: true }],
  quality: "usable",
  qualityReasons: [],
};

describe("PoseFrame", () => {
  it("接受合法帧", () => {
    expect(poseFrameSchema.safeParse(basePoseFrame).success).toBe(true);
  });

  it("允许 score 与 visible 为 null，表示引擎未给出该信息", () => {
    const frame = {
      ...basePoseFrame,
      keypoints2D: [{ name: "right_wrist", xPx: 1, yPx: 2, score: null, visible: null }],
    };
    expect(poseFrameSchema.safeParse(frame).success).toBe(true);
  });

  it("拒绝非有限坐标，避免 NaN 污染几何计算", () => {
    const frame = {
      ...basePoseFrame,
      keypoints2D: [{ name: "right_elbow", xPx: Number.NaN, yPx: 360, score: 0.9, visible: true }],
    };
    expect(poseFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("拒绝未映射的引擎原生关键点名", () => {
    const frame = {
      ...basePoseFrame,
      keypoints2D: [{ name: "landmark_13", xPx: 1, yPx: 2, score: 0.9, visible: true }],
    };
    expect(poseFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("拒绝负的 sourceTimeMs", () => {
    const frame = { ...basePoseFrame, sourceTimeMs: -1 };
    expect(poseFrameSchema.safeParse(frame).success).toBe(false);
  });
});

const baseStroke = {
  strokeId: "st1",
  startMs: 0,
  endMs: 500,
  anchor: { type: "wrist_speed_peak" as const, timeMs: 200 },
  impactTimeMs: null,
  complete: true,
  evidenceFrameIds: ["f1"],
  reasons: [],
};

describe("EvidencePacket", () => {
  const packet = {
    schemaVersion: SCHEMA_VERSION,
    requestId: "r1",
    sessionId: "s1",
    groupId: "g1",
    focusId: "return_to_ready_zone",
    strokeType: "forehand_drive" as const,
    handedness: "right" as const,
    cameraView: "front",
    strokes: [baseStroke],
    features: [
      {
        id: "return_after_wrist_peak_ms",
        value: 420,
        unit: "ms" as const,
        coordinateSpace: "image_2d" as const,
        intervalMs: [200, 620] as [number, number],
        quality: "usable" as const,
        reasonIfMissing: null,
      },
    ],
    keyframes: [
      {
        id: "kf1",
        sourceTimeMs: 200,
        jpegBase64: "AAAA",
        frameId: "f1",
        width: 960,
        height: 540,
        role: "forward" as const,
      },
    ],
    ruleVersion: "1.0.0",
    referenceId: null,
    limitations: ["单目二维，无法判断肌肉发力"],
    readyZone: { xPx: 640, yPx: 400, radiusPx: 80 },
  };

  it("接受合法证据包", () => {
    expect(evidencePacketSchema.safeParse(packet).success).toBe(true);
  });

  it("允许关键帧的 frameId 与挥拍证据对齐", () => {
    const parsed = evidencePacketSchema.parse(packet);
    const strokeFrames = new Set(parsed.strokes.flatMap((s) => s.evidenceFrameIds));
    for (const kf of parsed.keyframes) {
      expect(strokeFrames.has(kf.frameId)).toBe(true);
    }
  });

  it("特征缺失使用 null 加原因，而不是 0", () => {
    const withMissing = {
      ...packet,
      features: [
        {
          id: "elbow_angle_range_deg",
          value: null,
          unit: "deg" as const,
          coordinateSpace: "image_2d" as const,
          intervalMs: [0, 500] as [number, number],
          quality: "unusable" as const,
          reasonIfMissing: "持拍手臂被遮挡",
        },
      ],
    };
    const parsed = evidencePacketSchema.parse(withMissing);
    expect(parsed.features[0]?.value).toBeNull();
    expect(parsed.features[0]?.reasonIfMissing).not.toBeNull();
  });

  it("拒绝非 forehand_drive 的动作类型，首版刻意收窄", () => {
    const bad = { ...packet, strokeType: "backhand_drive" };
    expect(evidencePacketSchema.safeParse(bad).success).toBe(false);
  });
});

describe("CoachFeedback", () => {
  const feedback = {
    schemaVersion: SCHEMA_VERSION,
    requestId: "r1",
    sessionId: "s1",
    groupId: "g1",
    focusId: "return_to_ready_zone",
    status: "suggest_adjustment" as const,
    observation: "三次挥拍后回到准备区的中位时间比本组约束长约 180 毫秒。",
    evidenceRefs: ["return_after_wrist_peak_ms", "kf1"],
    cue: "击球后先把重心带回准备位置。",
    nextDrillId: "shadow_forehand_return_ready",
    limitations: ["未识别球拍触球，锚点为腕部速度峰值"],
    modelId: "mock-coach",
    mock: true,
    serverElapsedMs: 12,
    rejectedClaims: [],
    createdAtMonoMs: 1234,
  };

  it("接受合法反馈", () => {
    expect(coachFeedbackSchema.safeParse(feedback).success).toBe(true);
  });

  it("拒绝未知 status", () => {
    const bad = { ...feedback, status: "correct" };
    expect(coachFeedbackSchema.safeParse(bad).success).toBe(false);
  });

  it("允许 cue 与 nextDrillId 为 null", () => {
    const noCue = { ...feedback, cue: null, nextDrillId: null };
    expect(coachFeedbackSchema.safeParse(noCue).success).toBe(true);
  });
});
