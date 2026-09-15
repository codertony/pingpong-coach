/**
 * 性能基线（roadmap A4）。
 *
 * 只做「灾难性回归哨兵」，不做精确 benchmark：对每帧热路径函数计时，
 * 用**宽松上限**（每调用 10ms，比实际 µs 级高 3 个数量级）拦 O(n²) /
 * 死循环这类把函数从微秒拖到毫秒级的回归。
 *
 * 为什么用中位数 + 宽松上限而不是 tight 阈值：
 * - CI 是共享/节流机器，tight 阈值必抖；
 * - 真实延迟目标（`configs/thresholds.json` 的 latency）仍需 T-6 真机实测，
 *   这里的 10ms 上限永远不该被一条正常机器触及，只有回归才会撞上。
 */

import { describe, expect, it } from "vitest";
import type { Keypoint2D, PoseFrame } from "@pingpong/contracts";
import { SCHEMA_VERSION } from "@pingpong/contracts";
import { extractFrameGeometry } from "../src/features.js";
import { assessFrameQuality } from "../src/quality.js";
import { oneEuroConfig, ScalarFilter } from "../src/filter.js";
import { StrokeSegmenter, type SegmentationSample } from "../src/segmentation.js";
import type { SegmentationConfig } from "@pingpong/contracts";

/** 宽松上限：每调用 10ms。实际热路径在 µs 级，只有回归才会超过。 */
const CEILING_MS = 10;

/** 计时：预热两次后测 N 次，返回单次毫秒（中位数）。 */
function measurePerCall(fn: () => void, iterations: number): number {
  fn();
  fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

function kp(name: string, x: number, y: number): Keypoint2D {
  return { name, xPx: x, yPx: y, score: 0.9, visible: true };
}

function frame(): PoseFrame {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "s1",
    frameId: "f1",
    sourceEpoch: 0,
    sourceTimeMs: 0,
    receivedAtMonoMs: 0,
    modelId: "pose_landmarker_full",
    keypointSet: "blaze_33",
    imageWidth: 1280,
    imageHeight: 720,
    keypoints2D: [
      kp("left_shoulder", 600, 200),
      kp("right_shoulder", 800, 200),
      kp("right_elbow", 900, 300),
      kp("right_wrist", 1000, 350),
      kp("left_hip", 620, 430),
      kp("right_hip", 780, 430),
    ],
    quality: "usable",
    qualityReasons: [],
  };
}

const SEG_CONFIG: SegmentationConfig = {
  strokeType: "forehand_drive",
  cameraView: "front",
  handedness: "right",
  readyZoneRadiusBodyScale: 0.3,
  readyStableMinMs: 80,
  backswingMinDisplacementBodyScale: 0.2,
  forwardMinSpeedBodyScalePerSec: 0.5,
  returnStableMinMs: 80,
  maxGapMs: 200,
  maxStrokeDurationMs: 3000,
};

function segSample(timeMs: number, offset: number): SegmentationSample {
  return {
    frameId: `f_${timeMs}`,
    sourceTimeMs: timeMs,
    wristPx: { x: 640 + offset * 200, y: 400 },
    wristRelReadyZonePx: { x: offset * 200, y: 0 },
    bodyScalePx: 200,
    quality: "usable",
  };
}

describe("motion-core 每帧热路径性能基线（宽松上限哨兵）", () => {
  it("extractFrameGeometry 单次调用 < 10ms", () => {
    const f = frame();
    const ms = measurePerCall(() => extractFrameGeometry(f, "right"), 20_000);
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it("assessFrameQuality 单次调用 < 10ms", () => {
    const f = frame();
    const prev = frame();
    const ms = measurePerCall(() => assessFrameQuality(f, "right", prev), 20_000);
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it("One-Euro 滤波 push 单次调用 < 10ms", () => {
    const filt = new ScalarFilter(oneEuroConfig());
    let t = 0;
    const ms = measurePerCall(() => {
      filt.push(Math.sin(t) * 100, t);
      t += 40;
    }, 100_000);
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it("StrokeSegmenter.push 单次调用 < 10ms", () => {
    const seg = new StrokeSegmenter(SEG_CONFIG);
    seg.setReadyZone({ x: 640, y: 400 });
    let t = 0;
    let phase = 0;
    const ms = measurePerCall(() => {
      // 用简单波形驱动状态机，覆盖 idle/ready/backswing/forward 各分支
      const offset = [0, 0.15, 0.3, 0.45, 0.3, 0.15, 0.05, 0][phase % 8]!;
      seg.push(segSample(t, offset));
      t += 40;
      phase++;
    }, 20_000);
    expect(ms).toBeLessThan(CEILING_MS);
  });
});
