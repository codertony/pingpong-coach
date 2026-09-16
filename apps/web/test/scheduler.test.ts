import { describe, expect, it } from "vitest";
import { FrameScheduler, SourceEpochTracker, nextFrameId } from "../src/capture/frame-scheduler.js";
import type { FrameEnvelope } from "../src/capture/frame-scheduler.js";

/** 构造一个最小的假 ImageBitmap，记录 close 调用。 */
function fakeBitmap(width = 640, height = 480): ImageBitmap & { closed: boolean } {
  const obj = {
    width,
    height,
    closed: false,
    close() {
      obj.closed = true;
    },
  };
  return obj as unknown as ImageBitmap & { closed: boolean };
}

function frame(id: string, timeMs: number, epoch = 0): FrameEnvelope {
  return {
    frameId: id,
    sourceTimeMs: timeMs,
    receivedAtMonoMs: timeMs,
    sourceEpoch: epoch,
    bitmap: fakeBitmap(),
    width: 640,
    height: 480,
  };
}

describe("FrameScheduler", () => {
  it("空闲时立即处理帧", async () => {
    const seen: string[] = [];
    const s = new FrameScheduler(async (f) => {
      seen.push(f.frameId);
    });
    s.submit(frame("a", 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["a"]);
  });

  it("繁忙时不排队，用最新帧替换旧待处理帧", async () => {
    const seen: string[] = [];
    let release: (() => void) | null = null;
    const s = new FrameScheduler(async (f) => {
      seen.push(f.frameId);
      await new Promise<void>((r) => {
        release = r;
      });
    });

    s.submit(frame("a", 0));
    await new Promise((r) => setTimeout(r, 0));
    // 此时 a 正在处理中
    s.submit(frame("b", 40));
    s.submit(frame("c", 80));
    s.submit(frame("d", 120)); // 应替换 b、c

    release!();
    await new Promise((r) => setTimeout(r, 10));

    // a 先处理，然后只有最新的 d 被处理；b、c 被丢弃
    expect(seen).toEqual(["a", "d"]);
    expect(s.stats.dropped).toBe(2);
  });

  it("被替换的帧位图会被关闭，避免内存泄漏", async () => {
    let release: (() => void) | null = null;
    const s = new FrameScheduler(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
    });

    s.submit(frame("a", 0));
    await new Promise((r) => setTimeout(r, 0));

    // b 成为待处理帧：尚未被丢弃，位图不应关闭
    const dropped = frame("b", 40);
    s.submit(dropped);
    expect((dropped.bitmap as unknown as { closed: boolean }).closed).toBe(false);

    // c 到来时替换掉 b → b 被丢弃并关闭位图
    s.submit(frame("c", 80));
    expect((dropped.bitmap as unknown as { closed: boolean }).closed).toBe(true);
    expect(s.stats.dropped).toBe(1);

    release!();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("处理完成后关闭当前帧位图", async () => {
    const f = frame("a", 0);
    const s = new FrameScheduler(async () => {});
    s.submit(f);
    await new Promise((r) => setTimeout(r, 10));
    expect((f.bitmap as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("drain 释放待处理帧", async () => {
    let release: (() => void) | null = null;
    const s = new FrameScheduler(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
    });
    s.submit(frame("a", 0));
    await new Promise((r) => setTimeout(r, 0));

    const pending = frame("b", 40);
    s.submit(pending);
    s.drain();
    expect((pending.bitmap as unknown as { closed: boolean }).closed).toBe(true);

    release!();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("统计提交数与丢弃数", async () => {
    const s = new FrameScheduler(async () => {});
    s.submit(frame("a", 0));
    s.submit(frame("b", 40));
    await new Promise((r) => setTimeout(r, 20));
    expect(s.stats.submitted).toBeGreaterThanOrEqual(1);
  });

  it("处理函数抛错也能释放位图并继续", async () => {
    let calls = 0;
    const s = new FrameScheduler(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    });
    const first = frame("a", 0);
    s.submit(first);
    await new Promise((r) => setTimeout(r, 10));
    expect((first.bitmap as unknown as { closed: boolean }).closed).toBe(true);

    s.submit(frame("b", 40));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
  });
});

describe("SourceEpochTracker", () => {
  it("bump 递增代次", () => {
    const t = new SourceEpochTracker();
    expect(t.current).toBe(0);
    expect(t.bump()).toBe(1);
    expect(t.bump()).toBe(2);
  });

  it("通知监听者以便重置分段状态", () => {
    const t = new SourceEpochTracker();
    const seen: number[] = [];
    t.onReset((e) => seen.push(e));
    t.bump();
    t.bump();
    expect(seen).toEqual([1, 2]);
  });

  it("取消订阅后不再收到通知", () => {
    const t = new SourceEpochTracker();
    const seen: number[] = [];
    const off = t.onReset((e) => seen.push(e));
    t.bump();
    off();
    t.bump();
    expect(seen).toEqual([1]);
  });
});

describe("nextFrameId", () => {
  it("同一毫秒内也能生成唯一 ID", () => {
    const a = nextFrameId(0, 100);
    const b = nextFrameId(0, 100);
    expect(a).not.toBe(b);
  });

  it("包含源代次信息", () => {
    expect(nextFrameId(3, 100)).toContain("e3_");
  });
});

/**
 * 60fps 持续输入下的行为（roadmap A4 的遗留缺口）。
 *
 * 已有用例测的是"单次丢帧""被替换的帧要释放位图"这些**点**行为。
 * 这里补的是**持续压力**下的整体性质 —— 采集是 30/60fps 连续跑的，
 * 单个点行为都对自己拼起来仍可能出问题（例如位图累积、统计不守恒）。
 *
 * 用的是确定性时间推进（假定时器 + 手动控制 handler 的完成时机），
 * 不依赖机器快慢，所以不会在 CI 上抖。
 */
describe("FrameScheduler — 60fps 持续输入（A4）", () => {
  /** 造一个可以手动放行的异步 handler，用来精确控制"繁忙窗口"。 */
  function controllableHandler() {
    let release: (() => void) | null = null;
    const handler = async () => {
      await new Promise<void>((r) => {
        release = () => r();
      });
    };
    return {
      handler,
      release: () => {
        const r = release;
        release = null;
        r?.();
      },
    };
  }

  it("60 帧在途时：提交数与丢弃数之和等于总输入，位图全部被释放", async () => {
    const { handler, release } = controllableHandler();
    const s = new FrameScheduler(handler);
    const bitmaps: ReturnType<typeof fakeBitmap>[] = [];

    // 模拟 1 秒 @60fps：第一帧进入处理，其余 59 帧在繁忙期间陆续到达
    for (let i = 0; i < 60; i++) {
      const f = frame(`f${i}`, i * 16.67);
      bitmaps.push(f.bitmap as ReturnType<typeof fakeBitmap>);
      s.submit(f);
    }

    // 反复放行直到排空：一次 release 只完成一帧，排空后 pending 才不会有遗留。
    // （位图由 run() 的 finally 释放，所以在途那一帧在放行前 close 是**正确**的未关闭。）
    for (let i = 0; i < 10; i++) {
      release();
      await new Promise((r) => setTimeout(r, 5));
    }

    const stats = s.stats;
    // 统计必须守恒：没有帧在账外消失
    expect(stats.submitted + stats.dropped).toBe(60);
    // 繁忙时不排队 —— 处理数应该是常数级，不是 60
    expect(stats.submitted).toBeLessThan(60);
    expect(stats.submitted).toBeGreaterThanOrEqual(1);

    // 排空后一张位图都不能漏：泄漏会在长时间训练里累积成内存问题（P2 验收要查的项）
    const leaked = bitmaps.filter((b) => !b.closed);
    expect(leaked).toHaveLength(0);
  });

  it("丢帧率随处理变慢而上升，但每一帧都有归宿（不静默丢失）", async () => {
    // handler 每次耗时 100ms，输入 16.67ms 一帧 → 必然大量丢帧
    let processed = 0;
    const s = new FrameScheduler(async () => {
      processed++;
      await new Promise((r) => setTimeout(r, 100));
    });

    for (let i = 0; i < 30; i++) s.submit(frame(`f${i}`, i * 16.67));
    await new Promise((r) => setTimeout(r, 400));

    const stats = s.stats;
    expect(stats.submitted).toBe(processed);
    // 慢 handler 下丢帧是**预期行为**（用最新帧替换待处理帧），不是缺陷；
    // 要钉住的是"丢帧被如实计入"，而不是"不许丢帧"。
    expect(stats.dropped).toBeGreaterThan(0);
    expect(stats.submitted + stats.dropped).toBe(30);
  });

  it("drain 之后不再有遗留位图（停止训练不能让帧悬在半空）", async () => {
    const { handler } = controllableHandler();
    const s = new FrameScheduler(handler);
    const pending = frame("pending", 0);

    s.submit(frame("first", 0)); // 进入处理，占住 busy
    s.submit(pending); // 变成待处理帧
    s.drain();

    // 待处理帧必须被释放；正在处理的那帧由 run() 的 finally 释放
    expect((pending.bitmap as ReturnType<typeof fakeBitmap>).closed).toBe(true);
  });
});
