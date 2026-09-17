/**
 * 遥测口径测试。
 *
 * 守的是一件事：**"端到端处理延迟"不能退化成"只算推理那段"**。
 *
 * 曾经的写法就是 `poseProcessingP95Ms = result.inferenceMs` ——
 * 那只算 Worker 内的推理，把调度器排队与跨线程往返全排除了，
 * 而这两段恰恰是最容易出问题、也最容易被漏掉的部分。
 * 界面把它标成"姿态处理 P95"，用户会以为那是自己感受到的延迟。
 *
 * 这里用**构造的** receivedAtMonoMs / inferredAtMonoMs / inferenceMs
 * 把两者拆开，钉住"端到端 ≥ 推理本身"以及"两者各自独立统计"。
 *
 * ⚠️ **这组测试覆盖不到的一件事**：两个时刻必须**同源**（都在主线程盖章）。
 * 这里两者都是构造出来的，天然同源，所以"Worker 时钟与主线程时钟不同源"
 * 这个前提在本文件里**永远不成立** —— 那正是 F-024 溜过去的原因。
 * 那一层由 `e2e/pose-engine.e2e.ts` 的"用主线程时钟重新盖章"一项守着。
 */

import { describe, expect, it } from "vitest";
import { TrainingSession, type TrainingConfig } from "../src/training/training-session.js";
import type { PoseResult } from "../src/vision/pose-engine.js";
import type { Keypoint2D } from "@pingpong/contracts";

const CONFIG: TrainingConfig = {
  sessionId: "s1",
  strokeType: "forehand_drive",
  handedness: "right",
  cameraView: "front",
  focusId: "return_to_ready_zone",
  strokesPerGroup: 99, // 不触发成组，只观察遥测
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

function bodyPoints(): Keypoint2D[] {
  return [
    { name: "left_shoulder", xPx: 600, yPx: 200, score: 0.9, visible: true },
    { name: "right_shoulder", xPx: 680, yPx: 200, score: 0.9, visible: true },
    { name: "left_hip", xPx: 610, yPx: 400, score: 0.9, visible: true },
    { name: "right_hip", xPx: 670, yPx: 400, score: 0.9, visible: true },
    { name: "right_wrist", xPx: 640, yPx: 420, score: 0.9, visible: true },
  ];
}

/** 造一帧结果：显式给出"收到时刻"与"推理完成时刻"，以及推理本身耗时。 */
function result(
  i: number,
  opts: { receivedAt: number; inferredAt: number; inferenceMs: number },
): PoseResult {
  return {
    frameId: `f${i}`,
    sourceEpoch: 0,
    sourceTimeMs: i * 33,
    receivedAtMonoMs: opts.receivedAt,
    inferredAtMonoMs: opts.inferredAt,
    inferenceMs: opts.inferenceMs,
    imageWidth: 1280,
    imageHeight: 720,
    keypoints2D: bodyPoints(),
    detected: true,
    handDetected: false,
    keypointSet: "blaze_33",
  };
}

function makeSession(): TrainingSession {
  return new TrainingSession(CONFIG, {
    onStatus: () => {},
    onStroke: () => {},
    onFeedback: () => {},
    onGroupComplete: () => {},
  });
}

describe("训练遥测的延迟口径", () => {
  it("端到端延迟用「收到帧 → 结果可用」，而不是推理耗时", () => {
    const s = makeSession();
    // 推理只要 5ms，但从收到到结果出来过了 40ms（排队 + 跨线程）
    for (let i = 0; i < 20; i++) {
      s.pushPoseResult(
        result(i, { receivedAt: i * 100, inferredAt: i * 100 + 40, inferenceMs: 5 }),
      );
    }

    const t = s.telemetry;
    expect(t.poseLatencyP95Ms).toBeCloseTo(40, 0);
    expect(t.poseInferenceP95Ms).toBeCloseTo(5, 0);
    // 关键：两个口径必须分开，端到端要**显著大于**推理本身
    expect(t.poseLatencyP95Ms!).toBeGreaterThan(t.poseInferenceP95Ms!);
  });

  it("两者各自独立统计，不被彼此污染", () => {
    const s = makeSession();
    // 前 10 帧：端到端 100ms、推理 10ms；后 10 帧：端到端 10ms、推理 1ms
    for (let i = 0; i < 10; i++) {
      s.pushPoseResult(
        result(i, { receivedAt: i * 200, inferredAt: i * 200 + 100, inferenceMs: 10 }),
      );
    }
    for (let i = 10; i < 20; i++) {
      s.pushPoseResult(
        result(i, { receivedAt: i * 200, inferredAt: i * 200 + 10, inferenceMs: 1 }),
      );
    }

    const t = s.telemetry;
    // P95 落在较慢的那一档，两个指标都该体现出来
    expect(t.poseLatencyP95Ms).toBeCloseTo(100, 0);
    expect(t.poseInferenceP95Ms).toBeCloseTo(10, 0);
  });

  it("没有样本时两个口径都是 null，而不是 0", () => {
    const t = makeSession().telemetry;
    // 0 是合法的延迟读数，与"还没测到"必须可区分
    expect(t.poseLatencyP95Ms).toBeNull();
    expect(t.poseInferenceP95Ms).toBeNull();
  });

  it("dispose 清空延迟样本，不把整段历史挂在对象上", () => {
    const s = makeSession();
    for (let i = 0; i < 30; i++) {
      s.pushPoseResult(
        result(i, { receivedAt: i * 100, inferredAt: i * 100 + 20, inferenceMs: 3 }),
      );
    }
    expect(s.telemetry.poseLatencyP95Ms).not.toBeNull();

    s.dispose();
    expect(s.telemetry.poseLatencyP95Ms).toBeNull();
    expect(s.telemetry.poseInferenceP95Ms).toBeNull();
  });
});

/**
 * 「帧率四列」里的第四列：**编进缓存的 JPEG 张数**（设计 §1.5.1）。
 *
 * 为什么要单独数：抽帧是**每 3 帧一张**，所以这一列天然比"进模型的帧数"少一个量级；
 * 而"这一组图很少"到底是被抽帧抽掉的、还是编码一直在失败，只有把这个数摆出来才分得清
 * （F-028 的教训：图片链路整条断掉时，全线一声不响）。
 */
describe("帧率四列的第四列 · JPEG 候选张数", () => {
  it("每放进缓存一张就 +1；空字节不算（那等于没图）", () => {
    const s = new TrainingSession(CONFIG, {
      onStatus: () => {},
      onStroke: () => {},
      onFeedback: () => {},
      onGroupComplete: () => {},
    });
    const before = s.telemetry.keyframeJpegsCaptured;
    s.addFramePixels("f1", 0, new Uint8Array([1, 2, 3]), 960, 540);
    s.addFramePixels("f2", 40, new Uint8Array([4, 5, 6]), 960, 540);
    // 空字节：编码失败的产物，塞进去等于"有图"，所以必须挡在外面且不计数
    s.addFramePixels("f3", 80, new Uint8Array(0), 960, 540);
    expect(s.telemetry.keyframeJpegsCaptured).toBe(before + 2);
    s.dispose();
  });

  it("它不受关键帧张数上限影响（抽帧数是采集事实，不是每组的挑选结果）", () => {
    const s = new TrainingSession(CONFIG, {
      onStatus: () => {},
      onStroke: () => {},
      onFeedback: () => {},
      onGroupComplete: () => {},
    });
    // 连放 30 张：远多于"每组最多 6 张"的挑选上限
    for (let i = 0; i < 30; i++) {
      s.addFramePixels(`f${i}`, i * 40, new Uint8Array([i]), 960, 540);
    }
    expect(s.telemetry.keyframeJpegsCaptured).toBe(30);
    s.dispose();
  });
});
