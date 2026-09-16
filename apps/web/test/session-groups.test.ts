/**
 * 成组之后**还能不能继续练**。
 *
 * 为什么单独写这一份：此前没有任何测试跑过**第二组**。
 * `telemetry.test.ts` 把 `strokesPerGroup` 设成 99（注释写着"不触发成组，只观察遥测"），
 * 而夹具里的 `runSyntheticGroup` 在拿到**第一个**包之后就 `break`。
 * 也就是说"第一组之后的行为"整块没被覆盖过。
 *
 * 这不是假想的担忧：20 分钟稳定性测试（`e2e/soak.e2e.ts`）里，
 * 连续喂了 20 分钟、5 万多帧，结果只出了 **3 次挥拍 / 1 组** —— 恰好等于
 * `strokesPerGroup: 3`。那强烈提示"第一组之后就不再有挥拍"。
 *
 * 所以这里直接量：连喂多轮，数一共出了几次挥拍、几组。
 */

import { describe, expect, it } from "vitest";
import { TrainingSession, type TrainingConfig } from "../src/training/training-session.js";
import type { PoseResult } from "../src/vision/pose-engine.js";
import type { Keypoint2D } from "@pingpong/contracts";

const READY = { x: 640, y: 420 };
/** 体尺度 = 肩中点—髋中点 = 200px（肩 y=200、髋 y=400） */
const BODY_SCALE = 200;
const FRAME_MS = 40;

const CONFIG: TrainingConfig = {
  sessionId: "groups1",
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
};

/**
 * 一次挥拍的相位序列（单位：体尺度比例）。
 *
 * 与 `e2e/fixtures/fixture-entry.ts` 里那套**实测调出来**的一致：
 * 每个相位保持若干帧，是因为腕部要先过 One-Euro 因果滤波 ——
 * 单帧尖峰会被滤掉，永远进不了引拍。
 */
const OFFSETS = [
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

function bodyPoints(wristX: number): Keypoint2D[] {
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

/** 连喂 `cycles` 轮挥拍，返回实际产生的挥拍数与成组数。 */
function runCycles(
  cycles: number,
  opts: { detected?: boolean; withPixels?: boolean } = {},
): {
  strokes: number;
  groups: number;
  frames: number;
  statuses: string[];
  keyframesPerGroup: number[];
  keyframesMissing: number | null;
} {
  // 用回调直接计数，不依赖快照窗口
  let strokes = 0;
  let groups = 0;
  const statuses: string[] = [];
  const keyframesPerGroup: number[] = [];
  const counting = new TrainingSession(CONFIG, {
    onStatus: (t) => {
      statuses.push(t);
    },
    onStroke: () => {
      strokes++;
    },
    onFeedback: () => {},
    onGroupComplete: (packet) => {
      groups++;
      keyframesPerGroup.push(packet.keyframes.length);
    },
  });
  counting.setReadyZone(READY);

  let t = 0;
  let frames = 0;
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (const offset of OFFSETS) {
      const frame: PoseResult = {
        frameId: `f${frames}`,
        sourceEpoch: 0,
        sourceTimeMs: t,
        receivedAtMonoMs: t,
        inferredAtMonoMs: t,
        inferenceMs: 5,
        imageWidth: 1280,
        imageHeight: 720,
        keypoints2D: bodyPoints(READY.x + offset * BODY_SCALE),
        detected: opts.detected ?? true,
        handDetected: false,
        keypointSet: "blaze_33",
      };
      // 产品里由采集侧在把位图交给引擎**之前**调用它（见 App.tsx）。
      // 这里用一小段假字节代替真实 JPEG —— 本文件测的是会话行为，不是编码。
      if (opts.withPixels) {
        counting.addFramePixels(`f${frames}`, t, new Uint8Array([1, 2, 3]), 960, 540);
      }
      counting.pushPoseResult(frame);
      if (process.env.PPC_DEBUG_GROUPS === "2" && cycle >= 2 && cycle <= 5) {
        const tel = counting.telemetry;
        console.log(
          `  c${cycle} f${offset.toFixed(2)} t=${t} phase=${tel.segmentationPhase} ` +
            `zone=${tel.wristToZoneRatio?.toFixed(2) ?? "-"} strokes=${strokes}`,
        );
      }
      t += FRAME_MS;
      frames++;
    }
    if (process.env.PPC_DEBUG_GROUPS === "1") {
      const tel = counting.telemetry;
      console.log(
        `cycle ${cycle}: strokes=${strokes} groups=${groups} phase=${tel.segmentationPhase} ` +
          `abort=${tel.segmentationLastAbortReason ?? "-"} skipped=${tel.segmentationSkippedFrames} ` +
          `wristToZone=${tel.wristToZoneRatio?.toFixed(2) ?? "-"} ` +
          `status="${statuses[statuses.length - 1] ?? ""}"`,
      );
    }
  }
  const keyframesMissing = counting.telemetry.keyframesMissing;
  counting.dispose();
  return { strokes, groups, frames, statuses, keyframesPerGroup, keyframesMissing };
}

describe("成组之后仍能继续检出挥拍", () => {
  it("连喂 30 轮：应当出 30 次挥拍、10 组（而不是只出第一组）", () => {
    const r = runCycles(30);
    // 先把"夹具本身是对的"钉住：第一组必须能出
    expect(r.strokes, "第一组都没出，说明这套合成数据本身有问题").toBeGreaterThanOrEqual(3);
    // 关键：不能停在第一组
    expect(
      r.strokes,
      `连喂 30 轮只出了 ${r.strokes} 次挥拍 —— 停在第一组了（共 ${r.frames} 帧）`,
    ).toBeGreaterThanOrEqual(20);
    expect(r.groups, `只成了 ${r.groups} 组 —— 第二组之后没有继续`).toBeGreaterThanOrEqual(5);
  });
});

describe("关键帧图片链路（F-028）", () => {
  it("**给了像素**时：证据包里有图、遥测报 0、且不再有「取不到图」的提示", () => {
    const r = runCycles(3, { withPixels: true });
    expect(r.groups, "没成组就测不到这一条").toBeGreaterThanOrEqual(1);

    // 这是 F-028 修好之后的形态：采集侧把像素放进缓存 → 成组时能选到图。
    for (const n of r.keyframesPerGroup) {
      expect(n, "给了像素，证据包里的关键帧却还是空的").toBeGreaterThan(0);
    }
    expect(r.keyframesMissing, "还有关键帧取不到图").toBe(0);
    expect(
      r.statuses.some((s) => s.includes("取不到")),
      "图片都取到了，却还在提示「取不到图」",
    ).toBe(false);
  });

  it("**没给像素**时：必须明确提示，不许静默", () => {
    // 这条守的是"不静默"。产品里采集侧会放像素，但"没放"这种情况
    // （编码失败、位图拿不到、将来有人改了调用点）**必须报出来** ——
    // 否则又会回到 F-028 那种"看起来有图、其实全是空包"的静默状态。
    const r = runCycles(3);
    expect(r.groups).toBeGreaterThanOrEqual(1);
    for (const n of r.keyframesPerGroup) {
      expect(n, "没给像素，证据包里却有图？").toBe(0);
    }
    expect(r.keyframesMissing, "一张图都没有，遥测却没报").toBeGreaterThan(0);
    expect(
      r.statuses.some((s) => s.includes("关键帧") && s.includes("取不到")),
      "关键帧全部取不到，却没有任何提示 —— 这正是 F-028 的静默形态",
    ).toBe(true);
  });
});
