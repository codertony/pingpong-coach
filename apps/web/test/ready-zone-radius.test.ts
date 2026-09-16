/**
 * 准备区半径必须**只有一处计算**（F-032）。
 *
 * 此前同一个量在三处各算各的：
 *   - 画面上的绿圈        `体尺度 ?? 200`（未测到时用魔数占位）
 *   - 证据包里的 radiusPx **写死 200**
 *   - 遥测 wristToZoneRatio 的分母  体尺度，未测到时为 null
 *
 * 在这支真实素材上：体尺度实测 147~250px，于是三处分别是
 * 0.3×200、0.3×200、0.3×(147~250) —— **用户照着调姿势的那个圈，
 * 跟状态机真正用的圈不是一个大小**。
 *
 * 这个文件用一个**不等于 200** 的体尺度把三者钉在一起：
 * 只要有人再把其中一处改成别的算法，这里立刻红。
 * （用 200 会正好掩盖这个缺陷 —— 所以体尺度**必须**取别的值。）
 */

import { describe, expect, it } from "vitest";
import { TrainingSession, type TrainingConfig } from "../src/training/training-session.js";
import type { EvidencePacket, Keypoint2D } from "@pingpong/contracts";

const READY = { x: 640, y: 420 };
/** 刻意不是 200：肩 y=200、髋 y=350 → 体尺度 150px */
const SHOULDER_Y = 200;
const HIP_Y = 350;
const BODY_SCALE = HIP_Y - SHOULDER_Y;
const EXPECTED_RADIUS = 0.3 * BODY_SCALE; // = 45

const CONFIG: TrainingConfig = {
  sessionId: "zone_radius",
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

function body(wristX: number): Keypoint2D[] {
  return [
    { name: "nose", xPx: 640, yPx: 120, score: 0.95, visible: true },
    { name: "left_shoulder", xPx: 600, yPx: SHOULDER_Y, score: 0.9, visible: true },
    { name: "right_shoulder", xPx: 680, yPx: SHOULDER_Y, score: 0.9, visible: true },
    { name: "left_elbow", xPx: 580, yPx: 270, score: 0.9, visible: true },
    { name: "right_elbow", xPx: 700, yPx: 270, score: 0.9, visible: true },
    { name: "left_hip", xPx: 610, yPx: HIP_Y, score: 0.9, visible: true },
    { name: "right_hip", xPx: 670, yPx: HIP_Y, score: 0.9, visible: true },
    { name: "left_knee", xPx: 605, yPx: 470, score: 0.9, visible: true },
    { name: "right_knee", xPx: 675, yPx: 470, score: 0.9, visible: true },
    { name: "left_ankle", xPx: 600, yPx: 590, score: 0.9, visible: true },
    { name: "right_ankle", xPx: 680, yPx: 590, score: 0.9, visible: true },
    { name: "right_wrist", xPx: wristX, yPx: READY.y, score: 0.9, visible: true },
  ];
}

const OFFSETS = [0, 0, 0, 0, 0, 0, 0.2, 0.45, 0.45, 0.45, 0.45, 0.3, 0.15, 0.05, 0, 0, 0, 0, 0, 0];

describe("准备区半径只有一处计算（F-032）", () => {
  it("画面上的圈、遥测的半径、证据包里的半径**三者相等**，且都等于 0.3×实测体尺度", () => {
    let packet: EvidencePacket | null = null;
    const session = new TrainingSession(CONFIG, {
      onStatus: () => {},
      onStroke: () => {},
      onFeedback: () => {},
      onGroupComplete: (p) => {
        packet = p;
      },
    });
    session.setReadyZone(READY);

    // 记下成组那一刻的三个读数（成组后遥测会被后续帧改写，所以边跑边记）
    let displayRadius: number | null = null;
    let telemetryRadius: number | null = null;

    let t = 0;
    let i = 0;
    for (let cycle = 0; cycle < 6 && !packet; cycle++) {
      for (const offset of OFFSETS) {
        if (packet) break;
        session.pushPoseResult({
          frameId: `z_${i}`,
          sourceEpoch: 0,
          sourceTimeMs: t,
          receivedAtMonoMs: t,
          inferredAtMonoMs: t,
          inferenceMs: 5,
          imageWidth: 1280,
          imageHeight: 720,
          keypoints2D: body(READY.x + offset * BODY_SCALE),
          detected: true,
          handDetected: false,
          keypointSet: "blaze_33",
        });
        displayRadius = session.readyZoneDisplay?.radiusPx ?? displayRadius;
        telemetryRadius = session.telemetry.readyZoneRadiusPx ?? telemetryRadius;
        t += 40;
        i++;
      }
    }

    expect(packet, "没能成组，这条测不到").not.toBeNull();
    const packetRadius = (packet as unknown as { readyZone: { radiusPx: number } | null }).readyZone
      ?.radiusPx;
    session.dispose();

    // 前置条件：体尺度确实**不是** 200（否则这条会被掩盖）
    expect(BODY_SCALE, "这条用例的前提是体尺度不等于 200").not.toBe(200);
    expect(EXPECTED_RADIUS).toBeCloseTo(45, 6);

    expect(displayRadius, "画面上的绿圈半径对不上").toBeCloseTo(EXPECTED_RADIUS, 6);
    expect(telemetryRadius, "遥测半径对不上").toBeCloseTo(EXPECTED_RADIUS, 6);
    expect(packetRadius, "证据包里的准备区半径对不上 —— 它原先写死 200×0.3=60").toBeCloseTo(
      EXPECTED_RADIUS,
      6,
    );
    // 三者必须是同一个数（这条才是"只有一处计算"的真正断言）
    expect(displayRadius).toBe(telemetryRadius);
    expect(packetRadius).toBe(displayRadius);
  });
});
