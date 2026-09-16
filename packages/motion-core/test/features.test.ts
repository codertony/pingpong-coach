import { describe, expect, it } from "vitest";
import type { Keypoint2D, PoseFrame } from "@pingpong/contracts";
import { FEATURE_IDS, SCHEMA_VERSION } from "@pingpong/contracts";
import {
  computeElbowAngleRange,
  computeElbowAngleAtWristPeak,
  computeElbowTorsoDrift,
  computeIntraGroupConsistency,
  computeReturnAfterWristPeak,
  extractFrameGeometry,
  summarizeValues,
} from "../src/features.js";

function kp(name: string, x: number, y: number, visible = true): Keypoint2D {
  return { name, xPx: x, yPx: y, score: 0.9, visible };
}

function frame(keypoints: Keypoint2D[], frameId = "f1", timeMs = 0): PoseFrame {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "s1",
    frameId,
    sourceEpoch: 0,
    sourceTimeMs: timeMs,
    receivedAtMonoMs: timeMs,
    modelId: "pose_landmarker_full",
    keypointSet: "blaze_33",
    imageWidth: 1280,
    imageHeight: 720,
    keypoints2D: keypoints,
    quality: "usable",
    qualityReasons: [],
  };
}

/** 一个几何上合理的右持拍帧：肩在上、肘在中、腕在右 */
function normalFrame(emphasizeElbowY = 300): PoseFrame {
  return frame([
    kp("left_shoulder", 600, 200),
    kp("right_shoulder", 800, 200),
    kp("right_elbow", 900, emphasizeElbowY),
    kp("right_wrist", 1000, 350),
    kp("left_hip", 620, 430),
    kp("right_hip", 780, 430),
  ]);
}

describe("extractFrameGeometry", () => {
  it("计算肘角、肘相对躯干偏移与体尺度", () => {
    const g = extractFrameGeometry(normalFrame(), "right");
    expect(g.elbowAngleDeg).not.toBeNull();
    expect(g.elbowAngleDeg!).toBeGreaterThan(0);
    expect(g.elbowAngleDeg!).toBeLessThanOrEqual(180);
    expect(g.elbowRelTorsoBodyScale).not.toBeNull();
    expect(g.bodyScalePx).not.toBeNull();
    expect(g.bodyScalePx!).toBeGreaterThan(0);
  });

  it("持拍侧关键点缺失时对应测量为 null，不补零", () => {
    const f = frame([
      kp("left_shoulder", 600, 200),
      kp("right_shoulder", 800, 200),
      // 缺右肘与右腕
      kp("left_hip", 620, 430),
      kp("right_hip", 780, 430),
    ]);
    const g = extractFrameGeometry(f, "right");
    expect(g.elbowAngleDeg).toBeNull();
    expect(g.elbowRelTorsoBodyScale).toBeNull();
  });

  it("visible=false 的点不参与计算", () => {
    const f = frame([
      kp("left_shoulder", 600, 200),
      kp("right_shoulder", 800, 200),
      kp("right_elbow", 900, 300, false),
      kp("right_wrist", 1000, 350),
    ]);
    const g = extractFrameGeometry(f, "right");
    expect(g.elbowAngleDeg).toBeNull();
  });

  it("肘相对躯干偏移是相对于躯干参考点、并按体尺度归一化", () => {
    const g = extractFrameGeometry(normalFrame(), "right");
    // 单位是体尺度倍数，量级应在 1 以内
    expect(Math.abs(g.elbowRelTorsoBodyScale!.x)).toBeLessThan(3);
    expect(Math.abs(g.elbowRelTorsoBodyScale!.y)).toBeLessThan(3);
  });

  it("左手持拍时读取左侧关节，与右手结果不同", () => {
    const left = frame([
      kp("left_shoulder", 600, 200),
      kp("right_shoulder", 800, 200),
      kp("left_elbow", 500, 300),
      kp("left_wrist", 400, 350),
      kp("left_hip", 620, 430),
      kp("right_hip", 780, 430),
    ]);
    const g = extractFrameGeometry(left, "left");
    expect(g.elbowAngleDeg).not.toBeNull();
    const gRight = extractFrameGeometry(left, "right");
    expect(gRight.elbowAngleDeg).toBeNull();
  });
});

describe("computeElbowAngleRange", () => {
  it("取区间内最大与最小的差", () => {
    const gs = [
      {
        frameId: "a",
        sourceTimeMs: 0,
        elbowAngleDeg: 120,
        elbowRelTorsoBodyScale: null,
        bodyScalePx: 100,
      },
      {
        frameId: "b",
        sourceTimeMs: 40,
        elbowAngleDeg: 150,
        elbowRelTorsoBodyScale: null,
        bodyScalePx: 100,
      },
      {
        frameId: "c",
        sourceTimeMs: 80,
        elbowAngleDeg: 90,
        elbowRelTorsoBodyScale: null,
        bodyScalePx: 100,
      },
    ];
    const f = computeElbowAngleRange(gs, [0, 80]);
    expect(f.value).toBe(60);
    expect(f.unit).toBe("deg");
    expect(f.quality).toBe("usable");
  });

  it("全部缺失时 value 为 null 并给出原因，而不是 0", () => {
    const gs = [
      {
        frameId: "a",
        sourceTimeMs: 0,
        elbowAngleDeg: null,
        elbowRelTorsoBodyScale: null,
        bodyScalePx: null,
      },
    ];
    const f = computeElbowAngleRange(gs, [0, 0]);
    expect(f.value).toBeNull();
    expect(f.quality).toBe("unusable");
    expect(f.reasonIfMissing).not.toBeNull();
  });

  it("过半缺失时降为 limited", () => {
    const gs = [
      {
        frameId: "a",
        sourceTimeMs: 0,
        elbowAngleDeg: 120,
        elbowRelTorsoBodyScale: null,
        bodyScalePx: 100,
      },
      {
        frameId: "b",
        sourceTimeMs: 40,
        elbowAngleDeg: null,
        elbowRelTorsoBodyScale: null,
        bodyScalePx: null,
      },
      {
        frameId: "c",
        sourceTimeMs: 80,
        elbowAngleDeg: null,
        elbowRelTorsoBodyScale: null,
        bodyScalePx: null,
      },
    ];
    const f = computeElbowAngleRange(gs, [0, 80]);
    expect(f.quality).toBe("limited");
    expect(f.value).toBe(0); // 单个值 → 范围为 0，是真实测量而非缺失
  });
});

describe("computeElbowTorsoDrift", () => {
  it("计算相对躯干位移的包围盒对角长度", () => {
    const gs = [
      {
        frameId: "a",
        sourceTimeMs: 0,
        elbowAngleDeg: null,
        elbowRelTorsoBodyScale: { x: 0, y: 0 },
        bodyScalePx: 100,
      },
      {
        frameId: "b",
        sourceTimeMs: 40,
        elbowAngleDeg: null,
        elbowRelTorsoBodyScale: { x: 0.3, y: 0.4 },
        bodyScalePx: 100,
      },
    ];
    const f = computeElbowTorsoDrift(gs, [0, 40]);
    expect(f.value).toBeCloseTo(0.5, 10);
    expect(f.unit).toBe("body_scale");
    expect(f.coordinateSpace).toBe("body_relative_2d");
  });

  it("无可用点时为 null 并说明原因", () => {
    const f = computeElbowTorsoDrift(
      [
        {
          frameId: "a",
          sourceTimeMs: 0,
          elbowAngleDeg: null,
          elbowRelTorsoBodyScale: null,
          bodyScalePx: null,
        },
      ],
      [0, 0],
    );
    expect(f.value).toBeNull();
    expect(f.quality).toBe("unusable");
  });

  it("超过一半采样点缺失时降级为 limited，且 reasonIfMissing 不为 null", () => {
    // 这条锁死一个曾经的真实缺陷：该函数把 qualityOf 返回的 reason 丢掉，
    // 硬写 reasonIfMissing: null，导致质量降级时调用方看不到任何解释。
    // value 在这条路径上仍非 null（包围盒总存在），所以 reasonIfMissing
    // 是唯一的质量说明来源，丢了就等于「静默降级」。
    const gs = [
      {
        frameId: "a",
        sourceTimeMs: 0,
        elbowAngleDeg: null,
        elbowRelTorsoBodyScale: { x: 0, y: 0 },
        bodyScalePx: 100,
      },
      {
        frameId: "b",
        sourceTimeMs: 40,
        elbowAngleDeg: null,
        elbowRelTorsoBodyScale: null,
        bodyScalePx: null,
      },
      {
        frameId: "c",
        sourceTimeMs: 80,
        elbowAngleDeg: null,
        elbowRelTorsoBodyScale: null,
        bodyScalePx: null,
      },
    ];
    const f = computeElbowTorsoDrift(gs, [0, 80]);
    expect(f.quality).toBe("limited");
    expect(f.reasonIfMissing).not.toBeNull();
    expect(f.reasonIfMissing).toContain("缺失");
  });

  it("全部可用时 quality 为 usable 且 reasonIfMissing 为 null", () => {
    const mk = (t: number, x: number, y: number) => ({
      frameId: `f-${t}`,
      sourceTimeMs: t,
      elbowAngleDeg: null,
      elbowRelTorsoBodyScale: { x, y },
      bodyScalePx: 100,
    });
    const f = computeElbowTorsoDrift([mk(0, 0, 0), mk(40, 0.1, 0.1)], [0, 40]);
    expect(f.quality).toBe("usable");
    expect(f.reasonIfMissing).toBeNull();
  });
});

describe("computeReturnAfterWristPeak", () => {
  it("返回峰值到回到准备区的时间差", () => {
    const f = computeReturnAfterWristPeak(1000, 1420, [1000, 1420]);
    expect(f.value).toBe(420);
    expect(f.unit).toBe("ms");
    expect(f.id).toBe(FEATURE_IDS.RETURN_AFTER_WRIST_PEAK);
  });

  it("缺少峰值锚点时拒绝给值", () => {
    const f = computeReturnAfterWristPeak(null, 1420, [0, 1420]);
    expect(f.value).toBeNull();
    expect(f.reasonIfMissing).toContain("锚点缺失");
  });

  it("未观察到回到准备区时拒绝给值", () => {
    const f = computeReturnAfterWristPeak(1000, null, [1000, 1000]);
    expect(f.value).toBeNull();
    expect(f.quality).toBe("limited");
  });

  it("时序倒置（先回区后出峰值）视为异常，不给值", () => {
    const f = computeReturnAfterWristPeak(1000, 900, [900, 1000]);
    expect(f.value).toBeNull();
    expect(f.quality).toBe("unusable");
  });

  it("命名不含 impact 字样，避免被误读为击球后恢复时间", () => {
    const f = computeReturnAfterWristPeak(1000, 1200, [1000, 1200]);
    expect(f.id).not.toContain("impact");
    expect(f.id).toContain("wrist_peak");
  });
});

describe("computeIntraGroupConsistency", () => {
  it("多次挥拍取值稳定时变异系数很小", () => {
    const f = computeIntraGroupConsistency(
      [500, 502, 498],
      "return_after_wrist_peak_ms",
      [0, 1000],
    );
    expect(f.value).not.toBeNull();
    expect(f.value!).toBeLessThan(0.01);
  });

  it("有效挥拍不足 2 次时拒绝评价", () => {
    const f = computeIntraGroupConsistency([500], "x", [0, 1000]);
    expect(f.value).toBeNull();
    expect(f.reasonIfMissing).toContain("不足 2 次");
  });

  it("稳定地做错也会得到很低离散度 —— 一致性不代表正确性", () => {
    // 三次都稳定地偏离同一方向
    const wrongButStable = computeIntraGroupConsistency([1200, 1205, 1195], "x", [0, 1000]);
    expect(wrongButStable.value!).toBeLessThan(0.01);
  });
});

describe("summarizeValues", () => {
  it("忽略 null 并给出统计量", () => {
    const s = summarizeValues([100, null, 200, 300]);
    expect(s.count).toBe(3);
    expect(s.mean).toBeCloseTo(200, 10);
    expect(s.median).toBe(200);
    expect(s.min).toBe(100);
    expect(s.max).toBe(300);
  });

  it("全为 null 时各项为 null 且计数为 0", () => {
    const s = summarizeValues([null, null]);
    expect(s.count).toBe(0);
    expect(s.mean).toBeNull();
    expect(s.median).toBeNull();
  });
});

/**
 * 腕速峰值处的肘角。
 *
 * 这个函数此前**零覆盖**，而且从未被任何产品代码调用 ——
 * 而「肘角伸展模式」在界面上是**用户可选**的关注点。
 * 也就是说：用户选了它，产品却静默不算对应指标。
 * 现在接上了，这些用例守住新语义。
 *
 * 核心纪律：**窗口必须锚在真实事件上**。
 * 如果退化回"拿整个区间取中位数"，就等于声称一个我们在锚点处没测到的量 ——
 * 下面第一条用例专门挡这个。
 */
describe("computeElbowAngleAtWristPeak", () => {
  const geo = (timeMs: number, angle: number | null) => ({
    frameId: `f${timeMs}`,
    sourceTimeMs: timeMs,
    elbowAngleDeg: angle,
    elbowRelTorsoBodyScale: null,
    bodyScalePx: 200,
  });

  it("只取锚点附近窗口内的采样，远处的值不得混入", () => {
    const geometries = [
      geo(0, 100),
      geo(500, 120),
      geo(1000, 170), // 锚点处
      geo(1040, 174),
      geo(2000, 40), // 远端的极端值：若窗口没生效，它会污染结果
    ];

    const f = computeElbowAngleAtWristPeak(geometries, 1000, 80);

    // 窗口 ±80ms → 只含 1000 与 1040 两帧
    expect(f.value).toBeCloseTo((170 + 174) / 2, 5);
    // 如果实现退化成"整区间中位数"，结果会是 120 —— 用这条钉死
    expect(f.value).not.toBeCloseTo(120, 1);
    expect(f.quality).toBe("usable");
  });

  it("窗口内没有采样时报缺失 + 原因，不用窗口外的帧冒充", () => {
    const geometries = [geo(0, 100), geo(500, 120), geo(2000, 40)];

    const f = computeElbowAngleAtWristPeak(geometries, 1000, 80);

    expect(f.value).toBeNull();
    expect(f.quality).toBe("unusable");
    expect(f.reasonIfMissing).toContain("80ms");
  });

  it("窗口边界是闭区间（恰好 ±windowMs 的采样算在内）", () => {
    const geometries = [geo(920, 150), geo(1080, 160)];

    const f = computeElbowAngleAtWristPeak(geometries, 1000, 80);

    expect(f.value).toBeCloseTo(155, 5);
  });

  it("窗口内有采样但全为 null 时，仍报缺失并说明是采样不可用", () => {
    const geometries = [geo(980, null), geo(1020, null)];

    const f = computeElbowAngleAtWristPeak(geometries, 1000, 80);

    expect(f.value).toBeNull();
    expect(f.quality).toBe("unusable");
    expect(f.reasonIfMissing).not.toBeNull();
  });

  it("特征是 elbow_angle_at_wrist_peak_deg —— 不是 forward_peak", () => {
    // 命名纪律：契约里没有"向前挥拍峰值"这个时刻，叫那个名字等于
    // 声称一个没算出来的量（与 return_after_wrist_peak 不叫 recovery_after_impact 同理）
    const f = computeElbowAngleAtWristPeak([geo(1000, 170)], 1000, 80);
    expect(f.id).toBe("elbow_angle_at_wrist_peak_deg");
    expect(f.id).not.toContain("forward_peak");
  });
});
