/**
 * 关键帧采集的单元测试（F-028）。
 *
 * 这里覆盖**不需要 canvas** 的那部分：
 * - 缩放尺寸的计算（纯函数）；
 * - 抽帧节奏（每 N 帧才编一张）；
 * - 错误隔离（编码失败/返回 null 时不得冒出异常、也不得塞空图）。
 *
 * 真正的 JPEG 编码需要 `OffscreenCanvas`，jsdom 没有，所以那一段由
 * `apps/web/e2e/keyframe-capture.e2e.ts` 在真实浏览器里覆盖。
 */

import { describe, expect, it, vi } from "vitest";
import {
  KEYFRAME_CAPTURE_EVERY_N_FRAMES,
  MAX_KEYFRAME_LONG_EDGE_PX,
  createKeyframeCapturer,
  fitWithinLongEdge,
  type EncodedKeyframe,
  type KeyframeSink,
} from "../src/evidence/keyframe-capture.js";

/** 假的位图：采集器只用到它的 width/height，编码器又被替换掉了。 */
const fakeBitmap = { width: 1280, height: 720 } as unknown as ImageBitmap;

function makeSink() {
  const calls: Array<{
    frameId: string;
    sourceTimeMs: number;
    bytes: number;
    w: number;
    h: number;
  }> = [];
  const sink: KeyframeSink = {
    addFramePixels(frameId, sourceTimeMs, bytes, width, height) {
      calls.push({ frameId, sourceTimeMs, bytes: bytes.byteLength, w: width, h: height });
    },
  };
  return { sink, calls };
}

describe("fitWithinLongEdge", () => {
  it("长边已在上限内 → 原样返回（不放大）", () => {
    expect(fitWithinLongEdge(640, 360, 960)).toEqual({ width: 640, height: 360 });
    expect(fitWithinLongEdge(960, 540, 960)).toEqual({ width: 960, height: 540 });
  });

  it("横图按长边等比缩小", () => {
    // 1280×720 → 长边压到 960，短边同比 540
    expect(fitWithinLongEdge(1280, 720, MAX_KEYFRAME_LONG_EDGE_PX)).toEqual({
      width: 960,
      height: 540,
    });
  });

  it("竖图同样按长边（而不是宽）缩小", () => {
    expect(fitWithinLongEdge(720, 1280, 960)).toEqual({ width: 540, height: 960 });
  });

  it("极端窄图短边不会算成 0", () => {
    // 若短边被算成 0，画布就是 0 高，编码必失败
    const r = fitWithinLongEdge(10000, 3, 960);
    expect(r).not.toBeNull();
    expect(r!.height).toBeGreaterThanOrEqual(1);
  });

  it("非法输入返回 null（让调用方明确跳过，而不是产出坏图）", () => {
    expect(fitWithinLongEdge(0, 720, 960)).toBeNull();
    expect(fitWithinLongEdge(1280, -1, 960)).toBeNull();
    expect(fitWithinLongEdge(Number.NaN, 720, 960)).toBeNull();
    expect(fitWithinLongEdge(1280, 720, 0)).toBeNull();
  });
});

describe("createKeyframeCapturer · 抽帧节奏", () => {
  it(`每 ${KEYFRAME_CAPTURE_EVERY_N_FRAMES} 帧才编一张，其余帧直接跳过`, async () => {
    const encode = vi.fn(async (): Promise<EncodedKeyframe> => ({
      bytes: new Uint8Array([1, 2, 3]),
      width: 960,
      height: 540,
    }));
    const capturer = createKeyframeCapturer({ everyNFrames: 3, encode });
    const { sink, calls } = makeSink();

    for (let i = 0; i < 9; i++) {
      capturer.captureIfDue(sink, { frameId: `f${i}`, sourceTimeMs: i * 33, bitmap: fakeBitmap });
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(encode).toHaveBeenCalledTimes(3); // f0 / f3 / f6
    expect(calls.map((c) => c.frameId)).toEqual(["f0", "f3", "f6"]);
  });

  it("编码完成前就返回（不阻塞采集）", () => {
    // 用"确定性赋值断言"而不是先赋 null：后者会让 TS 把变量窄化成 null，
    // 到了下面调用时报 "This expression is not callable"。
    let resolveEncode!: (v: EncodedKeyframe) => void;
    const encode = () =>
      new Promise<EncodedKeyframe>((res) => {
        resolveEncode = res;
      });
    const capturer = createKeyframeCapturer({ everyNFrames: 1, encode });
    const { sink, calls } = makeSink();

    // 编码还挂着，这里必须已经返回
    capturer.captureIfDue(sink, { frameId: "f0", sourceTimeMs: 0, bitmap: fakeBitmap });
    expect(calls).toHaveLength(0);

    resolveEncode({ bytes: new Uint8Array([9]), width: 960, height: 540 });
  });
});

describe("createKeyframeCapturer · 错误隔离与空图", () => {
  it("编码抛错不会冒出来（采集链路不能被它带下去）", async () => {
    const encode = vi.fn(async () => {
      throw new Error("编码炸了");
    });
    const capturer = createKeyframeCapturer({ everyNFrames: 1, encode });
    const { sink, calls } = makeSink();

    expect(() =>
      capturer.captureIfDue(sink, { frameId: "f0", sourceTimeMs: 0, bitmap: fakeBitmap }),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("编码返回 null（尺寸非法/编码失败）时不塞任何东西", async () => {
    const encode = vi.fn(async () => null);
    const capturer = createKeyframeCapturer({ everyNFrames: 1, encode });
    const { sink, calls } = makeSink();

    capturer.captureIfDue(sink, { frameId: "f0", sourceTimeMs: 0, bitmap: fakeBitmap });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("sink 为 null（还没开始会话）时什么都不做，也不崩", () => {
    const encode = vi.fn(async () => null);
    const capturer = createKeyframeCapturer({ everyNFrames: 1, encode });
    expect(() =>
      capturer.captureIfDue(null, { frameId: "f0", sourceTimeMs: 0, bitmap: fakeBitmap }),
    ).not.toThrow();
    expect(encode).not.toHaveBeenCalled();
  });
});
