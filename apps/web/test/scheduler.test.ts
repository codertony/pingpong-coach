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
