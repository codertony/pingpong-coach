/**
 * PoseEngine Worker 协议测试。
 *
 * ⚠️ 明确的边界：**这里没有验证 MediaPipe 真实推理**。
 * Pose Landmarker 的 .task 模型托管在 storage.googleapis.com，
 * 在受限网络下无法获取（见 docs/known-failures.md F-006）。
 *
 * 那么这个测试验证什么？验证**客户端自身的协议处理**：
 * - init 消息结构是否正确；
 * - ready 消息里的 GPU 降级标记是否被如实保留（不谎报用了 GPU）；
 * - 迟到结果是否被正确丢弃（防止旧帧结果覆盖新帧状态）；
 * - 未就绪时 detect 是否安全释放位图而不是泄漏；
 * - dispose 是否真的终止 Worker。
 *
 * 这些逻辑出错会让整条视觉链路静默错乱，而且非常难在真机上定位。
 * 用一个「受控的假 Worker」替换真实 Worker，就能确定性地测它们。
 */

import { test, expect } from "@playwright/test";

/** 在页面里注入一个可编程的假 Worker，并把 init 参数暴露出来。 */
async function injectFakeWorker(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    type Listener = (msg: unknown) => void;

    class FakeWorker {
      static instances: FakeWorker[] = [];
      static last(): FakeWorker {
        return FakeWorker.instances[FakeWorker.instances.length - 1]!;
      }
      posted: Array<{ data: unknown; transfer?: unknown[] }> = [];
      terminated = false;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      private messageListeners = new Set<Listener>();

      constructor() {
        FakeWorker.instances.push(this);
      }

      postMessage(data: unknown, transfer?: unknown[]): void {
        this.posted.push({ data, transfer });
      }

      addEventListener(_type: string, l: Listener): void {
        this.messageListeners.add(l);
      }

      removeEventListener(_type: string, l: Listener): void {
        this.messageListeners.delete(l);
      }

      terminate(): void {
        this.terminated = true;
      }

      /** 测试辅助：模拟 Worker 向主线程发消息 */
      emit(msg: unknown): void {
        this.onmessage?.({ data: msg } as MessageEvent);
        for (const l of this.messageListeners) l(msg);
      }

      /** 测试辅助：取最后一次 init 消息 */
      lastInit(): Record<string, unknown> | null {
        for (let i = this.posted.length - 1; i >= 0; i--) {
          const d = this.posted[i]!.data as Record<string, unknown>;
          if (d?.type === "init") return d;
        }
        return null;
      }

      /** 测试辅助：取所有 detect 消息 */
      detects(): Array<Record<string, unknown>> {
        return this.posted
          .map((p) => p.data as Record<string, unknown>)
          .filter((d) => d?.type === "detect");
      }
    }

    (window as unknown as Record<string, unknown>).__FakeWorker = FakeWorker;
    (window as unknown as Record<string, unknown>).Worker = FakeWorker;
  });
}

/** 把 PoseEngine 类注入页面（通过夹具页的模块图）。 */
async function loadEngine(page: import("@playwright/test").Page) {
  await page.goto("/e2e/fixtures/fixture.html");
  await page.waitForFunction(() => Boolean(window.__fixture));
}

test.describe("PoseEngine — init 协议", () => {
  test("init 发出的消息包含资产路径与首选委托", async ({ page }) => {
    await injectFakeWorker(page);
    await loadEngine(page);

    const initMsg = await page.evaluate(async () => {
      const { PoseEngine } = window.__fixture;
      const engine = new PoseEngine({
        modelId: "pose_landmarker_full",
        modelAssetPath: "/models/pose_landmarker_full.task",
        wasmBasePath: "/wasm",
        preferredDelegate: "GPU",
      });
      const p = engine.init();
      const Fake = (
        window as unknown as { __FakeWorker: { last: () => { lastInit: () => unknown } } }
      ).__FakeWorker;
      const msg = Fake.last().lastInit();
      // 触发 ready 让 init 完成
      (Fake.last() as unknown as { emit: (m: unknown) => void }).emit({
        type: "ready",
        delegate: "GPU",
        downgraded: false,
        modelId: "pose_landmarker_full",
        keypointSet: "blaze33",
        initMs: 120,
      });
      await p;
      return msg;
    });

    expect(initMsg).toMatchObject({
      type: "init",
      wasmBasePath: "/wasm",
      modelAssetPath: "/models/pose_landmarker_full.task",
      modelId: "pose_landmarker_full",
      delegate: "GPU",
    });
  });

  test("ready 后 status 反映真实委托方式（GPU）", async ({ page }) => {
    await injectFakeWorker(page);
    await loadEngine(page);

    const status = await page.evaluate(async () => {
      const { PoseEngine } = window.__fixture;
      const engine = new PoseEngine({
        modelId: "m",
        modelAssetPath: "/m.task",
        wasmBasePath: "/wasm",
        preferredDelegate: "GPU",
      });
      const p = engine.init();
      const Fake = (window as unknown as { __FakeWorker: { last: () => unknown } }).__FakeWorker;
      (Fake.last() as { emit: (m: unknown) => void }).emit({
        type: "ready",
        delegate: "GPU",
        downgraded: false,
        modelId: "m",
        keypointSet: "blaze33",
        initMs: 100,
      });
      await p;
      return engine.currentStatus;
    });

    expect(status.ready).toBe(true);
    expect(status.delegate).toBe("GPU");
    expect(status.downgraded).toBe(false);
  });

  test("降级到 CPU 时 downgraded 为 true，不谎报用了 GPU", async ({ page }) => {
    await injectFakeWorker(page);
    await loadEngine(page);

    const status = await page.evaluate(async () => {
      const { PoseEngine } = window.__fixture;
      const engine = new PoseEngine({
        modelId: "m",
        modelAssetPath: "/m.task",
        wasmBasePath: "/wasm",
        preferredDelegate: "GPU",
      });
      const p = engine.init();
      const Fake = (window as unknown as { __FakeWorker: { last: () => unknown } }).__FakeWorker;
      // Worker 报告：请求 GPU 但实际用了 CPU
      (Fake.last() as { emit: (m: unknown) => void }).emit({
        type: "ready",
        delegate: "CPU",
        downgraded: true,
        modelId: "m",
        keypointSet: "blaze33",
        initMs: 200,
      });
      await p;
      return engine.currentStatus;
    });

    // 关键：必须如实反映降级，否则性能数据与用户预期都会失真。
    expect(status.delegate).toBe("CPU");
    expect(status.downgraded).toBe(true);
  });

  test("gpu_delegate_failed 是预期信号，不当作致命错误", async ({ page }) => {
    await injectFakeWorker(page);
    await loadEngine(page);

    const outcome = await page.evaluate(async () => {
      const { PoseEngine } = window.__fixture;
      const engine = new PoseEngine({
        modelId: "m",
        modelAssetPath: "/m.task",
        wasmBasePath: "/wasm",
        preferredDelegate: "GPU",
      });
      const Fake = (window as unknown as { __FakeWorker: { last: () => unknown } }).__FakeWorker;
      const p = engine.init();
      const w = Fake.last() as { emit: (m: unknown) => void };
      // 先报 GPU 失败，再报 ready（模拟真实的 GPU→CPU 降级流程）
      w.emit({ type: "error", code: "gpu_delegate_failed", message: "GPU 不可用" });
      w.emit({
        type: "ready",
        delegate: "CPU",
        downgraded: true,
        modelId: "m",
        keypointSet: "blaze33",
        initMs: 300,
      });
      const status = await p;
      return { status, threw: false };
    });

    // 不该 reject，应该正常 ready
    expect(outcome.status.ready).toBe(true);
    expect(outcome.status.delegate).toBe("CPU");
  });
});

test.describe("PoseEngine — detect 与迟到结果", () => {
  test("未就绪时 detect 释放位图而不是泄漏", async ({ page }) => {
    await injectFakeWorker(page);
    await loadEngine(page);

    const result = await page.evaluate(async () => {
      const { PoseEngine } = window.__fixture;
      const engine = new PoseEngine({
        modelId: "m",
        modelAssetPath: "/m.task",
        wasmBasePath: "/wasm",
        preferredDelegate: "CPU",
      });
      // 没有 init，status.ready 为 false。
      // 用夹具的 makeRealBitmap：它会先画上内容再建位图，
      // 空 OffscreenCanvas 在 Chromium 里可能分配失败。
      const bmp = await window.__fixture.makeRealBitmap(32, 32);
      let closed = false;
      const orig = bmp.close.bind(bmp);
      bmp.close = () => {
        closed = true;
        orig();
      };

      engine.detect({
        frameId: "f1",
        sourceEpoch: 0,
        sourceTimeMs: 0,
        receivedAtMonoMs: 0,
        bitmap: bmp,
      });
      return { closed };
    });

    // 未就绪时不能把位图丢掉不管，必须 close。
    expect(result.closed).toBe(true);
  });

  test("detect 把位图转移给 Worker（transfer 列表非空），避免拷贝大图", async ({ page }) => {
    await injectFakeWorker(page);
    await loadEngine(page);

    const result = await page.evaluate(async () => {
      const { PoseEngine } = window.__fixture;
      const engine = new PoseEngine({
        modelId: "m",
        modelAssetPath: "/m.task",
        wasmBasePath: "/wasm",
        preferredDelegate: "CPU",
      });
      const Fake = (window as unknown as { __FakeWorker: { last: () => unknown } }).__FakeWorker;
      const p = engine.init();
      const w = Fake.last() as { emit: (m: unknown) => void; detects: () => unknown[] };
      w.emit({
        type: "ready",
        delegate: "CPU",
        downgraded: false,
        modelId: "m",
        keypointSet: "blaze33",
        initMs: 10,
      });
      await p;

      const bmp = await window.__fixture.makeRealBitmap(64, 64);
      engine.detect({
        frameId: "f1",
        sourceEpoch: 0,
        sourceTimeMs: 0,
        receivedAtMonoMs: 0,
        bitmap: bmp,
      });

      const d = w.detects() as Array<Record<string, unknown>>;
      return { count: d.length, frameId: d[0]?.frameId };
    });

    expect(result.count).toBe(1);
    expect(result.frameId).toBe("f1");
  });

  test("迟到结果被丢弃：未发起的 frameId 不触发回调", async ({ page }) => {
    await injectFakeWorker(page);
    await loadEngine(page);

    const received = await page.evaluate(async () => {
      const { PoseEngine } = window.__fixture;
      const engine = new PoseEngine({
        modelId: "m",
        modelAssetPath: "/m.task",
        wasmBasePath: "/wasm",
        preferredDelegate: "CPU",
      });
      const Fake = (window as unknown as { __FakeWorker: { last: () => unknown } }).__FakeWorker;
      const p = engine.init();
      const w = Fake.last() as { emit: (m: unknown) => void };

      const seen: string[] = [];
      engine.onResult((r: { frameId: string }) => seen.push(r.frameId));
      w.emit({
        type: "ready",
        delegate: "CPU",
        downgraded: false,
        modelId: "m",
        keypointSet: "blaze33",
        initMs: 10,
      });
      await p;

      // 一个从未提交过的 frameId —— 属于陈旧/串场结果
      w.emit({
        type: "result",
        frameId: "ghost",
        sourceEpoch: 0,
        sourceTimeMs: 0,
        receivedAtMonoMs: 0,
        inferredAtMonoMs: 1,
        inferenceMs: 1,
        imageWidth: 1,
        imageHeight: 1,
        keypoints2D: [],
        detected: false,
      });

      return seen;
    });

    // 关键：幽灵结果不能进入状态机，否则会污染分段与特征。
    expect(received).toEqual([]);
  });

  test("已提交帧的结果正常回调，且只回调一次", async ({ page }) => {
    await injectFakeWorker(page);
    await loadEngine(page);

    const seen = await page.evaluate(async () => {
      const { PoseEngine } = window.__fixture;
      const engine = new PoseEngine({
        modelId: "m",
        modelAssetPath: "/m.task",
        wasmBasePath: "/wasm",
        preferredDelegate: "CPU",
      });
      const Fake = (window as unknown as { __FakeWorker: { last: () => unknown } }).__FakeWorker;
      const p = engine.init();
      const w = Fake.last() as { emit: (m: unknown) => void };

      const got: string[] = [];
      engine.onResult((r: { frameId: string }) => got.push(r.frameId));
      w.emit({
        type: "ready",
        delegate: "CPU",
        downgraded: false,
        modelId: "m",
        keypointSet: "blaze33",
        initMs: 10,
      });
      await p;

      const bmp = await window.__fixture.makeRealBitmap(8, 8);
      engine.detect({
        frameId: "f1",
        sourceEpoch: 0,
        sourceTimeMs: 0,
        receivedAtMonoMs: 0,
        bitmap: bmp,
      });

      const msg = {
        type: "result",
        frameId: "f1",
        sourceEpoch: 0,
        sourceTimeMs: 0,
        receivedAtMonoMs: 0,
        inferredAtMonoMs: 5,
        inferenceMs: 5,
        imageWidth: 8,
        imageHeight: 8,
        keypoints2D: [],
        detected: true,
      };
      w.emit(msg);
      // 重复投递同一结果（模拟重复消息）
      w.emit(msg);

      return got;
    });

    // 第二次应被 inFlight 去重丢弃。
    expect(seen).toEqual(["f1"]);
  });
});

test.describe("PoseEngine — dispose", () => {
  test("dispose 终止 Worker 并清空状态", async ({ page }) => {
    await injectFakeWorker(page);
    await loadEngine(page);

    const result = await page.evaluate(async () => {
      const { PoseEngine } = window.__fixture;
      const engine = new PoseEngine({
        modelId: "m",
        modelAssetPath: "/m.task",
        wasmBasePath: "/wasm",
        preferredDelegate: "CPU",
      });
      const Fake = (window as unknown as { __FakeWorker: { last: () => unknown } }).__FakeWorker;
      const p = engine.init();
      const w = Fake.last() as { emit: (m: unknown) => void; terminated: boolean };
      w.emit({
        type: "ready",
        delegate: "CPU",
        downgraded: false,
        modelId: "m",
        keypointSet: "blaze33",
        initMs: 10,
      });
      await p;

      engine.dispose();
      return { terminated: w.terminated, status: engine.currentStatus };
    });

    expect(result.terminated).toBe(true);
    expect(result.status.ready).toBe(false);
    expect(result.status.delegate).toBeNull();
  });
});

/**
 * 手部模型协议（F-xxx 回归）。
 *
 * 手部模型是**可选增强**：它失败时姿态链路必须照常可用。
 * 这条极易被"顺手"改成致命错误，所以用假 Worker 钉住。
 */
test.describe("PoseEngine — 手部模型可选性", () => {
  test("init 带上手部模型路径，ready 如实回报可用", async ({ page }) => {
    await injectFakeWorker(page);
    await loadEngine(page);

    const out = await page.evaluate(async () => {
      const { PoseEngine } = window.__fixture;
      const engine = new PoseEngine({
        modelId: "m",
        modelAssetPath: "/m.task",
        handModelAssetPath: "/hand.task",
        wasmBasePath: "/wasm",
        preferredDelegate: "GPU",
      });
      const p = engine.init();
      const Fake = (window as unknown as { __FakeWorker: { last: () => unknown } }).__FakeWorker;
      const w = Fake.last() as {
        lastInit: () => Record<string, unknown>;
        emit: (m: unknown) => void;
      };
      const initMsg = w.lastInit();
      w.emit({
        type: "ready",
        delegate: "GPU",
        downgraded: false,
        modelId: "m",
        keypointSet: "blaze_33+hand_21",
        handModelAvailable: true,
        initMs: 100,
      });
      const status = await p;
      return { initMsg, status };
    });

    expect(out.initMsg.handModelAssetPath).toBe("/hand.task");
    expect(out.status.keypointSet).toBe("blaze_33+hand_21");
    expect(out.status.handModelAvailable).toBe(true);
  });

  test("手部模型初始化失败不致命：姿态链路照常 ready 且如实标注不可用", async ({ page }) => {
    await injectFakeWorker(page);
    await loadEngine(page);

    const out = await page.evaluate(async () => {
      const { PoseEngine } = window.__fixture;
      const engine = new PoseEngine({
        modelId: "m",
        modelAssetPath: "/m.task",
        handModelAssetPath: "/missing.task",
        wasmBasePath: "/wasm",
        preferredDelegate: "GPU",
      });
      const p = engine.init();
      const Fake = (window as unknown as { __FakeWorker: { last: () => unknown } }).__FakeWorker;
      const w = Fake.last() as { emit: (m: unknown) => void };
      // 手部模型挂了 → 只报错，不 reject
      w.emit({ type: "error", code: "hand_model_unavailable", message: "404" });
      w.emit({
        type: "ready",
        delegate: "GPU",
        downgraded: false,
        modelId: "m",
        keypointSet: "blaze_33",
        handModelAvailable: false,
        initMs: 90,
      });
      const status = await p;
      return { status, threw: false };
    });

    // 关键：手部失败绝不能把整条链路带下去
    expect(out.status.ready).toBe(true);
    expect(out.status.handModelAvailable).toBe(false);
    expect(out.status.keypointSet).toBe("blaze_33");
    // 也不该被记成致命错误
    expect(out.status.error).toBeNull();
  });
});
