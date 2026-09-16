/**
 * 训练会话配置的**唯一**构造处。
 *
 * 为什么单独一个模块：这套切分阈值原先只写在 `App.tsx` 里。
 * 而评估（`e2e/segmentation-eval.e2e.ts` → `scripts/eval-replay.mjs`）必须用
 * **产品实际用的同一套值**去跑，否则量出来的不是产品行为。
 *
 * 一开始我打算在评估侧抄一份 —— 那正是本项目反复出问题的那类做法：
 * **同一个事实在两处各写各的，改一处忘另一处**（F-017 / F-018 / F-019 都是这个形态）。
 * 所以改成两边都从这里取。
 */

import type { SegmentationConfig } from "@pingpong/contracts";
import type { TrainingConfig } from "./training-session.js";

/**
 * 切分阈值。全部是**暂定值**，未按真实素材校准过（见 `configs/thresholds.json` 的说明）。
 * 改动必须同步 `docs/acceptance.md` 的阈值变更记录。
 */
const SEGMENTATION_DEFAULTS = {
  readyZoneRadiusBodyScale: 0.3,
  readyStableMinMs: 120,
  backswingMinDisplacementBodyScale: 0.2,
  forwardMinSpeedBodyScalePerSec: 0.5,
  returnStableMinMs: 120,
  maxGapMs: 250,
  maxStrokeDurationMs: 3000,
} as const;

export interface SessionConfigInput {
  sessionId: string;
  handedness: "left" | "right";
  cameraView: string;
  focusId: string;
  strokesPerGroup: number;
}

function buildSegmentationConfig(
  input: Pick<SessionConfigInput, "handedness" | "cameraView">,
): SegmentationConfig {
  return {
    strokeType: "forehand_drive",
    cameraView: input.cameraView,
    handedness: input.handedness,
    ...SEGMENTATION_DEFAULTS,
  };
}

export function buildTrainingConfig(input: SessionConfigInput): TrainingConfig {
  return {
    sessionId: input.sessionId,
    strokeType: "forehand_drive",
    handedness: input.handedness,
    cameraView: input.cameraView,
    focusId: input.focusId,
    strokesPerGroup: input.strokesPerGroup,
    segmentation: buildSegmentationConfig(input),
  };
}
