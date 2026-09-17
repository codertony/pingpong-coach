// @vitest-environment jsdom
import "./setup";

/**
 * App 组件测试（roadmap A1 的一部分）。
 *
 * 目的：验证顶部状态栏把「mock 模式」显著标出来（红线 10），
 * 且后端健康检查失败时如实显示「后端未知」，而不是假装在线。
 *
 * App 挂载时会 `fetchHealth()`、创建 SpeechChannel（jsdom 无 speechSynthesis，
 * 会降级为 unsupported），但不会创建 Worker（`PoseEngine` 只在点「加载姿态模型」/
 * 「开始训练」时才实例化）。所以这里只需 mock api-client 即可安全渲染。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/ui/App.js";

vi.mock("../src/review/api-client.js", () => ({
  fetchHealth: vi.fn(),
  analyzeGroup: vi.fn(),
}));

import { fetchHealth } from "../src/review/api-client.js";
import type { HealthResponse } from "@pingpong/contracts";

const MOCK_HEALTH: HealthResponse = {
  ok: true,
  version: "0.1.0",
  modelMode: "mock",
  modelId: "mock-coach",
  ruleVersion: "1.0.0",
  knowledgeVersion: "1.0.0",
  nodeVersion: "v22.20.0",
  uptimeSec: 1,
};

describe("App 顶部状态", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  // 重试那条用了假定时器，跑完必须还原，否则会影响同文件里别的用例
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mock 模式必须显著可见（红线 10）", async () => {
    vi.mocked(fetchHealth).mockResolvedValue(MOCK_HEALTH);
    render(<App />);

    expect(await screen.findByText("mock 模型模式")).toBeInTheDocument();
    expect(screen.getByText("当前为 mock 模式")).toBeInTheDocument();
  });

  it("健康检查失败时如实显示「后端未知」", async () => {
    vi.mocked(fetchHealth).mockRejectedValue(new Error("网络不通"));
    render(<App />);

    expect(await screen.findByText("后端未知")).toBeInTheDocument();
  });

  /**
   * F-048 的两半，此前**都没有守卫**：
   * 上面那条断言的是**早就存在**的徽标文案「后端未知」，而修复加的是
   * ① 一条**可行动**的提示（点名 `pnpm dev:all`，因为 `pnpm dev` 只起前端），
   * ② 健康检查**失败会重试**（3 秒一次，通了就停）。
   * 把这两样删掉，上面那条用例照样绿 —— 所以它们等于没人守。
   */
  it("后端未连接时给出**可行动的**信息，而不只是一句「后端未知」", async () => {
    vi.mocked(fetchHealth).mockRejectedValue(new Error("网络不通"));
    render(<App />);

    expect(await screen.findByText(/后端未连接/)).toBeInTheDocument();
    // 必须点名命令：`pnpm dev` 只起前端，用户按最自然的命令启动会一直没结论
    expect(screen.getByText("pnpm dev:all")).toBeInTheDocument();
  });

  it("失败会**重试**（3 秒一次），而且**通了就停**（不轮询）", async () => {
    // shouldAdvanceTime：假的定时器 + testing-library 的 waitFor 要能共存
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(fetchHealth)
      .mockRejectedValueOnce(new Error("网络不通"))
      .mockResolvedValueOnce(MOCK_HEALTH);
    render(<App />);

    await screen.findByText(/后端未连接/);
    const afterFirst = vi.mocked(fetchHealth).mock.calls.length;

    await vi.advanceTimersByTimeAsync(3100);
    expect(
      vi.mocked(fetchHealth).mock.calls.length,
      "失败之后没有重试 —— 用户在后端起来之后，提示会永远留在那儿（除非他刷新页面）",
    ).toBeGreaterThan(afterFirst);

    // 第二次成功了：提示消失
    expect(await screen.findByText("mock 模型模式")).toBeInTheDocument();
    const afterSuccess = vi.mocked(fetchHealth).mock.calls.length;

    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.mocked(fetchHealth).mock.calls.length, "通了还在继续轮询 —— 说好的「通了就停」").toBe(
      afterSuccess,
    );
  });
});
