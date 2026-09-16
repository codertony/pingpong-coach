/**
 * F-036：**同一件事实（"这具身体看得清吗"）在两处口径不同**。
 *
 * - 绘制层（`App.tsx` → `drawSkeleton`）要求关键点 `score ≥ 0.5`，
 *   低于它的点**一个都不画**；
 * - 而 `TrainingSession` 里的 `findPoint` 只挡 `visible === false`，
 *   而 `visible` 的定义是 **`confidence > 0`**（见 `pose.worker.ts`）——
 *   于是置信度 0.01 的点与 0.99 的点**等价**。
 *
 * 后果：体尺度、准备区半径、以及分段用的腕部，都可以由**绘制层会拒绝的点**
 * 决定。活链路上量到过它的样子（`apps/web/e2e/live-capture.e2e.ts` 的反向对照）：
 * 合成图案上没有人的时候，**准备区圆画出来了（约 70 像素）而骨架一个像素都没有**
 * —— 屏幕在画一个"它不肯承认看得见"的身体的约束圈。
 *
 * ## 这个文件钉的是**现状**，不是理想
 *
 * 我**没有**改这个行为，理由是改它会动到**真实素材上**的分段与证据内容，
 * 而当前没有能证明"该改"的证据（真实素材上只量到过这一现象的合成版本）。
 * 所以这里把现状钉死，让它**可见**、且改动时必须有人主动改这个测试。
 * 详见 `docs/known-failures.md` F-036 的两条待定问题。
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY_CONFIG } from "@pingpong/motion-core";
import { TrainingSession, type TrainingConfig } from "../src/training/training-session.js";
import type { Keypoint2D } from "@pingpong/contracts";

/** 低到绘制层不会画的置信度。仍是 `visible: true`（= 置信度 > 0）。 */
const WISPY = 0.05;

const CONFIG: TrainingConfig = {
  sessionId: "f036",
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

/** 一具**躯干关键点全部只有 WISPY 置信度**的"身体"。 */
function wispyBody(): Keypoint2D[] {
  const p = (name: string, xPx: number, yPx: number): Keypoint2D => ({
    name,
    xPx,
    yPx,
    score: WISPY,
    visible: true, // ← 与 pose.worker 的 visible = confidence > 0 一致
  });
  return [
    p("left_shoulder", 600, 200),
    p("right_shoulder", 680, 200),
    p("left_hip", 610, 350),
    p("right_hip", 670, 350),
    p("right_wrist", 640, 420),
  ];
}

function push(session: TrainingSession, i: number): void {
  session.pushPoseResult({
    frameId: `w_${i}`,
    sourceEpoch: 0,
    sourceTimeMs: i * 40,
    receivedAtMonoMs: i * 40,
    inferredAtMonoMs: i * 40,
    inferenceMs: 5,
    imageWidth: 1280,
    imageHeight: 720,
    keypoints2D: wispyBody(),
    detected: true,
    handDetected: false,
    keypointSet: "blaze_33",
  });
}

describe("F-036 · 会话接受绘制层会拒绝的身体", () => {
  it("前置条件：绘制层的门槛确实是 0.5，而样本点的置信度在它之下", () => {
    // 这一条是**前提**，不是结论：如果哪天绘制门槛降到 0 或样本点提上去，
    // 下面那条断言就不再说明任何问题，必须先在这里失败。
    expect(DEFAULT_QUALITY_CONFIG.minScore).toBeGreaterThan(WISPY);
    expect(DEFAULT_QUALITY_CONFIG.minScore).toBe(0.5);
  });

  it("躯干点全部只有 0.05 置信度，体尺度**照样被采纳**（绘制层则会一个点都不画）", () => {
    const session = new TrainingSession(CONFIG, {
      onStatus: () => {},
      onStroke: () => {},
      onFeedback: () => {},
      onGroupComplete: () => {},
    });

    push(session, 0);

    // 现状：采纳了。肩中点→髋中点 = 150px（y 200→350）。
    expect(
      session.telemetry.bodyScalePx,
      "体尺度没被采纳 —— 说明这个行为已经改了，请连同 F-036 的结论一起更新本文件",
    ).toBeCloseTo(150, 6);

    session.dispose();
  });

  it("于是准备区圆**会**画出来，而它的半径来自这具 0.05 置信度的身体", () => {
    const session = new TrainingSession(CONFIG, {
      onStatus: () => {},
      onStroke: () => {},
      onFeedback: () => {},
      onGroupComplete: () => {},
    });

    push(session, 0);
    session.setReadyZone({ x: 640, y: 420 });

    // 现状：圈画得出来，半径 = 0.3 × 150 = 45。
    // 屏幕上却是空的（绘制层把这些点全滤掉了）—— 这就是活链路上量到的
    // "有绿圈、没有骨架"。
    expect(session.readyZoneDisplay?.radiusPx).toBeCloseTo(45, 6);

    session.dispose();
  });
});
