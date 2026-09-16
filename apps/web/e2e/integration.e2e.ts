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

  test("服务端拒回伪造的证据引用（红线 8，走真实模型调用之后的校验段）", async ({ page }) => {
    // 这条用例的存在理由：`validateModelOutput` 的伪造引用拦截只有让请求
    // 走到**模型调用之后**那一段才触发得到，而 mock 模式根本不经过模型调用 ——
    // 其它用例全都打不到它，而它正是本项目最硬的安全约束之一。
    //
    // 做法：打到**另一个 API 实例**（live 模式，模型端点指向本地假供应商，
    // 供应商返回一段引用不存在证据 ID 的输出）。经 scripts/e2e-stage2-proxy.mjs
    // 转发 —— 不用 vite 代理，实测前缀会被 `/api` 规则先匹配走。
    const stage2Port = Number(process.env.E2E_STAGE2_PORT ?? 8891);
    await page.goto("/e2e/fixtures/fixture.html");
    await page.waitForFunction(() => Boolean(window.__fixture));
    await page.evaluate(
      (p) => window.__fixture.setApiBase(`http://127.0.0.1:${p}/stage2`),
      stage2Port,
    );

    // 先确认这个实例确实是 live 模式 —— 否则下面测的还是 mock 分支，
    // 整条用例会变成"假通过"。
    const health = await page.evaluate(() => window.__fixture.fetchHealth());
    expect(health.modelMode).toBe("live");
    expect(health.modelId).toBe("fake-model-for-e2e");

    const outcome = await page.evaluate(async () => {
      const packet = await window.__fixture.runSyntheticGroup({ strokes: 3 });
      if (!packet) return null;
      return window.__fixture.analyzeGroup(packet);
    });

    expect(outcome).not.toBeNull();
    // 服务端必须明确拒回：错误码可识别，且**不留**下任何反馈
    // （给了 feedback 就等于播报了基于伪造证据的结论）。
    expect(outcome!.feedback).toBeNull();
    expect(outcome!.error).not.toBeNull();
    expect(outcome!.error!.code).toBe("evidence_ref_unknown");
    // 报错必须说清是哪个引用出了问题，否则无法定位
    expect(outcome!.error!.details.join(" ")).toContain("不存在");
  });

  test("带图片的证据包能被真实后端收下（图片链路第一次真的走到服务端）", async ({ page }) => {
    const outcome = await page.evaluate(async () => {
      const packet = await window.__fixture.runSyntheticGroup({ strokes: 3, withKeyframes: true });
      if (!packet) return null;
      return {
        packet: { keyframeCount: packet.keyframes.length },
        res: await window.__fixture.analyzeGroup(packet),
      };
    });

    expect(outcome, "没能产出证据包").not.toBeNull();
    // 前置条件：包里**真的**有图 —— 否则这条又会变成"测了个空数组"
    expect(
      outcome!.packet.keyframeCount,
      "证据包里没有关键帧，这条用例测不到图片链路（F-028 之前它一直是空的）",
    ).toBeGreaterThan(0);
    expect(
      outcome!.res.error,
      `带图片的包被后端拒了：${JSON.stringify(outcome!.res.error)}`,
    ).toBeNull();
    expect(outcome!.res.feedback).not.toBeNull();
  });

  test("伪造关键帧与挥拍的对齐关系会被服务端拦下", async ({ page }) => {
    const outcome = await page.evaluate(async () => {
      const packet = await window.__fixture.runSyntheticGroup({ strokes: 3, withKeyframes: true });
      if (!packet) return null;
      if (packet.keyframes.length === 0) return { noKeyframes: true } as const;
      // 篡改：把第一张关键帧的 frameId 改成任何挥拍证据里都不存在的值，制造"图文错配"。
      //
      // ⚠️ 这条用例原先**什么都没伪造**：那时包里 `keyframes` 恒为 `[]`，
      // `[].map()` 还是 `[]`，改了个寂寞；而它的通过条件是
      // "被拒 **或** 降级为 observation_only"，而 mock 模式**本来就**回
      // observation_only —— 于是它一直"通过"，却从未验证过服务端。
      // 现在包里真的有图了，篡改才有意义。
      const forged = {
        ...packet,
        keyframes: packet.keyframes.map((k, i) =>
          i === 0 ? { ...k, frameId: "frame_that_does_not_exist" } : k,
        ),
      };
      return { forged: true as const, res: await window.__fixture.analyzeGroup(forged as never) };
    });

    expect(outcome, "没能产出证据包").not.toBeNull();
    if (outcome && "noKeyframes" in outcome) {
      throw new Error("包里没有关键帧，无法伪造 —— 前置条件不成立");
    }
    // 这次只接受**明确拒绝**：降级不算通过，因为降级说明它被放行了
    expect(
      outcome!.res.error,
      "不对齐的包被放行了（既没报错，还给了反馈）—— 契约里的「必须对齐」没有生效",
    ).not.toBeNull();
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
