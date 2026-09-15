/**
 * 真实 Worker 与真实 ImageBitmap 测试。
 *
 * jsdom 环境里 Worker 无法真正启动，ImageBitmap 也只能用假对象代替。
 * 但本项目最脆弱的地方恰恰在这里：
 * - ImageBitmap 是**需要手动释放**的原生句柄，忘记 close 就是内存泄漏；
 * - 帧调度器在繁忙时要「替换待处理帧并释放被替换的位图」，
 *   如果释放逻辑写错，长时间训练会持续涨内存（这正是 P2 验收要查的项）。
 * 用真实位图 + 真实 Worker 才能测出这类问题。
 */

import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/e2e/fixtures/fixture.html");
  await page.waitForFunction(() => Boolean(window.__fixture));
});

test.describe("真实 Worker 跨线程通信", () => {
  test("Worker 真实启动并能往返消息", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const worker = window.__fixture.makeEchoWorker();
      const reply = await new Promise<{ id: string; ok: boolean; doubled: number }>((resolve) => {
        worker.onmessage = (e) => resolve(e.data);
        worker.postMessage({ id: "req-1", payload: 21 });
      });
      worker.terminate();
      return reply;
    });

    // doubled=42 证明消息真的跨线程走了一趟并带回计算结果。
    expect(result.doubled).toBe(42);
    expect(result.ok).toBe(true);
    expect(result.id).toBe("req-1");
  });

  test("多个并发消息按 id 正确配对，不会串场", async ({ page }) => {
    const results = await page.evaluate(async () => {
      const worker = window.__fixture.makeEchoWorker();
      const send = (id: string, payload: number) =>
        new Promise<{ id: string; doubled: number }>((resolve) => {
          const handler = (e: MessageEvent) => {
            if (e.data.id === id) {
              worker.removeEventListener("message", handler);
              resolve(e.data);
            }
          };
          worker.addEventListener("message", handler);
          worker.postMessage({ id, payload });
        });

      const out = await Promise.all([send("a", 1), send("b", 2), send("c", 3)]);
      worker.terminate();
      return out;
    });

    expect(results.map((r) => `${r.id}=${r.doubled}`).sort()).toEqual(["a=2", "b=4", "c=6"]);
  });

  test("Worker 可以用 createImageBitmap 处理真实位图并回传尺寸", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const src = `
        self.onmessage = async (e) => {
          // 真实位图可以被 transfer 到 Worker 并在那边读取尺寸
          const { bitmap, id } = e.data;
          self.postMessage({ id, width: bitmap.width, height: bitmap.height });
          bitmap.close();
        };
      `;
      const worker = new Worker(
        URL.createObjectURL(new Blob([src], { type: "application/javascript" })),
      );

      const bitmap = await window.__fixture.makeRealBitmap(321, 123);
      const reply = await new Promise<{ width: number; height: number }>((resolve) => {
        worker.onmessage = (ev) => resolve(ev.data);
        // 用 transfer 列表把位图所有权移交 Worker（真实零拷贝路径）
        worker.postMessage({ id: "bmp", bitmap }, [bitmap]);
      });
      worker.terminate();
      return reply;
    });

    expect(result.width).toBe(321);
    expect(result.height).toBe(123);
  });
});

test.describe("真实 ImageBitmap 生命周期", () => {
  test("makeRealBitmap 产出的是真实位图，尺寸正确", async ({ page }) => {
    const dims = await page.evaluate(async () => {
      const bmp = await window.__fixture.makeRealBitmap(200, 100, "blue");
      const d = { width: bmp.width, height: bmp.height };
      bmp.close();
      return d;
    });
    expect(dims).toEqual({ width: 200, height: 100 });
  });

  test("调度器处理完成后释放位图（不泄漏原生句柄）", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const Scheduler = window.__fixture.FrameScheduler;

      let closedCount = 0;
      // 用真实位图，但在测试里包一层以便观察 close 是否被调用。
      const makeFrame = async (id: string) => {
        const bmp = await window.__fixture.makeRealBitmap(64, 64);
        const originalClose = bmp.close.bind(bmp);
        bmp.close = () => {
          closedCount++;
          originalClose();
        };
        return {
          frameId: id,
          sourceTimeMs: 0,
          receivedAtMonoMs: performance.now(),
          sourceEpoch: 0,
          bitmap: bmp,
          width: 64,
          height: 64,
        };
      };

      const scheduler = new Scheduler(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });

      scheduler.submit(await makeFrame("f1"));
      await new Promise((r) => setTimeout(r, 40));

      return { closedCount };
    });

    // 处理完成后必须 close，否则每帧泄漏一张全分辨率位图。
    expect(result.closedCount).toBe(1);
  });

  test("繁忙时被替换的待处理帧，其位图也被释放（这是最容易漏的一处）", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const Scheduler = window.__fixture.FrameScheduler;
      const closed: string[] = [];

      const makeFrame = async (id: string) => {
        const bmp = await window.__fixture.makeRealBitmap(32, 32);
        const originalClose = bmp.close.bind(bmp);
        bmp.close = () => {
          closed.push(id);
          originalClose();
        };
        return {
          frameId: id,
          sourceTimeMs: 0,
          receivedAtMonoMs: performance.now(),
          sourceEpoch: 0,
          bitmap: bmp,
          width: 32,
          height: 32,
        };
      };

      // 让 handler 长时间占住 busy，这样后续提交都会走「替换」分支
      const scheduler = new Scheduler(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });

      scheduler.submit(await makeFrame("first"));
      await new Promise((r) => setTimeout(r, 5));
      scheduler.submit(await makeFrame("pending-1"));
      await new Promise((r) => setTimeout(r, 5));
      // pending-1 应被 pending-2 替换，且 pending-1 的位图必须被释放
      scheduler.submit(await makeFrame("pending-2"));

      await new Promise((r) => setTimeout(r, 200));

      return { closed, stats: scheduler.stats };
    });

    // pending-1 必须出现在已释放列表里，否则就是内存泄漏。
    expect(result.closed).toContain("pending-1");
    expect(result.closed).toContain("first");
    expect(result.closed).toContain("pending-2");
    // 丢帧也应被如实计入统计
    expect(result.stats.dropped).toBeGreaterThanOrEqual(1);
  });

  test("处理函数抛错时位图仍被释放（异常路径不能漏掉释放）", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const Scheduler = window.__fixture.FrameScheduler;
      let closed = 0;

      const bmp = await window.__fixture.makeRealBitmap(16, 16);
      const originalClose = bmp.close.bind(bmp);
      bmp.close = () => {
        closed++;
        originalClose();
      };

      const scheduler = new Scheduler(async () => {
        throw new Error("模拟推理失败");
      });

      scheduler.submit({
        frameId: "boom",
        sourceTimeMs: 0,
        receivedAtMonoMs: performance.now(),
        sourceEpoch: 0,
        bitmap: bmp,
        width: 16,
        height: 16,
      });

      await new Promise((r) => setTimeout(r, 50));
      return { closed, stats: scheduler.stats };
    });

    expect(result.closed).toBe(1);
  });
});

test.describe("bytesToBase64 在真实浏览器环境", () => {
  test("编码结果可被浏览器 atob 还原（往返一致）", async ({ page }) => {
    const ok = await page.evaluate(() => {
      const bytes = window.__fixture.makeBytes(1000);
      const b64 = window.__fixture.bytesToBase64(bytes);
      const decoded = atob(b64);
      if (decoded.length !== bytes.length) return false;
      for (let i = 0; i < bytes.length; i++) {
        if (decoded.charCodeAt(i) !== bytes[i]) return false;
      }
      return true;
    });
    // 这条在真实浏览器里验证，是因为实现依赖全局 btoa。
    expect(ok).toBe(true);
  });

  test("大块字节编码不栈溢出（分块实现正确性）", async ({ page }) => {
    const result = await page.evaluate(() => {
      const bytes = window.__fixture.makeBytes(300_000);
      try {
        const b64 = window.__fixture.bytesToBase64(bytes);
        return { ok: true, length: b64.length };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    expect(result.ok).toBe(true);
    // base64 长度约为原字节的 4/3
    expect((result as { length: number }).length).toBeGreaterThan(300_000);
  });
});
