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
    perStrokeFeatures: [
      {
        strokeId: "st-1",
        features: [
          {
            id: "return_after_wrist_peak_ms",
            value: 380,
            unit: "ms",
            coordinateSpace: "image_2d",
            intervalMs: [400, 820],
            quality: "usable",
            reasonIfMissing: null,
          },
        ],
      },
    ],
    strokes: [
      {
        strokeId: "st-1",
        startMs: 0,
        endMs: 1000,
        anchor: { type: "wrist_speed_peak", timeMs: 400 },
        impactTimeMs: null,
        complete: true,
        // 真实的一板会有阶段转变（只有 complete 挥拍才会进证据包，
        // 而闭合时**无条件**产生 stroke_closed）
        phaseEvents: [
          { eventType: "backswing_start", timeMs: 240, supportFrameIds: ["f-1"] },
          { eventType: "forward_start", timeMs: 400, supportFrameIds: ["f-1"] },
          { eventType: "return_start", timeMs: 640, supportFrameIds: ["f-1"] },
          { eventType: "stroke_closed", timeMs: 1000, supportFrameIds: ["f-1"] },
        ],
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
        strokeId: "st-1",
        width: 960,
        height: 540,
        role: "forward",
        eventTimeOffsetMs: 0,
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
    limitations: [
      "单目二维骨架，无法判断肌肉紧张、发力大小、足底承重或力量传递效率",
      "关键帧锚在检出的阶段转变上（引拍／前挥／还原开始、本板闭合）：共 2 张，其中 1 张就在转变时刻（偏移 0ms）",
      "本组有 1 个阶段转变在时间窗内没有可用画面（第 1 板的 本板闭合）——这些时刻只有数值证据",
    ],
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
    // 默认给"导入视频"：这样才能让回放那条路被默认用例走到。
    // 摄像头那条（没有录像）另有专门用例。
    sourceKind: "video",
    videoFileName: "forehand-1.mp4",
    // 一条能画出线的曲线（两个点就够）；曲线本身的画法在 elbow-curve.test.tsx 里守
    elbowTrace: {
      intervalMs: [0, 1000],
      samples: [
        { tMs: 0, elbowAngleDeg: 150 },
        { tMs: 100, elbowAngleDeg: 120 },
        { tMs: 200, elbowAngleDeg: 90 },
      ],
      events: [{ strokeId: "st-1", eventType: "forward_start", timeMs: 100 }],
      strokeSpans: [{ strokeId: "st-1", startMs: 0, endMs: 1000 }],
    },
    ...overrides,
  };
}

/** 与默认 fixture 的 `videoFileName` 一致的"当前加载的那支视频"。 */
const MATCHING_REPLAY = { url: "blob:fake-forehand-1", fileName: "forehand-1.mp4" };

function renderPanel(
  items: ReviewItem[],
  onRate: (id: string, r: UserRating) => void = vi.fn(),
  replay: { url: string; fileName: string } | null = MATCHING_REPLAY,
) {
  return render(
    <ReviewPanel
      reviews={items}
      onRate={onRate}
      onExport={vi.fn()}
      thresholds={DEFAULT_THRESHOLDS}
      replay={replay}
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
 * 逐板数值与过程（R5/R4 的用户可见面）。
 *
 * 为什么值得单独守：逐板数值与阶段事件是**喂给模型**的（R5/R4），
 * 而复查页此前只显示组级标量 —— 用户看不到模型看到的那些数。
 * 这一栏就是把"模型看到的东西"摆到用户面前。
 */
describe("ReviewPanel · 逐板数值与过程", () => {
  it("把这一板的测量值列出来（不是只有组级标量）", () => {
    renderPanel([makeReviewItem()]);
    expect(screen.getByText("逐板数值与过程")).toBeInTheDocument();
    // 逐板那张表里出现这个量；组级表里也有同名量，所以用 getAllByText
    expect(screen.getAllByText("return_after_wrist_peak_ms").length).toBeGreaterThanOrEqual(2);
    // 逐板值 380 与组级值 420 都要能看见（当前 fixture：逐板 380）
    expect(screen.getByText("380")).toBeInTheDocument();
  });

  it("阶段转变按**时间顺序**列出来，且写明不是击球时刻", () => {
    renderPanel([makeReviewItem()]);
    const steps = document.querySelectorAll(".phase-step");
    expect(steps, "一板四个阶段转变，应当四个都在").toHaveLength(4);
    const text = [...steps].map((s) => s.textContent ?? "");
    expect(text[0]).toContain("引拍开始");
    expect(text[1]).toContain("前挥开始");
    expect(text[2]).toContain("还原开始");
    expect(text[3]).toContain("本板闭合");
    // 时刻要写出来，用户才能与关键帧的时间戳对上
    expect(text[3]).toContain("1000ms");
    // 红线 2：不能让用户把这些时刻读成击球。
    // 用**精确匹配**：这半句在页面里是独立的 <strong>，而曲线那一栏写的是
    // "都不是击球时刻"（多一个字），所以精确匹配不会撞上它。
    expect(screen.getByText("不是击球时刻")).toBeInTheDocument();
  });

  it("**某板自己的值缺失**时显示缺失 + 原因，不填 0", () => {
    const packet = makePacket({
      perStrokeFeatures: [
        {
          strokeId: "st-1",
          features: [
            {
              id: "return_after_wrist_peak_ms",
              value: null,
              unit: "ms",
              coordinateSpace: "image_2d",
              intervalMs: [400, 820],
              quality: "limited",
              reasonIfMissing: "本板未观察到回到准备区",
            },
          ],
        },
      ],
    });
    renderPanel([makeReviewItem({ packet })]);
    expect(screen.getByText("本板未观察到回到准备区")).toBeInTheDocument();
    expect(screen.getByText("缺失")).toBeInTheDocument();
  });

  it("没有记录到阶段转变时明说，而不是留一片空白", () => {
    const packet = makePacket({
      strokes: [{ ...makePacket().strokes[0]!, phaseEvents: [] }],
    });
    renderPanel([makeReviewItem({ packet })]);
    expect(screen.getByText(/本板没有记录到阶段转变/)).toBeInTheDocument();
  });

  it("**两板分别列出**，不合并（「哪一板」正是这一栏存在的理由）", () => {
    const base = makePacket();
    const packet = makePacket({
      strokes: [
        base.strokes[0]!,
        {
          ...base.strokes[0]!,
          strokeId: "st-2",
          startMs: 1200,
          endMs: 2200,
          anchor: { type: "wrist_speed_peak", timeMs: 1600 },
          phaseEvents: [
            { eventType: "backswing_start", timeMs: 1440, supportFrameIds: ["f-2"] },
            { eventType: "stroke_closed", timeMs: 2200, supportFrameIds: ["f-2"] },
          ],
          evidenceFrameIds: ["f-2"],
        },
      ],
      perStrokeFeatures: [base.perStrokeFeatures[0]!, { strokeId: "st-2", features: [] }],
      keyframes: [
        base.keyframes[0]!,
        { ...base.keyframes[0]!, id: "kf-2", frameId: "f-2", strokeId: "st-2", role: "ready" },
      ],
    });
    renderPanel([makeReviewItem({ packet })]);

    expect(screen.getByText("第 1 板")).toBeInTheDocument();
    expect(screen.getByText("第 2 板")).toBeInTheDocument();
    // 第二板只有两个转变，两块时间线不会混在一起
    expect(document.querySelectorAll(".phase-step")).toHaveLength(6);
    // 第二板没有可用测量 —— 逐板表要说出来
    expect(screen.getByText("本板没有可用测量值。")).toBeInTheDocument();
  });

  it("肘角曲线进来时画出来，没取到时明说而不是画一条空的", () => {
    renderPanel([makeReviewItem()]);
    expect(screen.getByText("肘角曲线（逐帧）")).toBeInTheDocument();
    expect(document.querySelectorAll(".elbow-segment").length).toBeGreaterThan(0);
  });

  it("没有逐帧几何时**明说**，不画一条空白曲线", () => {
    renderPanel([makeReviewItem({ elbowTrace: null })]);
    expect(document.querySelectorAll(".elbow-segment")).toHaveLength(0);
    expect(screen.getByText(/没有逐帧几何可画/)).toBeInTheDocument();
  });

  it("证据包的局限**原样**显示 —— 用户要能看到模型只知道这些", () => {
    renderPanel([makeReviewItem()]);
    expect(screen.getByText("证据包的局限")).toBeInTheDocument();
    expect(screen.getByText(/关键帧锚在/)).toBeInTheDocument();
    expect(screen.getByText(/没有可用画面/)).toBeInTheDocument();
  });
});

/**
 * 短片回放（评审 §1.7）。
 *
 * 这一栏最容易做错的地方**不是播放本身，而是"什么情况下不该放"**：
 * 摄像头链路根本没有录像（全仓库没有 MediaRecorder），而"换了一支视频"
 * 会让时间轴对不上 —— 那种情况下放出来的是一段不相干的画面，
 * 却看起来像这一板的证据。所以下面把三种"不能放"分开钉住。
 */
describe("ReviewPanel · 短视频回放", () => {
  const videoEl = (): HTMLVideoElement => {
    const el = document.querySelector("video.replay");
    expect(el, "回放画面没渲染出来").not.toBeNull();
    return el as HTMLVideoElement;
  };

  /**
   * 起点**故意不是 0**。
   *
   * 默认 fixture 那一板从 0ms 开始，而 `video.currentTime` 初值也是 0 ——
   * 于是"跳到起点"与"根本没跳"结果一样，断言会**空转通过**
   * （把 seek 那一行删掉，测试照样绿）。起点挪到 1200ms 之后，
   * 只有真的跳了才会读到 1.2 秒。
   */
  const packetStartingAt = (startMs: number): EvidencePacket => {
    const base = makePacket();
    return makePacket({
      strokes: [{ ...base.strokes[0]!, startMs, endMs: startMs + 1000 }],
    });
  };

  it("导入视频：每一板都有一个「回放这一板」按钮", () => {
    renderPanel([makeReviewItem()]);
    expect(screen.getAllByText("回放这一板")).toHaveLength(1);
    expect(videoEl().getAttribute("src")).toBe(MATCHING_REPLAY.url);
  });

  it("点回放会**定位到该板起点**（源时间与视频时间同一把尺子）", () => {
    const packet = packetStartingAt(1200);
    renderPanel([makeReviewItem({ packet })]);
    expect(videoEl().currentTime, "还没点就已经在起点了？这条用例会空转").toBe(0);
    fireEvent.click(screen.getByText("回放这一板"));
    // 用 currentTime 断言"确实跳过去了"，而不是只断言按钮变了字
    expect(videoEl().currentTime).toBeCloseTo(1.2, 5);
    // 按钮变成"正在回放…"，用户知道点中了哪一板
    expect(screen.getByText("正在回放…")).toBeInTheDocument();
  });

  it("**未闭合的板**不给放（不知道停在哪），按钮禁用并说明原因", () => {
    const packet = makePacket({
      strokes: [{ ...makePacket().strokes[0]!, endMs: null }],
    });
    renderPanel([makeReviewItem({ packet })]);
    const btn = screen.getByText("回放这一板") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain("回放不知道停在哪");
  });

  it("**摄像头来源**：明说没有录像，而不是只把按钮藏起来", () => {
    // 藏起来读起来像"这一版没做回放"；说出来才是"这条路本来就没有录像"。
    // 摄像头链路只保留关键帧、不做录制 —— 这是个产品事实，用户该知道。
    renderPanel([makeReviewItem({ sourceKind: "camera", videoFileName: null })]);
    expect(screen.queryByText("回放这一板")).toBeNull();
    expect(screen.getByText(/来自摄像头/)).toBeInTheDocument();
    expect(screen.getByText(/不录制视频/)).toBeInTheDocument();
  });

  it("**换了一支视频**：拒绝回放并说明时间轴对不上（最危险的一种）", () => {
    renderPanel(
      [makeReviewItem()],
      vi.fn(),
      // 当前加载的是另一支文件
      { url: "blob:other", fileName: "another-clip.mp4" },
    );
    expect(screen.queryByText("回放这一板")).toBeNull();
    expect(screen.getByText(/时间轴对不上/)).toBeInTheDocument();
    // 两边的文件名都要写出来，用户才知道该重新导入哪一支
    expect(screen.getByText(/forehand-1\.mp4/)).toBeInTheDocument();
    expect(screen.getByText(/another-clip\.mp4/)).toBeInTheDocument();
  });

  it("**文件已不在本页**（刷新过）：明说并给出可执行的下一步", () => {
    renderPanel([makeReviewItem()], vi.fn(), null);
    expect(screen.queryByText("回放这一板")).toBeNull();
    expect(screen.getByText(/已不在本页/)).toBeInTheDocument();
    expect(screen.getByText(/重新导入同一支视频/)).toBeInTheDocument();
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
