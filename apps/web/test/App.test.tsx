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

import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
