/**
 * API 客户端真实网络测试。
 *
 * 这里用 Playwright 的 route 拦截来模拟后端，而不是启动真实后端 ——
 * 目的是验证**客户端自己的行为**：如何解析成功响应、如何降级失败响应、
 * 以及最关键的一条：**模型不可用时不阻塞本地训练**（只返回 error，不抛异常）。
 *
 * 网络层用真实 fetch 走真实浏览器协议栈，不是 mock 函数调用。
 */

import { test, expect } from "@playwright/test";
import { TINY_PACKET } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/e2e/fixtures/fixture.html");
  await page.waitForFunction(() => Boolean(window.__fixture));
});

test.describe("fetchHealth", () => {
  test("后端正常时返回健康信息", async ({ page }) => {
    await page.route("**/api/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          version: "0.1.0",
          modelMode: "mock",
          modelId: "mock-coach",
          ruleVersion: "1.0.0",
          knowledgeVersion: "1.0.0",
          nodeVersion: "v22.13.1",
          uptimeSec: 1,
        }),
      }),
    );

    const h = await page.evaluate(() => window.__fixture.fetchHealth());
    expect(h.ok).toBe(true);
    expect(h.modelMode).toBe("mock");
  });

  test("后端返回 500 时抛出（健康检查失败要能被感知）", async ({ page }) => {
    await page.route("**/api/health", (route) => route.fulfill({ status: 500, body: "err" }));

    const outcome = await page.evaluate(async () => {
      try {
        await window.__fixture.fetchHealth();
        return "no-throw";
      } catch (err) {
        return (err as Error).message;
      }
    });

    expect(outcome).toContain("500");
  });
});

test.describe("analyzeGroup — 成功路径", () => {
  test("解析 ok:true 响应并返回反馈与耗时", async ({ page }) => {
    await page.route("**/api/coach/analyze", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          deduplicated: false,
          feedback: {
            schemaVersion: "1",
            requestId: "req-1",
            sessionId: "sess-1",
            groupId: "group-1",
            focusId: "return_to_ready_zone",
            status: "observation_only",
            observation: "真实响应",
            evidenceRefs: [],
            cue: null,
            nextDrillId: null,
            limitations: [],
            modelId: "mock-coach",
            mock: true,
            serverElapsedMs: 1,
            rejectedClaims: [],
            createdAtMonoMs: 1,
          },
        }),
      }),
    );

    const out = await page.evaluate((p) => window.__fixture.analyzeGroup(p as never), TINY_PACKET);

    expect(out.error).toBeNull();
    expect(out.feedback?.observation).toBe("真实响应");
    expect(out.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("请求体是合法 JSON，且 content-type 正确（防止契约在下游才发现问题）", async ({ page }) => {
    let capturedBody = "";
    let capturedType = "";

    await page.route("**/api/coach/analyze", async (route) => {
      const req = route.request();
      capturedBody = req.postData() ?? "";
      capturedType = req.headers()["content-type"] ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          deduplicated: false,
          feedback: { status: "observation_only", observation: "x" },
        }),
      });
    });

    await page.evaluate((p) => window.__fixture.analyzeGroup(p as never), TINY_PACKET);

    expect(capturedType).toContain("application/json");
    const parsed = JSON.parse(capturedBody);
    expect(parsed.requestId).toBe(TINY_PACKET.requestId);
    expect(parsed.strokeType).toBe("forehand_drive");
  });

  test("命中服务端去重时 deduplicated 为 true", async ({ page }) => {
    await page.route("**/api/coach/analyze", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          deduplicated: true,
          feedback: { status: "observation_only", observation: "复用" },
        }),
      }),
    );

    const out = await page.evaluate((p) => window.__fixture.analyzeGroup(p as never), TINY_PACKET);
    expect(out.deduplicated).toBe(true);
  });
});

test.describe("analyzeGroup — 失败降级（不阻塞本地训练）", () => {
  test("后端返回业务错误时返回 error 而不是抛异常", async ({ page }) => {
    await page.route("**/api/coach/analyze", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          code: "unsupported",
          message: "证据包未通过契约校验",
          details: ["strokes.0.strokeId: Required"],
        }),
      }),
    );

    const out = await page.evaluate((p) => window.__fixture.analyzeGroup(p as never), TINY_PACKET);

    expect(out.feedback).toBeNull();
    expect(out.error?.code).toBe("unsupported");
    expect(out.error?.details.length).toBeGreaterThan(0);
  });

  test("网络不可达时降级为 model_unavailable 并给出排查建议", async ({ page }) => {
    // 直接让请求失败，模拟后端没启动
    await page.route("**/api/coach/analyze", (route) => route.abort("connectionrefused"));

    const out = await page.evaluate((p) => window.__fixture.analyzeGroup(p as never), TINY_PACKET);

    expect(out.feedback).toBeNull();
    expect(out.error?.code).toBe("model_unavailable");
    // 关键：必须提示用户「本地训练不受影响」，且给出下一步动作。
    expect(out.error?.details.join(" ")).toContain("pnpm dev:api");
  });

  test("HTTP 500 但响应体仍是合法错误结构时按业务错误处理", async ({ page }) => {
    await page.route("**/api/coach/analyze", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          code: "internal_error",
          message: "内部错误",
          details: [],
        }),
      }),
    );

    const out = await page.evaluate((p) => window.__fixture.analyzeGroup(p as never), TINY_PACKET);
    expect(out.error?.code).toBe("internal_error");
  });

  test("响应体不是 JSON 时被捕获为 model_unavailable，不抛出未处理异常", async ({ page }) => {
    await page.route("**/api/coach/analyze", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<html>网关错误</html>" }),
    );

    const out = await page.evaluate(async (p) => {
      try {
        return await window.__fixture.analyzeGroup(p as never);
      } catch (err) {
        return { threw: (err as Error).message };
      }
    }, TINY_PACKET);

    // 关键：解析失败也必须被兜住，不能让异常逃逸到训练循环里。
    expect((out as { threw?: string }).threw).toBeUndefined();
    expect((out as { error: { code: string } }).error.code).toBe("model_unavailable");
  });

  test("失败时 elapsedMs 仍被记录（便于区分网络慢还是模型慢）", async ({ page }) => {
    await page.route("**/api/coach/analyze", (route) => route.abort("failed"));
    const out = await page.evaluate((p) => window.__fixture.analyzeGroup(p as never), TINY_PACKET);
    expect(out.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
