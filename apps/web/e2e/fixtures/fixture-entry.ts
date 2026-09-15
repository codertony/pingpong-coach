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
      analyzeGroup: typeof analyzeGroup;
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
  makeRealBitmap,
  makeEchoWorker,
  makeBytes,
};
