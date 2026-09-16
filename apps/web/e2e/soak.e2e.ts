/**
 * 连续运行稳定性（验收里的 P2 项："20 分钟练习无逐渐增长的任务队列或内存泄漏趋势"）。
 *
 * 为什么必须真跑满时长而不是"加速跑很多帧"：
 * 要抓的是**随时间增长**的东西 —— 泄漏、监听器堆积、数组只增不减、队列积压。
 * 把 20 分钟的帧在 30 秒里灌完，只会得到一个"处理得很快"的结论，
 * 而泄漏恰恰是按**真实时间**累积的（定时器、GC 周期、位图句柄的释放时机）。
 *
 * 同时驱动两条**各自独立**的真实链路，因为它们漏的地方不同：
 *   1. **引擎 + Worker**：真实 ImageBitmap、真实跨线程、真实模型推理
 *      → 漏的是位图句柄与消息队列；
 *   2. **TrainingSession**：真实滤波 / 分段 / 特征 / 证据缓存
 *      → 漏的是只增不减的数组。
 *
 * 合成关键点只喂给第 2 条（合成图形喂引擎检不出人体，那反而测不到东西）；
 * 第 2 条用合成关键点是**有意**的：它要测的是会话内部缓冲的增长，不是识别质量。
 *
 * **量了四件事**（验收点名的两项在内）：
 *   - 堆用量趋势（CDP `Runtime.getHeapUsage`）→ 内存泄漏
 *   - **未完成帧数**（已提交 − 已返回）→ 任务队列积压的代理量。
 *     没有现成读数可用（这里没走 FrameScheduler），所以明说是**代理量**而不是队列长度本身。
 *   - 吞吐（每秒帧数）→ 随时间是否衰减
 *   - 引擎往返延迟（自己按 frameId 记提交时刻算）→ 顺带与遥测里的
 *     `poseLatencyP95Ms` 对照，判断那个读数是否可信
 *
 * ⚠️ 需要模型资产。未设置 `PPC_SOAK=1` 时 skip（默认 20 分钟，CI 上不跑）。
 */

import { test, expect } from "@playwright/test";

const ENABLED = process.env.PPC_SOAK === "1";
const MINUTES = Number(process.env.PPC_SOAK_MINUTES ?? 20);

/** 内存采样间隔。20 分钟 / 20s ≈ 60 个点，够看出趋势又不至于自身影响结论。 */
const SAMPLE_INTERVAL_MS = 20_000;

interface LatencyStats {
  n: number;
  min: number;
  median: number;
  p95: number;
  max: number;
}

// 关掉 trace/video：这是 20 分钟的稳定性测试，产物没意义，
// 而实测它会**在收尾时**抛 ENOENT（20 分钟后去取一个并不存在的 trace 文件），
// 让一次所有断言都通过的运行被判成失败。
// 必须放在**文件顶层** —— 放进 describe 会被 Playwright 拒绝（它会强制新建 worker）。
test.use({ trace: "off", video: "off" });

test.describe("连续运行稳定性", () => {
  test.skip(!ENABLED, "未设置 PPC_SOAK=1（需要模型资产、且要跑满时长），跳过");

  test(`连续 ${MINUTES} 分钟：吞吐不衰减、内存无持续增长趋势`, async ({ page, context }) => {
    test.setTimeout((MINUTES + 5) * 60_000);

    await page.goto("/e2e/fixtures/fixture.html");
    await page.waitForFunction(() => Boolean(window.__fixture));

    // 用 CDP 取堆用量：`performance.memory` 需要额外的启动开关才有精度，
    // 而 CDP 的 Runtime.getHeapUsage 拿到的就是 V8 的真实数字。
    const cdp = await context.newCDPSession(page);

    // ── 在页面里起两条真实链路 ──
    const started = await page.evaluate(async () => {
      const engine = new window.__fixture.PoseEngine(window.__fixture.MODEL_ASSET);
      const status = await engine.init();

      const counts = { results: 0, engineErrors: 0, framesSubmitted: 0, strokes: 0, groups: 0 };
      /** 提交时刻，按 frameId 记下来，用于自己算引擎往返延迟 */
      const submitAt = new Map<string, number>();
      const engineLatencies: number[] = [];
      /** 会话遥测口径的样本：`Worker 的 inferredAtMonoMs − 主线程的提交时刻` */
      const workerReportedMs: number[] = [];

      const session = new window.__fixture.TrainingSession(
        window.__fixture.buildTrainingConfig({
          sessionId: "soak_1",
          handedness: "right",
          cameraView: "front",
          focusId: "return_to_ready_zone",
          strokesPerGroup: 3,
        }),
        {
          onStatus: () => {},
          onStroke: () => {
            counts.strokes++;
          },
          onFeedback: () => {},
          onGroupComplete: () => {
            counts.groups++;
          },
        },
      );

      engine.onResult((r) => {
        counts.results++;
        // 自己量一遍引擎往返延迟：拿它与会话遥测里的 `poseLatencyP95Ms` 对照，
        // 就能判断那个数字是不是真的（烟测里它读出来是 0，可疑）。
        const submittedAt = submitAt.get(r.frameId);
        if (submittedAt != null) {
          engineLatencies.push(performance.now() - submittedAt);
          // 会话遥测算的是 `inferredAtMonoMs − receivedAtMonoMs`，而
          // `inferredAtMonoMs` 是 **Worker 时钟**、`receivedAtMonoMs` 是**主线程时钟**。
          // 这里把那个差值也记一份，用来判断遥测读数是否可信。
          workerReportedMs.push(r.inferredAtMonoMs - submittedAt);
          // 封顶：这个数组本身就是被测的堆的一部分，不封顶会自己制造一条"上升趋势"
          if (engineLatencies.length > 2_000) engineLatencies.shift();
          if (workerReportedMs.length > 2_000) workerReportedMs.shift();
          submitAt.delete(r.frameId);
        }
        session.pushPoseResult(r);
      });

      // 必须显式设准备区：状态机在准备区设定之前**一直停在 idle**（这是刻意的设计）。
      // 不设的话这条链路只是在"推帧"，分段、特征、证据、成组一个都不会跑 ——
      // 而它们才是真正会随时间累积内存的地方。
      session.setReadyZone({ x: 640, y: 420 });

      // 合成关键点：与真实引擎输出的形状一致（像素坐标、语义名）。
      // 让腕部在准备区附近做**有节奏的往复**，这样分段状态机会真的运转。
      const READY = { x: 640, y: 420 };
      const SCALE = 200;
      const body = (wristX: number) => [
        { name: "nose", xPx: 640, yPx: 120, score: 0.95, visible: true },
        { name: "left_shoulder", xPx: 600, yPx: 200, score: 0.9, visible: true },
        { name: "right_shoulder", xPx: 680, yPx: 200, score: 0.9, visible: true },
        { name: "left_elbow", xPx: 580, yPx: 280, score: 0.9, visible: true },
        { name: "right_elbow", xPx: 700, yPx: 280, score: 0.9, visible: true },
        { name: "left_hip", xPx: 610, yPx: 400, score: 0.9, visible: true },
        { name: "right_hip", xPx: 670, yPx: 400, score: 0.9, visible: true },
        { name: "left_knee", xPx: 605, yPx: 520, score: 0.9, visible: true },
        { name: "right_knee", xPx: 675, yPx: 520, score: 0.9, visible: true },
        { name: "left_ankle", xPx: 600, yPx: 640, score: 0.9, visible: true },
        { name: "right_ankle", xPx: 680, yPx: 640, score: 0.9, visible: true },
        { name: "right_wrist", xPx: wristX, yPx: READY.y, score: 0.9, visible: true },
      ];

      const canvas = new OffscreenCanvas(640, 360);
      const cctx = canvas.getContext("2d")!;

      let frameIndex = 0;
      let stopped = false;
      let lastSecondFrames = 0;
      /** 每秒的帧数，用来判断吞吐是否随时间衰减 */
      const fpsSeries: number[] = [];

      const tick = async () => {
        while (!stopped) {
          const t0 = performance.now();
          const nowMs = performance.now();

          // ① 引擎链路：真实位图 + 真实推理
          cctx.fillStyle = `hsl(${frameIndex % 360}, 40%, 30%)`;
          cctx.fillRect(0, 0, 640, 360);
          const bitmap = await createImageBitmap(canvas);
          counts.framesSubmitted++;
          const frameId = `soak_${frameIndex}`;
          submitAt.set(frameId, nowMs);
          try {
            engine.detect({
              frameId,
              sourceEpoch: 0,
              sourceTimeMs: Math.round(nowMs),
              receivedAtMonoMs: nowMs,
              bitmap,
            });
          } catch {
            counts.engineErrors++;
          }

          // ② 会话链路：合成关键点，让分段/特征真的跑
          const phase = (frameIndex % 24) / 24;
          const offset = phase < 0.5 ? phase * 2 * 0.45 : (1 - phase) * 2 * 0.45;
          session.pushPoseResult({
            frameId: `soak_kp_${frameIndex}`,
            sourceEpoch: 0,
            sourceTimeMs: Math.round(nowMs),
            receivedAtMonoMs: nowMs,
            inferredAtMonoMs: nowMs,
            inferenceMs: 1,
            imageWidth: 1280,
            imageHeight: 720,
            keypoints2D: body(READY.x + offset * SCALE),
            detected: true,
            handDetected: false,
            keypointSet: "blaze_33",
          });

          frameIndex++;
          lastSecondFrames++;
          if (frameIndex % 30 === 0) {
            fpsSeries.push(lastSecondFrames);
            lastSecondFrames = 0;
          }

          const elapsed = performance.now() - t0;
          const wait = Math.max(0, 1000 / 30 - elapsed);
          await new Promise((r) => setTimeout(r, wait));
        }
      };

      // 暴露给 Node 侧读数（避免把 20 分钟的数据都堆在内存里再一次性返回）
      (window as unknown as { __soak: unknown }).__soak = {
        stop: () => {
          stopped = true;
        },
        read: () => ({
          ...counts,
          fpsSeries,
          engineLatencyMs: (() => {
            if (engineLatencies.length === 0) return null;
            const s = [...engineLatencies].sort((a, b) => a - b);
            return {
              n: s.length,
              min: s[0]!,
              median: s[Math.floor(s.length / 2)]!,
              p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!,
              max: s[s.length - 1]!,
            };
          })(),
          /** 同一批帧、会话遥测那个口径的分布 —— 与上面一比就知道遥测准不准 */
          workerReportedMs: (() => {
            if (workerReportedMs.length === 0) return null;
            const s = [...workerReportedMs].sort((a, b) => a - b);
            return {
              n: s.length,
              min: s[0]!,
              median: s[Math.floor(s.length / 2)]!,
              p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!,
              max: s[s.length - 1]!,
            };
          })(),
          telemetry: {
            framesProcessed: session.telemetry.framesProcessed,
            framesDropped: session.telemetry.framesDropped,
            poseLatencyP95Ms: session.telemetry.poseLatencyP95Ms,
            segmentationPhase: session.telemetry.segmentationPhase,
          },
        }),
        status: {
          delegate: status.delegate,
          keypointSet: status.keypointSet,
          handModelAvailable: status.handModelAvailable,
        },
      };

      void tick();
      return { delegate: status.delegate, keypointSet: status.keypointSet };
    });

    console.warn(
      `\n开始 ${MINUTES} 分钟连续运行；委托=${started.delegate} 关键点集=${started.keypointSet}`,
    );

    // ── 定时采样：堆用量（CDP）+ 未完成帧数（队列积压的代理量）──
    // 验收里点名的两件事是"内存泄漏趋势"与"逐渐增长的任务队列"，所以两个都要量。
    // 队列积压没有现成的读数可用（这里没走 FrameScheduler），
    // 用 `已提交 − 已返回` 作为代理：Worker 顺序处理，追得上时它应该一直很小。
    /**
     * 读页面里的 soak 状态。
     *
     * 页面上的 `__soak` 会**在页面重新加载后消失**。实测踩过：
     * 跑测试的同时编辑了仓库文件，Vite HMR 触发整页重载，
     * 于是这里读出 `undefined`，报的却是一个看不懂的
     * `TypeError: Cannot read properties of undefined (reading 'read')`，
     * 让人以为是产品问题。所以这里显式区分，并把原因写清楚。
     */
    const readSoak = async (): Promise<Record<string, unknown>> => {
      const data = (await page.evaluate(() => {
        const soak = (window as unknown as { __soak?: { read: () => unknown } }).__soak;
        return soak ? soak.read() : null;
      })) as Record<string, unknown> | null;
      if (data == null) {
        throw new Error(
          "页面里的 __soak 不见了 —— 页面在运行期间被重新加载了。" +
            "最常见的原因是**跑稳定性测试时同时改了仓库文件**（Vite HMR 会整页重载）。" +
            "跑这个测试期间不要编辑文件；若确实需要，改完重跑。",
        );
      }
      return data;
    };

    const deadline = Date.now() + MINUTES * 60_000;
    const heapSamples: Array<{ atMs: number; usedMiB: number }> = [];
    const backlogSamples: Array<{ atMs: number; outstanding: number }> = [];
    const t0 = Date.now();

    while (Date.now() < deadline) {
      const { usedSize } = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
      const atMs = Date.now() - t0;
      heapSamples.push({ atMs, usedMiB: usedSize / 1024 / 1024 });

      const countsNow = (await readSoak()) as { framesSubmitted: number; results: number };
      backlogSamples.push({ atMs, outstanding: countsNow.framesSubmitted - countsNow.results });

      await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
    }

    const finalData = await readSoak();
    await page.evaluate(() => {
      (window as unknown as { __soak?: { stop: () => void } }).__soak?.stop();
    });
    const final = finalData as {
      framesSubmitted: number;
      results: number;
      engineErrors: number;
      strokes: number;
      groups: number;
      fpsSeries: number[];
      engineLatencyMs: LatencyStats | null;
      workerReportedMs: LatencyStats | null;
      telemetry: Record<string, unknown>;
    };

    // ── 趋势判定：用**首尾各 2 分钟**的均值比较，而不是首尾单点 ──
    // 单点会被一次 GC 或一次大分配带偏，那样的"结论"没有意义。
    const windowMs = 2 * 60_000;
    const first = heapSamples.filter((s) => s.atMs < windowMs).map((s) => s.usedMiB);
    const last = heapSamples
      .filter((s) => s.atMs > MINUTES * 60_000 - windowMs)
      .map((s) => s.usedMiB);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    const firstMean = mean(first);
    const lastMean = mean(last);
    const peak = Math.max(...heapSamples.map((s) => s.usedMiB));

    const backlogFirst = mean(
      backlogSamples.filter((s) => s.atMs < windowMs).map((s) => s.outstanding),
    );
    const backlogLast = mean(
      backlogSamples.filter((s) => s.atMs > MINUTES * 60_000 - windowMs).map((s) => s.outstanding),
    );
    const backlogMax = Math.max(...backlogSamples.map((s) => s.outstanding));

    // 吞吐：比较前半段与后半段的平均 fps
    const half = Math.floor(final.fpsSeries.length / 2);
    const fpsFirst = mean(final.fpsSeries.slice(0, half));
    const fpsLast = mean(final.fpsSeries.slice(half));

    console.warn(
      [
        "",
        `采样 ${heapSamples.length} 个堆用量点`,
        `堆：首 2 分钟均值 ${firstMean.toFixed(1)} MiB → 末 2 分钟均值 ${lastMean.toFixed(1)} MiB（峰值 ${peak.toFixed(1)} MiB）`,
        `未完成帧数：首 2 分钟均值 ${backlogFirst.toFixed(1)} → 末 2 分钟均值 ${backlogLast.toFixed(1)}（全程最大 ${backlogMax}）`,
        `吞吐：前半段 ${fpsFirst.toFixed(1)} fps → 后半段 ${fpsLast.toFixed(1)} fps`,
        `提交 ${final.framesSubmitted} 帧，引擎返回 ${final.results} 次，引擎异常 ${final.engineErrors} 次`,
        `会话：成组 ${final.groups} 次、有效挥拍 ${final.strokes} 次（0 就说明分段链路没跑起来）`,
        final.engineLatencyMs
          ? `引擎往返延迟（自测，n=${final.engineLatencyMs.n}）：min ${final.engineLatencyMs.min.toFixed(1)} / ` +
            `中位 ${final.engineLatencyMs.median.toFixed(1)} / p95 ${final.engineLatencyMs.p95.toFixed(1)} / ` +
            `max ${final.engineLatencyMs.max.toFixed(1)} ms`
          : "引擎往返延迟：无样本",
        final.workerReportedMs
          ? `会话遥测口径（Worker 时钟 − 主线程提交时刻，n=${final.workerReportedMs.n}）：` +
            `min ${final.workerReportedMs.min.toFixed(1)} / 中位 ${final.workerReportedMs.median.toFixed(1)} / ` +
            `p95 ${final.workerReportedMs.p95.toFixed(1)} / max ${final.workerReportedMs.max.toFixed(1)} ms`
          : "会话遥测口径：无样本",
        `会话遥测：${JSON.stringify(final.telemetry)}`,
        "",
      ].join("\n"),
    );

    // 前置条件：链路必须真的在跑，否则"没泄漏"毫无意义
    expect(final.framesSubmitted, "一帧都没提交").toBeGreaterThan(100);
    expect(final.results, "引擎一次结果都没返回 —— 稳定性结论无从谈起").toBeGreaterThan(100);
    expect(final.engineErrors, "引擎调用出现异常").toBe(0);
    // 分段链路必须真的运转过：只推帧不做分段，等于没测到会话那部分的缓冲增长
    expect(
      final.strokes,
      "一次有效挥拍都没产生 —— 分段链路没跑起来，稳定性结论不覆盖它",
    ).toBeGreaterThan(0);
    expect(final.groups, "一次都没成组 —— 证据打包那条路径没被覆盖").toBeGreaterThan(0);

    // 吞吐不衰减：后半段不应低于前半段的一半
    expect(
      fpsLast,
      `吞吐随时间衰减：前半段 ${fpsFirst.toFixed(1)} fps，后半段 ${fpsLast.toFixed(1)} fps`,
    ).toBeGreaterThan(fpsFirst / 2);

    // 内存无持续增长：末段均值不得显著高于首段
    // 容差给 1.5× + 32 MiB —— 允许 GC 未及时回收造成的正常波动，
    // 但不允许"只增不减"那种泄漏形态。
    expect(
      lastMean,
      `堆用量持续增长：首 2 分钟 ${firstMean.toFixed(1)} MiB → 末 2 分钟 ${lastMean.toFixed(1)} MiB`,
    ).toBeLessThan(firstMean * 1.5 + 32);

    // 任务队列不增长：末段积压不得比首段多出一秒的帧量。
    // 容差 30 帧 ≈ 1 秒 @30fps —— 允许瞬时抖动，不允许单调积压。
    expect(
      backlogLast,
      `未完成帧数持续积压：首 2 分钟 ${backlogFirst.toFixed(1)} → 末 2 分钟 ${backlogLast.toFixed(1)}`,
    ).toBeLessThan(backlogFirst + 30);

    // 主动断开 CDP，别把会话留到收尾阶段 —— 实测它会在浏览器关闭时插一脚报错
    await cdp.detach();
  });
});
