import { describe, expect, it } from "vitest";
import type { SegmentationConfig } from "@pingpong/contracts";
import { StrokeSegmenter, type SegmentationSample } from "../src/segmentation.js";

const CONFIG: SegmentationConfig = {
  strokeType: "forehand_drive",
  cameraView: "front",
  handedness: "right",
  readyZoneRadiusBodyScale: 0.3,
  readyStableMinMs: 80,
  backswingMinDisplacementBodyScale: 0.2,
  forwardMinSpeedBodyScalePerSec: 0.5,
  returnStableMinMs: 80,
  maxGapMs: 200,
  maxStrokeDurationMs: 3000,
};

const READY_CENTER = { x: 640, y: 400 };
const BODY_SCALE = 200; // 200px

/** 生成一个采样点：offsetBodyScale 是相对准备区的偏移（体尺度倍数） */
function sample(
  timeMs: number,
  offsetBodyScale: number,
  opts: {
    quality?: "usable" | "limited" | "unusable";
    /** 用反向偏移模拟挥拍方向 */
    direction?: -1 | 1;
    frameId?: string;
  } = {},
): SegmentationSample {
  const dir = opts.direction ?? 1;
  return {
    frameId: opts.frameId ?? `f_${timeMs}`,
    sourceTimeMs: timeMs,
    wristPx: {
      x: READY_CENTER.x + dir * offsetBodyScale * BODY_SCALE,
      y: READY_CENTER.y,
    },
    wristRelReadyZonePx: { x: dir * offsetBodyScale * BODY_SCALE, y: 0 },
    bodyScalePx: BODY_SCALE,
    quality: opts.quality ?? "usable",
  };
}

/** 走完一次完整挥拍：准备 → 引拍 → 向前 → 回到准备区 */
function feedFullStroke(
  seg: StrokeSegmenter,
  startTimeMs: number,
  stepMs = 40,
): { event: ReturnType<StrokeSegmenter["push"]>; endTimeMs: number } {
  let t = startTimeMs;
  let event = null;

  // 稳定停在准备区
  for (let i = 0; i < 4; i++, t += stepMs) {
    event = event ?? seg.push(sample(t, 0.0));
  }
  // 引拍到后方
  for (const d of [0.15, 0.3, 0.45]) {
    event = event ?? seg.push(sample(t, d, { direction: 1 }));
    t += stepMs;
  }
  // 向前挥拍（偏移快速减小 = 有明显速度）
  for (const d of [0.3, 0.15, 0.05]) {
    event = event ?? seg.push(sample(t, d, { direction: 1 }));
    t += stepMs;
  }
  // 回到准备区并保持
  for (let i = 0; i < 4; i++, t += stepMs) {
    event = event ?? seg.push(sample(t, 0.0));
  }
  return { event, endTimeMs: t };
}

describe("StrokeSegmenter", () => {
  it("会话跑过 maxStrokeDurationMs 之后，挥拍仍能一笔一笔正常闭合（F-025）", () => {
    // 这一条守的是一个**致命**缺陷：超时判定原先用的 `elapsedInStroke`
    // 是在状态机切换**之前**算好的，而 `beginStroke` 是在切换**里面**调用的。
    // 于是"本帧刚开启的挥拍"会被拿去减上一笔清算后的 `strokeStartMs`（= 0），
    // 得到 `elapsed = sourceTimeMs`；一旦会话跑过 3 秒，
    // **每一次挥拍都会在开启的那一帧被判超时丢掉** —— 前 3 秒正常，之后永远记不到。
    //
    // 为什么此前没人发现：既有用例都只喂**一到两笔**挥拍，时间跨度不到 3 秒，
    // 恰好绕开了触发条件。
    const seg = new StrokeSegmenter(CONFIG);
    seg.setReadyZone(READY_CENTER);

    const events = [];
    let t = 0;
    // 连做 8 笔，时间基线必然越过 maxStrokeDurationMs（3000ms）
    for (let i = 0; i < 8; i++) {
      const { event, endTimeMs } = feedFullStroke(seg, t);
      if (event) events.push(event);
      t = endTimeMs + 40;
    }

    expect(t, "测试自身没跑过 3 秒，就测不到这个缺陷").toBeGreaterThan(CONFIG.maxStrokeDurationMs);
    const complete = events.filter((e) => e.complete);
    expect(
      complete.length,
      `8 笔里只闭合了 ${complete.length} 笔 —— 时间越过 3 秒后挥拍开始被当场丢弃`,
    ).toBeGreaterThanOrEqual(6);
  });

  it("未设定准备区前不产生任何事件", () => {
    const seg = new StrokeSegmenter(CONFIG);
    for (let t = 0; t < 400; t += 40) {
      expect(seg.push(sample(t, 0))).toBeNull();
    }
  });

  it("完整挥拍能被识别为 complete，并带腕部速度峰值锚点", () => {
    const seg = new StrokeSegmenter(CONFIG);
    seg.setReadyZone(READY_CENTER);
    const { event } = feedFullStroke(seg, 0);

    expect(event).not.toBeNull();
    expect(event!.complete).toBe(true);
    expect(event!.anchor.type).toBe("wrist_speed_peak");
    // 未识别触球 → impactTimeMs 必须为 null
    expect(event!.impactTimeMs).toBeNull();
    expect(event!.endMs).not.toBeNull();
    expect(event!.endMs!).toBeGreaterThan(event!.anchor.timeMs);
    expect(event!.evidenceFrameIds.length).toBeGreaterThan(0);
  });

  it("连续两次完整挥拍各产生一次事件", () => {
    const seg = new StrokeSegmenter(CONFIG);
    seg.setReadyZone(READY_CENTER);

    const first = feedFullStroke(seg, 0);
    expect(first.event?.complete).toBe(true);

    const second = feedFullStroke(seg, first.endTimeMs + 200);
    expect(second.event?.complete).toBe(true);
    expect(second.event!.strokeId).not.toBe(first.event!.strokeId);
  });

  it("采样间断过大时当前挥拍被标为不完整，不计入有效挥拍", () => {
    const seg = new StrokeSegmenter(CONFIG);
    seg.setReadyZone(READY_CENTER);

    let t = 0;
    for (let i = 0; i < 4; i++, t += 40) seg.push(sample(t, 0));
    // 开始引拍
    let aborted = null;
    for (const d of [0.15, 0.3]) {
      aborted = seg.push(sample(t, d)) ?? aborted;
      t += 40;
    }
    // 突然出现 500ms 的间断（超过 maxGapMs=200）
    const overflow = seg.push(sample(t + 500, 0.3));
    expect(overflow).not.toBeNull();
    expect(overflow!.complete).toBe(false);
    expect(overflow!.reasons).toContain("sampling_gap_too_large");
  });

  it("挥拍总时长超限时异常结束", () => {
    const seg = new StrokeSegmenter({ ...CONFIG, maxStrokeDurationMs: 200 });
    seg.setReadyZone(READY_CENTER);

    let t = 0;
    for (let i = 0; i < 4; i++, t += 40) seg.push(sample(t, 0));
    // 慢慢远离准备区，始终不闭合
    let overflow = null;
    for (const d of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65]) {
      overflow = seg.push(sample(t, d)) ?? overflow;
      t += 40;
      if (overflow) break;
    }
    expect(overflow).not.toBeNull();
    expect(overflow!.complete).toBe(false);
  });

  it("unusable 帧不推进状态，但会污染当前挥拍标记", () => {
    const seg = new StrokeSegmenter(CONFIG);
    seg.setReadyZone(READY_CENTER);

    let t = 0;
    for (let i = 0; i < 4; i++, t += 40) seg.push(sample(t, 0));
    // 引拍途中手臂被遮挡
    seg.push(sample(t, 0.2, { quality: "unusable" }));
    t += 40;

    expect(seg.diagnostics.skippedFrames).toBeGreaterThan(0);
  });

  it("回到准备区后又立即离开，不会误判为已完成", () => {
    const seg = new StrokeSegmenter(CONFIG);
    seg.setReadyZone(READY_CENTER);

    let t = 0;
    for (let i = 0; i < 4; i++, t += 40) seg.push(sample(t, 0));
    // 引拍
    for (const d of [0.15, 0.3, 0.45]) {
      seg.push(sample(t, d));
      t += 40;
    }
    // 向前，接近准备区
    for (const d of [0.3, 0.15]) {
      seg.push(sample(t, d));
      t += 40;
    }
    // 刚进准备区（0.02 在区内）还没待够稳定时间，就再次明确离开（0.45 在区外）
    seg.push(sample(t, 0.02));
    t += 40;
    const stillOpen = seg.push(sample(t, 0.45));
    t += 40;

    // 此时不该闭合，而应退回引拍重新等一次真正的前挥
    expect(stillOpen).toBeNull();
    expect(seg.diagnostics.phase).toBe("backswing");

    // 再向前并稳定回准备区，最终才闭合
    for (const d of [0.1, 0.02]) {
      seg.push(sample(t, d));
      t += 40;
    }
    let done = null;
    for (let i = 0; i < 4 && !done; i++, t += 40) {
      done = seg.push(sample(t, 0.0));
    }
    expect(done).not.toBeNull();
    expect(done!.complete).toBe(true);
  });

  it("间歇性回踩准备区不会被累加成稳定驻留", () => {
    const seg = new StrokeSegmenter(CONFIG);
    seg.setReadyZone(READY_CENTER);

    let t = 0;
    for (let i = 0; i < 4; i++, t += 40) seg.push(sample(t, 0));
    for (const d of [0.15, 0.3, 0.45]) {
      seg.push(sample(t, d));
      t += 40;
    }
    // 向前，但只停在"缓冲区"内（0.05 仍在区内，但随后立刻被拉出去）
    // 关键：每次在区内只停留 1 个采样（40ms < returnStableMinMs=80），
    // 中间必须离开，因此永远凑不满稳定驻留时间。
    seg.push(sample(t, 0.3));
    t += 40;
    let completed = null;
    for (const d of [0.0, 0.6, 0.0, 0.6, 0.0, 0.6, 0.0]) {
      completed = seg.push(sample(t, d));
      t += 40;
      if (completed) break;
    }
    expect(completed).toBeNull();
  });

  it("reset 清空状态，跨片段不污染", () => {
    const seg = new StrokeSegmenter(CONFIG);
    seg.setReadyZone(READY_CENTER);
    let t = 0;
    for (let i = 0; i < 4; i++, t += 40) seg.push(sample(t, 0));
    seg.push(sample(t, 0.3));

    seg.reset();
    expect(seg.diagnostics.phase).toBe("idle");
    expect(seg.diagnostics.skippedFrames).toBe(0);
    expect(seg.diagnostics.abortedCount).toBe(0);
  });

  it("时间非单调时不推进状态机", () => {
    const seg = new StrokeSegmenter(CONFIG);
    seg.setReadyZone(READY_CENTER);
    seg.push(sample(1000, 0));
    const before = seg.diagnostics.phase;
    seg.push(sample(900, 0.5));
    expect(seg.diagnostics.phase).toBe(before);
  });

  it("质量事件在 aborted 后回到 idle，不卡死", () => {
    const seg = new StrokeSegmenter(CONFIG);
    seg.setReadyZone(READY_CENTER);
    let t = 0;
    for (let i = 0; i < 4; i++, t += 40) seg.push(sample(t, 0));
    for (const d of [0.15, 0.3]) {
      seg.push(sample(t, d));
      t += 40;
    }
    seg.push(sample(t + 500, 0.3)); // 触发间断

    // 间断后应能重新开始
    const next = feedFullStroke(seg, t + 1000);
    expect(next.event?.complete).toBe(true);
  });
});
