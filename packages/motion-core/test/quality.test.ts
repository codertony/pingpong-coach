import { describe, expect, it } from "vitest";
import type { Keypoint2D, PoseFrame } from "@pingpong/contracts";
import { SCHEMA_VERSION } from "@pingpong/contracts";
import {
  assessFrameQuality,
  DEFAULT_QUALITY_CONFIG,
  racketSideKeypointNames,
  summarizeGroupQuality,
} from "../src/quality.js";

function kp(
  name: string,
  x: number,
  y: number,
  score: number | null = 0.9,
  visible: boolean | null = true,
): Keypoint2D {
  return { name, xPx: x, yPx: y, score, visible };
}

const W = 1280;
const H = 720;

/** 构造一个右持拍、肩肘腕位置上合理的帧 */
function frame(overrides: Partial<PoseFrame> & { keypoints2D?: Keypoint2D[] } = {}): PoseFrame {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "s1",
    frameId: "f1",
    sourceEpoch: 0,
    sourceTimeMs: 0,
    receivedAtMonoMs: 0,
    modelId: "pose_landmarker_full",
    keypointSet: "blaze_33",
    imageWidth: W,
    imageHeight: H,
    keypoints2D: [
      kp("right_shoulder", 800, 200),
      kp("right_elbow", 900, 300),
      kp("right_wrist", 1000, 350),
      kp("left_shoulder", 600, 200),
      kp("right_hip", 780, 430),
      kp("left_hip", 620, 430),
    ],
    quality: "usable",
    qualityReasons: [],
    ...overrides,
  };
}

describe("racketSideKeypointNames", () => {
  it("返回持拍侧的肩肘腕三点", () => {
    expect(racketSideKeypointNames("right")).toEqual([
      "right_shoulder",
      "right_elbow",
      "right_wrist",
    ]);
    expect(racketSideKeypointNames("left")).toEqual(["left_shoulder", "left_elbow", "left_wrist"]);
  });
});

describe("assessFrameQuality", () => {
  it("关键点齐全、分数达标、画面内 → usable", () => {
    const r = assessFrameQuality(frame(), "right");
    expect(r.quality).toBe("usable");
    expect(r.reasons).toEqual([]);
  });

  it("持拍侧关键点缺失 → unusable", () => {
    const f = frame({
      keypoints2D: [
        kp("right_shoulder", 800, 200),
        kp("right_elbow", 900, 300),
        // 缺 right_wrist
      ],
    });
    const r = assessFrameQuality(f, "right");
    expect(r.quality).toBe("unusable");
    expect(r.reasons.some((x) => x.includes("missing_keypoint:right_wrist"))).toBe(true);
  });

  it("引擎标记 visible=false → unusable，与低分区分", () => {
    const f = frame({
      keypoints2D: [
        kp("right_shoulder", 800, 200),
        kp("right_elbow", 900, 300),
        kp("right_wrist", 1000, 350, 0.9, false),
      ],
    });
    const r = assessFrameQuality(f, "right");
    expect(r.quality).toBe("unusable");
    expect(r.reasons.some((x) => x.startsWith("not_visible:"))).toBe(true);
  });

  it("分数偏低但可见 → limited，而非 unusable", () => {
    const f = frame({
      keypoints2D: [
        kp("right_shoulder", 800, 200),
        kp("right_elbow", 900, 300, 0.3),
        kp("right_wrist", 1000, 350),
      ],
    });
    const r = assessFrameQuality(f, "right");
    expect(r.quality).toBe("limited");
    expect(r.reasons.some((x) => x.startsWith("low_score:"))).toBe(true);
  });

  it("关节贴边出画 → unusable", () => {
    const f = frame({
      keypoints2D: [
        kp("right_shoulder", 800, 200),
        kp("right_elbow", 900, 300),
        kp("right_wrist", 1, 350),
      ],
    });
    const r = assessFrameQuality(f, "right");
    expect(r.quality).toBe("unusable");
    expect(r.reasons.some((x) => x.startsWith("out_of_frame:"))).toBe(true);
  });

  it("骨段长度突变 → limited（分数可能仍然很高）", () => {
    const prev = frame({
      frameId: "f0",
      sourceTimeMs: 0,
      keypoints2D: [
        kp("right_shoulder", 800, 200),
        kp("right_elbow", 900, 300),
        kp("right_wrist", 1000, 350),
      ],
    });
    // 肘腕距离从约 112 突增到约 316：长度比变化远超 0.35 阈值。
    // 注意让腕点仍在画面内（x < 1280），以单独验证骨段跳变这一条，
    // 不让 out_of_frame 抢先把它降成 unusable。
    const cur = frame({
      frameId: "f1",
      sourceTimeMs: 40,
      keypoints2D: [
        kp("right_shoulder", 800, 200),
        kp("right_elbow", 900, 300),
        kp("right_wrist", 1200, 400),
      ],
    });
    const r = assessFrameQuality(cur, "right", prev);
    expect(r.quality).toBe("limited");
    expect(r.reasons.some((x) => x.startsWith("bone_length_jump:"))).toBe(true);
  });

  it("采样间隔过大 → limited", () => {
    const prev = frame({ frameId: "f0", sourceTimeMs: 0 });
    const cur = frame({ frameId: "f1", sourceTimeMs: 500 });
    const r = assessFrameQuality(cur, "right", prev);
    expect(r.quality).toBe("limited");
    expect(r.reasons).toContain("sampling_gap");
  });

  it("时间非单调 → unusable", () => {
    const prev = frame({ frameId: "f0", sourceTimeMs: 100 });
    const cur = frame({ frameId: "f1", sourceTimeMs: 50 });
    const r = assessFrameQuality(cur, "right", prev);
    expect(r.quality).toBe("unusable");
    expect(r.reasons).toContain("non_monotonic_time");
  });

  it("跨 sourceEpoch 不做跳变与间隔比较", () => {
    const prev = frame({ frameId: "f0", sourceTimeMs: 0, sourceEpoch: 0 });
    const cur = frame({ frameId: "f1", sourceTimeMs: 5000, sourceEpoch: 1 });
    const r = assessFrameQuality(cur, "right", prev);
    expect(r.quality).toBe("usable");
  });
});

describe("summarizeGroupQuality", () => {
  const mk = (quality: "usable" | "limited" | "unusable", reasons: string[] = []) =>
    frame({ quality, qualityReasons: reasons });

  it("按全部帧计算有效比例，不剔除难帧", () => {
    const frames = [
      mk("usable"),
      mk("usable"),
      mk("usable"),
      mk("usable"),
      mk("unusable", ["arm_occluded"]),
    ];
    const s = summarizeGroupQuality(frames);
    expect(s.totalFrames).toBe(5);
    expect(s.usableFrames).toBe(4);
    expect(s.usableRatio).toBeCloseTo(0.8, 10);
    // 恰好等于门槛 0.8 → 可判
    expect(s.judgeable).toBe(true);
    expect(s.reasons).toContain("arm_occluded");
  });

  it("有效比例低于门槛时不可判", () => {
    const s = summarizeGroupQuality([mk("usable"), mk("unusable"), mk("unusable")]);
    expect(s.usableRatio).toBeCloseTo(1 / 3, 6);
    expect(s.judgeable).toBe(false);
  });

  it("空组不可判", () => {
    const s = summarizeGroupQuality([]);
    expect(s.judgeable).toBe(false);
    expect(s.usableRatio).toBe(0);
  });

  it("自定义门槛可覆盖默认值", () => {
    const frames = [mk("usable"), mk("unusable")];
    const s = summarizeGroupQuality(frames, {
      ...DEFAULT_QUALITY_CONFIG,
      minUsableFrameRatio: 0.5,
    });
    expect(s.judgeable).toBe(true);
  });
});
