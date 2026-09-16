// @vitest-environment jsdom
import "./setup";

/**
 * ReviewPanel 组件测试（roadmap A1 的一部分）。
 *
 * 这是第一个组件级渲染测试：此前 apps/web 只有纯逻辑测试，
 * 没有一条测试真正渲染过 React 组件。这里锁住复查页的三种核心状态：
 * 空态、有反馈态、模型失败态，以及「缺失值绝不渲染成 0」这条红线。
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReviewPanel, type ReviewItem, type UserRating } from "../src/ui/ReviewPanel.js";
import type { CoachFeedback, EvidencePacket, FeatureValue } from "@pingpong/contracts";
import { DEFAULT_THRESHOLDS } from "@pingpong/motion-core";

function makePacket(overrides: Partial<EvidencePacket> = {}): EvidencePacket {
  return {
    schemaVersion: "1",
    requestId: "req-1",
    sessionId: "sess-1",
    groupId: "grp-1",
    focusId: "return_to_ready_zone",
    strokeType: "forehand_drive",
    handedness: "right",
    cameraView: "front",
    perStrokeFeatures: [{ strokeId: "st-1", features: [] }],
    strokes: [
      {
        strokeId: "st-1",
        startMs: 0,
        endMs: 1000,
        anchor: { type: "wrist_speed_peak", timeMs: 400 },
        impactTimeMs: null,
        complete: true,
        phaseEvents: [],
        evidenceFrameIds: ["f-1"],
        reasons: [],
      },
    ],
    features: [
      {
        id: "return_after_wrist_peak_ms",
        value: 420,
        unit: "ms",
        coordinateSpace: "image_2d",
        intervalMs: [400, 820],
        quality: "usable",
        reasonIfMissing: null,
      },
    ],
    keyframes: [
      {
        id: "kf-1",
        sourceTimeMs: 400,
        jpegBase64: "AAAA",
        frameId: "f-1",
        width: 960,
        height: 540,
        role: "forward",
      },
    ],
    ruleVersion: "1.0.0",
    referenceId: null,
    criterion: {
      featureId: "return_after_wrist_peak_ms",
      threshold: 700,
      unit: "ms",
      minValidStrokes: 3,
    },
    limitations: ["单目二维"],
    readyZone: { xPx: 640, yPx: 400, radiusPx: 80 },
    ...overrides,
  };
}

function makeFeedback(overrides: Partial<CoachFeedback> = {}): CoachFeedback {
  return {
    schemaVersion: "1",
    requestId: "req-1",
    sessionId: "sess-1",
    groupId: "grp-1",
    focusId: "return_to_ready_zone",
    status: "observation_only",
    observation: "本组肘角变化稳定",
    keyPoints: ["腕部速度峰值处的肘角中位数 152°（180° 为伸直）", "本组 3 次挥拍都完整闭合"],
    evidenceRefs: ["return_after_wrist_peak_ms", "kf-1"],
    cue: "击球后先回到准备位",
    nextDrillId: null,
    limitations: ["单目二维"],
    modelId: "mock-coach",
    mock: true,
    serverElapsedMs: 12,
    rejectedClaims: [],
    createdAtMonoMs: 1000,
    ...overrides,
  };
}

function makeReviewItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    requestId: "req-1",
    groupId: "grp-1",
    sessionId: "sess-1",
    focusId: "return_to_ready_zone",
    packet: makePacket(),
    feedback: makeFeedback(),
    error: null,
    elapsedMs: 34,
    deduplicated: false,
    userRating: null,
    ...overrides,
  };
}

function renderPanel(items: ReviewItem[], onRate: (id: string, r: UserRating) => void = vi.fn()) {
  return render(
    <ReviewPanel
      reviews={items}
      onRate={onRate}
      onExport={vi.fn()}
      thresholds={DEFAULT_THRESHOLDS}
    />,
  );
}

describe("ReviewPanel", () => {
  it("空态提示还没有可复查的记录", () => {
    renderPanel([]);
    expect(screen.getByText(/还没有可复查的记录/)).toBeInTheDocument();
  });

  it("渲染反馈：观察、提示、证据引用，并显著标记 mock", () => {
    renderPanel([makeReviewItem()]);
    expect(screen.getByText("本组肘角变化稳定")).toBeInTheDocument();
    expect(screen.getByText("提示：击球后先回到准备位")).toBeInTheDocument();
    expect(screen.getByText(/return_after_wrist_peak_ms、kf-1/)).toBeInTheDocument();
    // mock 必须可见，绝不把 mock 结果当成真实模型
    expect(screen.getByText(/mock-coach（mock）/)).toBeInTheDocument();
  });

  it("模型失败态：显示错误码且明示不阻塞本地训练", () => {
    renderPanel([
      makeReviewItem({
        feedback: null,
        error: { code: "model_unavailable", message: "模型接口调用失败", details: ["超时"] },
      }),
    ]);
    expect(screen.getByText("未取得模型结论")).toBeInTheDocument();
    // 错误码同时出现在表格徽标与错误面板里，至少各出现一次
    expect(screen.getAllByText("model_unavailable").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/不会阻塞本地训练/)).toBeInTheDocument();
  });

  it("缺失值渲染为「缺失」并给出原因，绝不填 0", () => {
    const nullFeature: FeatureValue = {
      id: "return_after_wrist_peak_ms",
      value: null,
      unit: "ms",
      coordinateSpace: "image_2d",
      intervalMs: [400, 820],
      quality: "limited",
      reasonIfMissing: "腕部被遮挡，无法定位峰值",
    };
    renderPanel([makeReviewItem({ packet: makePacket({ features: [nullFeature] }) })]);
    expect(screen.getByText("缺失")).toBeInTheDocument();
    expect(screen.getByText("腕部被遮挡，无法定位峰值")).toBeInTheDocument();
    // 红线 1：缺失值绝不渲染成 0
    expect(screen.getByText(/不会用 0 填补/)).toBeInTheDocument();
  });

  it("无可测量值时提示而非空表格", () => {
    renderPanel([makeReviewItem({ packet: makePacket({ features: [] }) })]);
    expect(screen.getByText(/没有可用测量值/)).toBeInTheDocument();
  });

  it("点击评价按钮回调 onRate", () => {
    const onRate = vi.fn();
    renderPanel([makeReviewItem()], onRate);
    fireEvent.click(screen.getByText("有帮助"));
    expect(onRate).toHaveBeenCalledWith("req-1", "helpful");
  });
});

/**
 * 逐条要点（keyPoints）的渲染。
 *
 * 用户的要求是"把细节逐条列清楚"。字段加了但界面不显示，等于没加 ——
 * 所以这一组守的是**看得见**，以及"空的时候不要摆一个空标题"。
 */
describe("ReviewPanel — 逐条要点", () => {
  it("要点逐条列出", () => {
    renderPanel([makeReviewItem()]);
    expect(screen.getByText("腕部速度峰值处的肘角中位数 152°（180° 为伸直）")).toBeInTheDocument();
    expect(screen.getByText("本组 3 次挥拍都完整闭合")).toBeInTheDocument();
  });

  it("要点为空时不渲染空的要点区 —— 空标题会让人以为漏了内容", () => {
    renderPanel([makeReviewItem({ feedback: makeFeedback({ keyPoints: [] }) })]);
    expect(screen.queryByText("本组 3 次挥拍都完整闭合")).toBeNull();
    // 观察与提示该照常显示，别把整块反馈一起弄没了
    expect(screen.getByText("本组肘角变化稳定")).toBeInTheDocument();
    expect(screen.getByText("提示：击球后先回到准备位")).toBeInTheDocument();
  });
});
