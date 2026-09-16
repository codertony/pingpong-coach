/**
 * R1 回归：组级肘角**曾经把"角度"当成"时间"用**。
 *
 * 原实现（`computeFeatures` 里）：
 *
 * ```ts
 * const perStroke = ...map(s => computeElbowAngleAtWristPeak(geoms, s.anchor.timeMs, 80, ...))
 *                       .map(f => f.value)      // ← 这是**度**
 *                       .filter(v => v != null);
 * features.push(computeElbowAngleAtWristPeak(geoms, median(perStroke) ?? first.anchor.timeMs, 80, interval));
 *                                                     // ↑ 塞进了 anchorTimeMs
 * ```
 *
 * `median(perStroke)` 是角度（几十到一百多度），却被当成**毫秒**传进了锚点参数。
 * 于是函数去 t≈143ms 附近找几何，算出来的是**那个时刻**的肘角 ——
 * 早期没采到几何时就是 `null`，采到了则是一个与"本组中位数"毫不相干的读数。
 * 它旁边那条返回准备区时间的特征写法是对的（中位数进**值**，锚点单独给），
 * 两处一对比就看得出。
 *
 * ## 这个用例怎么把它逼出来
 *
 * 让素材**前 1 秒没有人体**（`detected: false` → 不产生几何），再把挥拍放在后面。
 * 这样"t ≈ 角度值 ms"那段根本没有几何：
 * - 旧实现 → `value` 为 `null`（"腕速峰值前后 80ms 内没有可用肘角采样"）；
 * - 新实现 → 正常给出本组的中位数。
 *
 * 第二条用例则**独立重算**一遍（用 motion-core 自己的公开函数，
 * 从同一批关键点重算每板肘角再取中位数），把"中位数"这个语义钉死 ——
 * 只断言"不是 null"的话，改成均值或取某一板都能混过去。
 */

import { describe, expect, it } from "vitest";
import type { EvidencePacket, FeatureValue, PoseFrame, StrokeEvent } from "@pingpong/contracts";
import { SCHEMA_VERSION } from "@pingpong/contracts";
import { computeElbowAngleAtWristPeak, extractFrameGeometry, median } from "@pingpong/motion-core";
import { TrainingSession } from "../src/training/training-session.js";
import { makeConfig, makeFrame, OFFSETS, READY } from "./helpers/synthetic-strokes.js";
import type { PoseResult } from "../src/vision/pose-engine.js";

/** 把夹具产出的 PoseResult 包成 PoseFrame（与产品里 toPoseFrame 的结果等价，
 *  质量字段不参与几何提取，这里只需形状合法）。 */
function toPoseFrame(r: PoseResult): PoseFrame {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: "s",
    frameId: r.frameId,
    sourceEpoch: r.sourceEpoch,
    sourceTimeMs: r.sourceTimeMs,
    receivedAtMonoMs: r.receivedAtMonoMs,
    modelId: "pose_landmarker",
    keypointSet: r.keypointSet,
    imageWidth: r.imageWidth,
    imageHeight: r.imageHeight,
    keypoints2D: r.keypoints2D,
    quality: "usable",
    qualityReasons: [],
  };
}

/** 喂一段"无人"前缀 + 3 轮挥拍，交出一组。 */
function run(idlePrefixFrames: number): {
  features: FeatureValue[];
  strokes: StrokeEvent[];
  fed: PoseResult[];
} {
  const features: FeatureValue[] = [];
  const strokes: StrokeEvent[] = [];
  const fed: PoseResult[] = [];
  const session = new TrainingSession(
    makeConfig({ focusId: "elbow_extension_pattern", strokesPerGroup: 1_000_000 }),
    {
      onStatus: () => {},
      onStroke: (s) => strokes.push(s),
      onFeedback: () => {},
      onGroupComplete: (p: EvidencePacket) => features.push(...p.features),
    },
  );
  session.setReadyZone(READY);

  let t = 0;
  let frames = 0;
  for (let i = 0; i < idlePrefixFrames; i++) {
    const r = makeFrame(frames, t, 0, { detected: false });
    fed.push(r);
    session.pushPoseResult(r);
    t += 40;
    frames++;
  }
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const offset of OFFSETS) {
      const r = makeFrame(frames, t, offset);
      fed.push(r);
      session.pushPoseResult(r);
      t += 40;
      frames++;
    }
  }

  session.finishGroup("测试用：本组到此为止");
  session.dispose();
  return { features, strokes, fed };
}

function elbowFeature(features: FeatureValue[]): FeatureValue {
  const f = features.find((x) => x.id === "elbow_angle_at_wrist_peak_deg");
  expect(f, "本组没有肘角特征 —— 关注点或特征 id 对不上，用例失效").toBeDefined();
  return f!;
}

describe("R1 · 组级肘角取的是中位数，不是一个按角度当时刻查出来的读数", () => {
  it("**素材前段没有人**时仍然给出本组中位数（旧实现在这里返回 null）", () => {
    const { features, strokes } = run(25); // 前 25 帧无人 ≈ 1 秒
    // 先确认这份夹具真的产生了挥拍，否则测的是别的东西
    expect(strokes.length, "这段合成动作一次挥拍都没检出，用例失效").toBeGreaterThan(0);

    const f = elbowFeature(features);
    expect(
      f.value,
      "组级肘角是 null —— 角度又被当成时间用了（去 t≈角度值 那个时刻找不到几何）",
    ).not.toBeNull();
    expect(f.reasonIfMissing, "给了值却还带着缺失原因").toBeNull();
    expect(f.quality).not.toBe("unusable");
    // 小窗口只有 ±80ms 宽（161ms）；组级必须是整组区间
    expect(
      f.intervalMs[1] - f.intervalMs[0],
      "区间是某一次挥拍的小窗口，不是整组区间",
    ).toBeGreaterThan(300);
  });

  it("数值 = 每板肘角中位数（用 motion-core 自己的函数独立重算）", () => {
    const { features, strokes, fed } = run(25);
    const geoms = fed.map((r) => extractFrameGeometry(toPoseFrame(r), "right"));

    const perStroke = strokes
      .map(
        (s) =>
          computeElbowAngleAtWristPeak(geoms, s.anchor.timeMs, 80, [
            s.anchor.timeMs,
            s.anchor.timeMs,
          ]).value,
      )
      .filter((v): v is number => v != null);

    expect(perStroke.length, "独立重算一次都没取到每板肘角，用例失效").toBeGreaterThan(0);
    const expected = median(perStroke);

    expect(elbowFeature(features).value).toBeCloseTo(expected!, 6);
  });
});
