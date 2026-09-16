/**
 * 浏览器测试夹具页。
 *
 * 这是一个**真实的浏览器页面**，由 Vite 构建后由 Playwright 打开。
 * 它把待测模块挂到 window 上，让测试可以在真实 DOM / Canvas / Worker
 * 环境里驱动它们，而不是用 jsdom 近似。
 *
 * 为什么需要真实浏览器：
 * - Canvas 2D 在 jsdom 里没有实现，`getImageData` 取不到真实像素；
 * - Worker 在 jsdom 里无法真实启动与通信；
 * - ImageBitmap 是浏览器原生句柄，jsdom 只能用假对象替代。
 * 这三件事恰恰是本项目最容易出错的地方（位图转移、Worker 协议、绘制坐标）。
 */

import { drawSkeleton, drawReadyZone } from "../../src/training/skeleton-overlay.js";
import {
  FrameScheduler,
  SourceEpochTracker,
  nextFrameId,
  monotonicNow,
} from "../../src/capture/frame-scheduler.js";
import {
  KeyframeCache,
  selectRepresentativeFrames,
  bytesToBase64,
} from "../../src/evidence/evidence-builder.js";
import { SpeechChannel, toSpeechText } from "../../src/audio/speech-channel.js";
import { fetchHealth, analyzeGroup } from "../../src/review/api-client.js";
import { PoseEngine } from "../../src/vision/pose-engine.js";
import { MODEL_ASSET } from "../../src/config/model-asset.js";
import { TrainingSession } from "../../src/training/training-session.js";
import { assignHandsToSides } from "@pingpong/motion-core";
import type { EvidencePacket, Keypoint2D } from "@pingpong/contracts";

/**
 * 指定本次要打哪个后端实例。
 *
 * 为什么需要：红线 8（模型输出必须在服务端校验）只有让请求走到**模型调用
 * 之后**的校验段才测得到，而 mock 模式根本不经过模型调用。所以测试要能把
 * 请求打到另一个以 live 模式启动、模型端点指向本地假供应商的 API 实例。
 *
 * 这是**测试专用入口**，产品代码从不调用（见 src/review/api-client.ts 的
 * `apiBase()`）。不设置时走同源 /api 代理，与生产行为一致。
 */
function setApiBase(base: string | null): void {
  if (base == null) delete (globalThis as { __apiBase?: string }).__apiBase;
  else (globalThis as { __apiBase?: string }).__apiBase = base;
}

declare global {
  interface Window {
    __fixture: {
      drawSkeleton: typeof drawSkeleton;
      drawReadyZone: typeof drawReadyZone;
      FrameScheduler: typeof FrameScheduler;
      SourceEpochTracker: typeof SourceEpochTracker;
      nextFrameId: typeof nextFrameId;
      monotonicNow: typeof monotonicNow;
      KeyframeCache: typeof KeyframeCache;
      selectRepresentativeFrames: typeof selectRepresentativeFrames;
      bytesToBase64: typeof bytesToBase64;
      SpeechChannel: typeof SpeechChannel;
      toSpeechText: typeof toSpeechText;
      fetchHealth: typeof fetchHealth;
      PoseEngine: typeof PoseEngine;
      /** 产品实际使用的模型资产配置。测试要跑真实 worker 就得用它，而不是自己拼一份 */
      MODEL_ASSET: typeof MODEL_ASSET;
      analyzeGroup: typeof analyzeGroup;
      TrainingSession: typeof TrainingSession;
      /** 手部左右分配（纯计算）。暴露它是为了让测试能**用产品逻辑**验证真实手部数据 */
      assignHandsToSides: typeof assignHandsToSides;
      /** 测试专用：把后续 API 请求指向指定后端实例；传 null 恢复同源 /api */
      setApiBase: typeof setApiBase;
      /**
       * 用合成关键点驱动一次**真实的** TrainingSession，走完"攒够挥拍 →
       * 产出证据包"，返回它真正吐出的 EvidencePacket。
       *
       * 为什么用真实会话而不是手搓一个包：手搓的包只能证明"后端收得下这个形状"，
       * 而这里要证的是**前端真的会产出后端收得下的东西** ——
       * 契约两侧静默脱节正是分段测试抓不到的那类问题。
       */
      runSyntheticGroup: (opts?: {
        strokes?: number;
        handedness?: "left" | "right";
      }) => Promise<EvidencePacket | null>;
      /** 造一个真实的 ImageBitmap（用 OffscreenCanvas 生成，不依赖图片文件） */
      makeRealBitmap: (w: number, h: number, color?: string) => Promise<ImageBitmap>;
      /** 造一段真实 Worker 脚本并返回真实 Worker 实例 */
      makeEchoWorker: () => Worker;
      /** 造一个真实的 Blob，用于 bytesToBase64 测试 */
      makeBytes: (n: number) => Uint8Array;
    };
  }
}

async function makeRealBitmap(w: number, h: number, color = "red"): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
  }
  return createImageBitmap(canvas);
}

function makeEchoWorker(): Worker {
  const src = `
    self.onmessage = (e) => {
      const { id, payload } = e.data;
      // 真实 Worker 往返：回显并做一次计算，证明消息真的跨线程走了一趟。
      self.postMessage({ id, ok: true, doubled: payload * 2, ua: self.navigator.userAgent });
    };
  `;
  const blob = new Blob([src], { type: "application/javascript" });
  return new Worker(URL.createObjectURL(blob));
}

function makeBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  for (let i = 0; i < n; i++) arr[i] = i % 256;
  return arr;
}

/**
 * 用合成关键点驱动一次**真实的** TrainingSession。
 *
 * 关键设计：
 * - 喂的是 `PoseResult`（引擎输出的形状），不是 `PoseFrame` —— 这样
 *   质量评估、滤波、分段、特征、证据打包**全部真实执行**，只有"关键点从哪来"
 *   是合成的。
 * - 关键点按真实像素坐标给（不是归一化），与引擎适配层的输出一致。
 * - 相机固定、机位正面、右手持拍，与默认配置一致。
 *
 * 返回会话真正吐出的证据包；未在限定帧数内成组则返回 null。
 */
async function runSyntheticGroup(
  opts: {
    strokes?: number;
    handedness?: "left" | "right";
  } = {},
): Promise<EvidencePacket | null> {
  const strokesWanted = opts.strokes ?? 3;
  const handedness = opts.handedness ?? "right";

  const READY = { x: 640, y: 420 };
  // 体尺度 = 肩中点—髋中点的距离；这里固定 200px（肩 y=200、髋 y=400）
  const SHOULDER_Y = 200;
  const HIP_Y = 400;
  const BODY_SCALE = HIP_Y - SHOULDER_Y;

  const bodyPoints = (): Keypoint2D[] => [
    { name: "nose", xPx: 640, yPx: 120, score: 0.95, visible: true },
    { name: "left_shoulder", xPx: 600, yPx: SHOULDER_Y, score: 0.9, visible: true },
    { name: "right_shoulder", xPx: 680, yPx: SHOULDER_Y, score: 0.9, visible: true },
    { name: "left_elbow", xPx: 580, yPx: 280, score: 0.9, visible: true },
    { name: "right_elbow", xPx: 700, yPx: 280, score: 0.9, visible: true },
    { name: "left_hip", xPx: 610, yPx: HIP_Y, score: 0.9, visible: true },
    { name: "right_hip", xPx: 670, yPx: HIP_Y, score: 0.9, visible: true },
    { name: "left_knee", xPx: 605, yPx: 520, score: 0.9, visible: true },
    { name: "right_knee", xPx: 675, yPx: 520, score: 0.9, visible: true },
    { name: "left_ankle", xPx: 600, yPx: 640, score: 0.9, visible: true },
    { name: "right_ankle", xPx: 680, yPx: 640, score: 0.9, visible: true },
  ];

  let packet: EvidencePacket | null = null;
  const session = new TrainingSession(
    {
      sessionId: `s_e2e_${Date.now()}`,
      strokeType: "forehand_drive",
      handedness,
      cameraView: "front",
      focusId: "return_to_ready_zone",
      strokesPerGroup: strokesWanted,
      segmentation: {
        strokeType: "forehand_drive",
        cameraView: "front",
        handedness,
        readyZoneRadiusBodyScale: 0.3,
        readyStableMinMs: 120,
        backswingMinDisplacementBodyScale: 0.2,
        forwardMinSpeedBodyScalePerSec: 0.5,
        returnStableMinMs: 120,
        maxGapMs: 250,
        maxStrokeDurationMs: 3000,
      },
    },
    {
      onStatus: () => {},
      onStroke: () => {},
      onFeedback: () => {},
      onGroupComplete: (p) => {
        packet = p;
      },
    },
  );

  session.setReadyZone(READY);

  const wristName = handedness === "right" ? "right_wrist" : "left_wrist";
  /**
   * 挥拍相位序列（单位：体尺度比例）。
   *
   * ⚠️ 这里的形状是**实测调出来的**，不是随意写的，原因在因果滤波：
   *
   * 走完整 `pushPoseResult` 路径时，腕部会先经过 One-Euro 因果滤波。
   * 该滤波器对**突变**会显著滞后 —— 实测单帧尖峰（0.45 只出现一帧）时，
   * 滤波后的距离峰值只到 0.30 体尺度，而离开阈值是「半径 × 1.2 = 0.36」，
   * 于是**永远进不了引拍**，最后 `stroke_too_long`。
   *
   * 所以每个相位都**保持若干帧**，给滤波器收敛时间。这也更接近真实挥拍：
   * 真实引拍有短暂停留，不是单帧尖峰。
   *
   * （单测 `segmentation.test.ts` 不受影响，因为它直接把已滤波的位置喂给状态机，
   * 不经过这一层。）
   */
  const offsets = [
    // 准备驻留：6 帧 × 40ms = 240ms ≥ readyStableMinMs(120ms)
    0, 0, 0, 0, 0, 0,
    // 引拍：逐步远离，并在峰值停留 3 帧让滤波收敛
    0.2, 0.45, 0.45, 0.45, 0.45,
    // 向前挥拍：偏移快速减小 = 有明显速度
    0.3, 0.15, 0.05,
    // 回到准备区并驻留：6 帧 = 240ms ≥ returnStableMinMs(120ms)
    0, 0, 0, 0, 0, 0,
  ];
  /** 帧间隔。用 40ms（与单测一致）而不是 33ms，给滤波更多响应时间。 */
  const FRAME_MS = 40;

  let t = 0;
  const statuses: string[] = [];
  for (let cycle = 0; cycle < strokesWanted + 4 && !packet; cycle++) {
    for (const offset of offsets) {
      if (packet) break;
      const wrist: Keypoint2D = {
        name: wristName,
        xPx: READY.x + offset * BODY_SCALE,
        yPx: READY.y,
        score: 0.9,
        visible: true,
      };
      session.pushPoseResult({
        frameId: `e2e_f${cycle}_${t}`,
        sourceEpoch: 0,
        sourceTimeMs: t,
        receivedAtMonoMs: t,
        inferredAtMonoMs: t,
        inferenceMs: 5,
        imageWidth: 1280,
        imageHeight: 720,
        keypoints2D: [...bodyPoints(), wrist],
        detected: true,
        handDetected: false,
        keypointSet: "blaze_33",
      });
      t += FRAME_MS;
    }
    const snap = session.currentSnapshot;
    statuses.push(
      `cycle${cycle}: strokes=${snap.strokes.length} phase=${session.telemetry.segmentationPhase} ` +
        `abort=${session.telemetry.segmentationLastAbortReason ?? "-"}`,
    );
  }

  // 未成组时把会话内部状态留在 window 上 —— 否则"包是空的"无从定位。
  // 刻意不打印：测试输出里混进调试日志会掩盖真正的失败信息。
  (window as unknown as { __lastSyntheticRun?: unknown }).__lastSyntheticRun = {
    completed: packet != null,
    frames: t / FRAME_MS,
    statuses,
  };

  session.dispose();
  return packet;
}

window.__fixture = {
  drawSkeleton,
  drawReadyZone,
  FrameScheduler,
  SourceEpochTracker,
  nextFrameId,
  monotonicNow,
  KeyframeCache,
  selectRepresentativeFrames,
  bytesToBase64,
  SpeechChannel,
  toSpeechText,
  fetchHealth,
  analyzeGroup,
  PoseEngine,
  MODEL_ASSET,
  TrainingSession,
  assignHandsToSides,
  setApiBase,
  runSyntheticGroup,
  makeRealBitmap,
  makeEchoWorker,
  makeBytes,
};
