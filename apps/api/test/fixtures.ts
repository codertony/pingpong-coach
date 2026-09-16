/**
 * API 测试共用夹具。
 *
 * 目的：让每个测试只描述「被测行为」，不用重复粘贴几十行证据包。
 * 所有构造出的数值都是**人为设定的输入**，不代表真实测量。
 */

import type { EvidencePacket, FeatureValue, StrokeEvent } from "@pingpong/contracts";

/** 一张 1x1 的最小合法 JPEG（base64），只用于满足契约，不含真实图像内容。 */
export const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

export function makeStroke(overrides: Partial<StrokeEvent> = {}): StrokeEvent {
  return {
    strokeId: "stroke-1",
    startMs: 1000,
    endMs: 1900,
    anchor: { type: "wrist_speed_peak", timeMs: 1520 },
    impactTimeMs: null,
    complete: true,
    phaseEvents: [
      { eventType: "backswing_start", timeMs: 1100, supportFrameIds: ["f-1"] },
      { eventType: "forward_start", timeMs: 1400, supportFrameIds: ["f-2"] },
      { eventType: "return_start", timeMs: 1700, supportFrameIds: ["f-3"] },
      { eventType: "stroke_closed", timeMs: 1900, supportFrameIds: ["f-3"] },
    ],
    // 这一栏是**姿态帧**的 frameId（与下面的 keyframes[].frameId 对齐），
    // 不是关键帧的 id —— 原先这里写的是 ["kf-1","kf-2","kf-3"]（那是关键帧的 id），
    // 与契约里"keyframes[].frameId 必须与 strokes[].evidenceFrameIds 对齐"不符。
    // 一直没被发现，是因为当时 schema 里根本没有执行那条约束（见 F-029）。
    evidenceFrameIds: ["f-1", "f-2", "f-3"],
    reasons: [],
    ...overrides,
  };
}

export function makeFeature(overrides: Partial<FeatureValue> = {}): FeatureValue {
  return {
    id: "return_after_wrist_peak_ms",
    value: 260,
    unit: "ms",
    coordinateSpace: "image_2d",
    intervalMs: [1520, 1780],
    quality: "usable",
    reasonIfMissing: null,
    ...overrides,
  };
}

export function makePacket(overrides: Partial<EvidencePacket> = {}): EvidencePacket {
  const base: EvidencePacket = {
    schemaVersion: "1",
    requestId: "req-1",
    sessionId: "sess-1",
    groupId: "group-1",
    focusId: "return_to_ready_zone",
    strokeType: "forehand_drive",
    handedness: "right",
    cameraView: "front",
    strokes: [makeStroke()],
    // 逐板值用**真实**的一条（不是空数组）：提示词用例要断言它被渲染出来
    perStrokeFeatures: [
      {
        strokeId: makeStroke().strokeId,
        features: [makeFeature({ id: "return_after_wrist_peak_ms", value: 260 })],
      },
    ],
    features: [makeFeature()],
    keyframes: [
      {
        id: "kf-1",
        sourceTimeMs: 1320,
        jpegBase64: TINY_JPEG_BASE64,
        frameId: "f-1",
        width: 960,
        height: 540,
        role: "backswing",
      },
      {
        id: "kf-2",
        sourceTimeMs: 1520,
        jpegBase64: TINY_JPEG_BASE64,
        frameId: "f-2",
        width: 960,
        height: 540,
        role: "forward",
      },
      {
        id: "kf-3",
        sourceTimeMs: 1780,
        jpegBase64: TINY_JPEG_BASE64,
        frameId: "f-3",
        width: 960,
        height: 540,
        role: "return",
      },
    ],
    ruleVersion: "1.0.0",
    referenceId: null,
    criterion: {
      featureId: "return_after_wrist_peak_ms",
      threshold: 700,
      unit: "ms",
      minValidStrokes: 3,
    },
    limitations: ["仅正面机位"],
    readyZone: { xPx: 620, yPx: 300, radiusPx: 90 },
  };
  return { ...base, ...overrides };
}

/** 构造一个最小可用的 ServerConfig（mock 模式）。 */
export function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    port: 8787,
    host: "127.0.0.1",
    modelMode: "mock" as const,
    modelId: "mock-coach",
    modelBaseUrl: "",
    modelApiKey: "",
    modelTimeoutMs: 4000,
    modelMaxTokens: 400,
    // 费用保护上限（真实默认值见 src/config.ts；这里只是测试夹具）
    sessionModelCallsPer20Min: 60,
    maxRequestBytes: 2 * 1024 * 1024,
    dedupeTtlMs: 30_000,
    ...overrides,
  };
}

/** 构造一个知识条目（默认未审核）。 */
export function makeKnowledgeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "kb-1",
    version: "1.0.0",
    strokeType: "forehand_drive",
    focusId: "return_to_ready_zone",
    cameraViews: ["front"],
    context: "定点正手攻球",
    observable: ["挥拍后是否回到准备区"],
    notApplicable: ["捡球走动"],
    reviewedCues: [],
    allowedDrillIds: [],
    sources: ["内部拟定"],
    status: "observation_only" as const,
    referenceId: null,
    ...overrides,
  };
}
