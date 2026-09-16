/**
 * 合成挥拍的测试夹具：**一份定义，多处使用**。
 *
 * 为什么抽出来：这段相位序列是**实测调出来的**（腕部要先过 One-Euro 因果滤波，
 * 单帧尖峰会被滤掉，永远进不了引拍）。如果它在几个测试文件里各抄一份，
 * 那么改动其中一份 —— 比如调 `readyStableMinMs` 之后顺手改了相位长度 ——
 * 会让**其它文件继续用旧序列**，于是那些测试名义上还在测同一件事，
 * 实际上测的是另一件事，而且照样是绿的。本项目已经栽过好几次
 * "同一个事实两处各写各的"（F-017/F-018/F-019）。
 *
 * 所以这里只有一处定义：`OFFSETS`（相位）、`bodyPoints`（骨架）、
 * `makeFrame`（帧）、`driveCycles`（连喂）。
 */

import type { Keypoint2D } from "@pingpong/contracts";
import type { TrainingSession, TrainingConfig } from "../../src/training/training-session.js";
import type { PoseResult } from "../../src/vision/pose-engine.js";

/** 准备区中心。与 `bodyPoints` 的默认腕部位置一致。 */
export const READY = { x: 640, y: 420 };

/** 体尺度 = 肩中点—髋中点 = 200px（肩 y=200、髋 y=400）。 */
export const BODY_SCALE = 200;

/** 合成帧间隔。 */
export const FRAME_MS = 40;

/** 与本夹具配套的分段参数（默认 `strokesPerGroup: 3`，调用方可覆盖）。 */
export function makeConfig(overrides: Partial<TrainingConfig> = {}): TrainingConfig {
  return {
    sessionId: "synthetic",
    strokeType: "forehand_drive",
    handedness: "right",
    cameraView: "front",
    focusId: "return_to_ready_zone",
    strokesPerGroup: 3,
    segmentation: {
      strokeType: "forehand_drive",
      cameraView: "front",
      handedness: "right",
      readyZoneRadiusBodyScale: 0.3,
      readyStableMinMs: 120,
      backswingMinDisplacementBodyScale: 0.2,
      forwardMinSpeedBodyScalePerSec: 0.5,
      returnStableMinMs: 120,
      maxGapMs: 250,
      maxStrokeDurationMs: 3000,
    },
    ...overrides,
  };
}

/**
 * 一次挥拍的相位序列（单位：体尺度比例）。
 *
 * 每个相位保持若干帧，是因为腕部要先过 One-Euro 因果滤波 ——
 * 单帧尖峰会被滤掉，永远进不了引拍。
 */
export const OFFSETS = [
  0,
  0,
  0,
  0,
  0,
  0, // 准备驻留 240ms ≥ readyStableMinMs
  0.2,
  0.45,
  0.45,
  0.45,
  0.45, // 引拍，并在峰值停留让滤波收敛
  0.3,
  0.15,
  0.05, // 向前挥拍
  0,
  0,
  0,
  0,
  0,
  0, // 回到准备区并驻留
];

/** 一具完整可用的骨架，腕部落在 `wristX`。 */
export function bodyPoints(wristX: number): Keypoint2D[] {
  return [
    { name: "nose", xPx: 640, yPx: 120, score: 0.95, visible: true },
    { name: "left_shoulder", xPx: 600, yPx: 200, score: 0.9, visible: true },
    { name: "right_shoulder", xPx: 680, yPx: 200, score: 0.9, visible: true },
    { name: "left_elbow", xPx: 580, yPx: 280, score: 0.9, visible: true },
    { name: "right_elbow", xPx: 700, yPx: 280, score: 0.9, visible: true },
    { name: "left_hip", xPx: 610, yPx: 400, score: 0.9, visible: true },
    { name: "right_hip", xPx: 670, yPx: 400, score: 0.9, visible: true },
    { name: "left_knee", xPx: 605, yPx: 520, score: 0.9, visible: true },
    { name: "right_knee", xPx: 675, yPx: 520, score: 0.9, visible: true },
    { name: "left_ankle", xPx: 600, yPx: 640, score: 0.9, visible: true },
    { name: "right_ankle", xPx: 680, yPx: 640, score: 0.9, visible: true },
    { name: "right_wrist", xPx: wristX, yPx: READY.y, score: 0.9, visible: true },
  ];
}

/** 造一帧：`offset` 是腕部相对准备区的位移（单位：体尺度）。 */
export function makeFrame(
  index: number,
  sourceTimeMs: number,
  offset: number,
  opts: { detected?: boolean } = {},
): PoseResult {
  return {
    frameId: `f${index}`,
    sourceEpoch: 0,
    sourceTimeMs,
    receivedAtMonoMs: sourceTimeMs,
    inferredAtMonoMs: sourceTimeMs,
    inferenceMs: 5,
    imageWidth: 1280,
    imageHeight: 720,
    keypoints2D: bodyPoints(READY.x + offset * BODY_SCALE),
    detected: opts.detected ?? true,
    handDetected: false,
    keypointSet: "blaze_33",
  };
}

/** 连喂 `cycles` 轮完整挥拍。返回结束时的帧计数与时间。 */
export function driveCycles(
  session: TrainingSession,
  cycles: number,
  start = { frames: 0, t: 0 },
): { frames: number; t: number } {
  let { frames, t } = start;
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (const offset of OFFSETS) {
      session.pushPoseResult(makeFrame(frames, t, offset));
      t += FRAME_MS;
      frames++;
    }
  }
  return { frames, t };
}
