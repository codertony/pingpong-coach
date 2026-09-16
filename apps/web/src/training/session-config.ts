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
import { DEFAULT_SEGMENTATION } from "@pingpong/motion-core";
import type { TrainingConfig } from "./training-session.js";

/**
 * 切分阈值的**数值不在这里**。
 *
 * 唯一定义处是 `@pingpong/motion-core` 的 `DEFAULT_SEGMENTATION`。
 * 原先是本文件里的一份字面量，而 `configs/thresholds.json` 里还有一份同名快照 ——
 * 三处各写各的，谁都没被校过（见 F-026）。移到 motion-core 是因为
 * "快照与代码一致"那个检查住在 motion-core 的测试里，而 motion-core
 * **不允许依赖本包**，值留在这里那个检查就够不着。
 *
 * 改动必须同步 `docs/acceptance.md` 的阈值变更记录。
 */
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
    ...DEFAULT_SEGMENTATION,
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
