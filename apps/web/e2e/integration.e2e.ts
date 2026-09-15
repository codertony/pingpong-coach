/**
 * A2 · 前后端**真实**串联测试。
 *
 * ⚠️ 这个文件里**没有 `page.route`**，这是刻意的。
 *
 * 已有的分段测试各自的盲区：
 * - `api-client.e2e.ts` 用 `page.route` 造假响应 —— 测的是"前端拿到某个响应
 *   会怎么处理"，**测不到这条 HTTP 真的通不通**；
 * - `apps/api/test/server.test.ts` 用 `app.inject` 直接调处理器 ——
 *   绕过了真实网络、真实 JSON 往返、真实代理。
 *
 * 两者之间那段缝正是 F-007/F-008/F-011 藏身的地方。这里补上：
 * 真实浏览器 → vite 代理 → 真实 Fastify 进程（mock 模式）→ 真实响应。
 *
 * 这条链路走不通就说明集成真有问题，而不是"测试环境没配对"。
 */

import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/e2e/fixtures/fixture.html");
  await page.waitForFunction(() => Boolean(window.__fixture));
});

test.describe("前后端真实串联", () => {
  test("vite 代理真的打到后端进程：/api/health 如实报告 mock 模式", async ({ page }) => {
    const health = await page.evaluate(() => window.__fixture.fetchHealth());

    // 这条不经任何 mock。拿不到就说明代理或 API 进程有问题。
    expect(health.ok).toBe(true);
    expect(health.modelMode).toBe("mock");
    // 红线 10：mock 必须可见 —— 让用户一眼能看出这不是真实模型结果
    expect(health.modelId).toBe("mock-coach");
  });

  test("前端产出的证据包，后端真的收得下并返回受校验的反馈", async ({ page }) => {
    const result = await page.evaluate(async () => {
      // 用**真实** TrainingSession 攒出一组，而不是手搓一个包 ——
      // 手搓只能证明"后端收得下这个形状"，这里要证的是
      // "前端真的会产出后端收得下的东西"。
      const packet = await window.__fixture.runSyntheticGroup({ strokes: 3 });
      if (!packet) return { packet: null, outcome: null };
      const outcome = await window.__fixture.analyzeGroup(packet);
      return { packet, outcome };
    });

    // 会话必须真的攒出了证据包（否则后面的断言没有意义）
    expect(result.packet).not.toBeNull();
    expect(result.packet!.strokes.length).toBeGreaterThanOrEqual(3);

    // 后端必须真的处理了它，而不是返回错误
    expect(result.outcome!.error).toBeNull();
    const feedback = result.outcome!.feedback;
    expect(feedback).not.toBeNull();
    expect(feedback!.mock).toBe(true);
    expect(feedback!.observation.length).toBeGreaterThan(0);
    // 红线 8 的反面：反馈必须能指回真实证据
    expect(feedback!.evidenceRefs.length).toBeGreaterThan(0);
  });

  test("伪造关键帧与挥拍的对齐关系也会被拦下", async ({ page }) => {
    const outcome = await page.evaluate(async () => {
      const packet = await window.__fixture.runSyntheticGroup({ strokes: 3 });
      if (!packet) return null;
      // 篡改：把关键帧的 frameId 改成挥拍证据里不存在的值，制造"图文错配"。
      // 契约测试里有一条显式检查这个关系（见 contracts/test/consistency.test.ts），
      // 这里验的是服务端真的会执行它。
      const forged = {
        ...packet,
        keyframes: packet.keyframes.map((k) => ({
          ...k,
          frameId: "frame_that_does_not_exist",
        })),
      };
      return window.__fixture.analyzeGroup(forged as never);
    });

    expect(outcome).not.toBeNull();
    // 要么明确拒绝，要么如实降级 —— 绝不能若无其事地给出技术判定
    const rejected = outcome!.error != null || outcome!.feedback === null;
    const degraded =
      outcome!.feedback != null &&
      (outcome!.feedback.rejectedClaims.length > 0 ||
        outcome!.feedback.status === "observation_only");
    expect(rejected || degraded).toBe(true);
  });

  test("后端不可达时不阻塞本地链路，且错误码可识别", async ({ page }) => {
    // 把 fetch 换成必定失败，模拟后端挂掉（这是**客户端**降级路径，
    // 与上面"真打后端"的用例互补，不冲突）。
    const outcome = await page.evaluate(async () => {
      const packet = await window.__fixture.runSyntheticGroup({ strokes: 3 });
      if (!packet) return null;
      const original = window.fetch;
      window.fetch = () => Promise.reject(new Error("network down"));
      try {
        return await window.__fixture.analyzeGroup(packet);
      } finally {
        window.fetch = original;
      }
    });

    expect(outcome).not.toBeNull();
    // 红线 9：模型侧失败不能让整条链路停摆 —— 调用方拿到 error 后
    // 应保留本地反馈，界面只需提示模型侧不可用。
    expect(outcome!.feedback).toBeNull();
    expect(outcome!.error?.code).toBe("model_unavailable");
    expect(outcome!.error?.details.join(" ")).toContain("后端");
  });
});
