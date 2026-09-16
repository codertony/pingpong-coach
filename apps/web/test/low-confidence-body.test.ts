/**
 * F-036：**同一件事实（"这具身体看得清吗"）只允许有一个定义**。
 *
 * ## 缺陷的原样
 *
 * - 绘制层（`App.tsx` → `drawSkeleton`）要求关键点 `score ≥ 0.5`，
 *   低于它的点**一个都不画**；
 * - 而 `TrainingSession` 算体尺度时用的 `findPoint` 只挡 `visible === false`，
 *   而 `visible` 的定义是 **`confidence > 0`**（见 `pose.worker.ts`）——
 *   于是置信度 **0.01 的点与 0.99 的点等价**。
 *
 * 后果是屏幕上出现**自相矛盾的一帧**：活链路上量到过
 * **准备区圆画出来 10/20 次、而骨架只出现 1/20 次**
 * （`apps/web/e2e/live-capture.e2e.ts` 的反向对照，合成图案、画面无人）——
 * 屏幕在画一个它几乎不肯承认看得见的身体的约束圈。
 *
 * ## 修复：不是"加个门槛"，是**让两处共用一个定义**
 *
 * 体尺度那条路改用与绘制层**同一个常量**（`DEFAULT_QUALITY_CONFIG.minScore`），
 * 而不是再写一个 0.5。
 *
 * ## 修复的代价：**在真实素材上量过，是 0**
 *
 * 在唯一一支真实素材（244 帧、逐帧检出 244/244）上记录并统计躯干四点
 * **最低置信度**（`segmentation-eval` 现在逐帧导出 `torsoMinScore`）：
 *
 * | 帧 | 最小值 | p1 | p25 | 中位 |
 * | --- | --- | --- | --- | --- |
 * | 244 | **0.985** | 0.989 | 0.996 | 0.999 |
 *
 * **低于 0.5 的帧：0 / 244。** 所以这个门槛在这支素材上**一帧都不会掉**，
 * 它修的是"误检/幻觉"那一侧，而不是在真实数据上收紧口径。
 *
 * ## 刻意**没有**做的：腕部仍然不套门槛
 *
 * 腕部走的是内部状态估计，不是对用户的承诺，且已有两层兜底
 * （因果滤波 + 逐帧质量分级与本组可判门槛）。更硬的理由是：
 * **手部在运动模糊下掉置信度是已知常态**（见 F-006），而那类素材
 * 没有实测数据 —— 在真实数据之前改它，就是把猜测从一个值挪到另一个值。
 * 下面有一条用例把这个**不对称**钉住，免得日后有人"顺手对齐"。
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_QUALITY_CONFIG } from "@pingpong/motion-core";
import { TrainingSession, type TrainingConfig } from "../src/training/training-session.js";
import type { Keypoint2D } from "@pingpong/contracts";

/** 低到绘制层不会画的置信度。仍是 `visible: true`（= 置信度 > 0）。 */
const WISPY = 0.05;
/** 高置信度：正常素材上的样子（真实素材实测躯干最低分 0.985）。 */
const CONFIDENT = 0.98;

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

/**
 * 一具身体。`torsoScore` 给肩/髋，`wristScore` 单独给（两条路口径不同，
 * 所以要能分别设定）；传 `null` 表示**置信度未知**（手部模型的关键点就是这样）。
 */
function body(torsoScore: number | null, wristScore: number | null): Keypoint2D[] {
  const p = (name: string, xPx: number, yPx: number, score: number | null): Keypoint2D => ({
    name,
    xPx,
    yPx,
    score,
    visible: true, // ← 与 pose.worker 的 visible = confidence > 0 一致
  });
  return [
    p("left_shoulder", 600, 200, torsoScore),
    p("right_shoulder", 680, 200, torsoScore),
    p("left_hip", 610, 350, torsoScore),
    p("right_hip", 670, 350, torsoScore),
    p("right_wrist", 640, 420, wristScore),
  ];
}

function makeSession(): {
  session: TrainingSession;
  push: (keypoints: Keypoint2D[], i?: number) => void;
} {
  const session = new TrainingSession(CONFIG, {
    onStatus: () => {},
    onStroke: () => {},
    onFeedback: () => {},
    onGroupComplete: () => {},
  });
  let i = 0;
  return {
    session,
    push: (keypoints, index) => {
      const n = index ?? i++;
      session.pushPoseResult({
        frameId: `f_${n}`,
        sourceEpoch: 0,
        sourceTimeMs: n * 40,
        receivedAtMonoMs: n * 40,
        inferredAtMonoMs: n * 40,
        inferenceMs: 5,
        imageWidth: 1280,
        imageHeight: 720,
        keypoints2D: keypoints,
        detected: true,
        handDetected: false,
        keypointSet: "blaze_33",
      });
    },
  };
}

describe("F-036 · 体尺度与绘制层共用一个门槛", () => {
  it("前置条件：门槛常量确实是绘制层用的那个值", () => {
    // 前提而非结论：如果门槛降到 0，下面几条就不说明任何问题。
    expect(DEFAULT_QUALITY_CONFIG.minScore).toBe(0.5);
    expect(DEFAULT_QUALITY_CONFIG.minScore).toBeGreaterThan(WISPY);
  });

  it("躯干点只有 0.05 置信度 → **不采纳**体尺度（修复前会算出 150px）", () => {
    const { session, push } = makeSession();
    push(body(WISPY, CONFIDENT));

    expect(
      session.telemetry.bodyScalePx,
      "低置信度的躯干仍然算出了体尺度 —— F-036 又回来了",
    ).toBeNull();

    session.dispose();
  });

  it("于是**不画**准备区圈 —— 屏幕不再出现「有圈没骨架」的矛盾帧", () => {
    const { session, push } = makeSession();
    push(body(WISPY, CONFIDENT));
    session.setReadyZone({ x: 640, y: 420 });

    expect(session.readyZoneDisplay, "仍然画了圈 —— 而它的半径来自绘制层拒绝承认的身体").toBeNull();

    session.dispose();
  });

  it("高置信度时一切照旧：体尺度 150px、半径 45px（没把正常路径掐掉）", () => {
    const { session, push } = makeSession();
    push(body(CONFIDENT, CONFIDENT));
    session.setReadyZone({ x: 640, y: 420 });

    // 肩中点→髋中点 = y 200→350 = 150px；半径 = 0.3 × 150 = 45
    expect(session.telemetry.bodyScalePx).toBeCloseTo(150, 6);
    expect(session.readyZoneDisplay?.radiusPx).toBeCloseTo(45, 6);

    session.dispose();
  });

  it("置信度**未知**（`score: null`）不判为不可靠 —— 未知 ≠ 低", () => {
    // 这条防的是"顺手把 null 也掐掉"：手部模型的关键点置信度恒为 null
    // （见 pose.worker.ts），把"未知"当"不可靠"会静默掐掉整条链路。
    const { session, push } = makeSession();
    push(body(null, null));

    expect(
      session.telemetry.bodyScalePx,
      "`score: null` 被当成了「不可靠」 —— 未知不是低，红线 1 的同一条精神",
    ).toBeCloseTo(150, 6);

    session.dispose();
  });
});

describe("F-036 · 刻意保留的不对称：腕部**不**套这个门槛", () => {
  it("腕部置信度只有 0.05，仍然被采纳（这是决定，不是遗漏）", () => {
    const { session, push } = makeSession();
    push(body(CONFIDENT, WISPY));

    // 腕部那条路走的是内部状态估计，已有因果滤波与"本组可判"两层兜底；
    // 而运动模糊下腕部掉置信度是常态（F-006），那类素材没有实测数据，
    // 所以不在这里收紧。谁要改这条断言，请先带来那种素材的测量。
    expect(
      session.telemetry.wristVisible,
      "腕部被门槛掐掉了 —— 这个不对称是有意的，改之前请先读 F-036 的说明",
    ).toBe(true);

    session.dispose();
  });
});
