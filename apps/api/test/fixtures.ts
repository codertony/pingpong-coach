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
    evidenceFrameIds: ["kf-1", "kf-2", "kf-3"],
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
