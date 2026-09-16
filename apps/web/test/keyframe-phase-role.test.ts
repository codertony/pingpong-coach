/**
 * R2 / R3 回归：关键帧的**阶段标签**与**候选是否真的有图**。
 *
 * ## R2 · 阶段标签全丢
 *
 * `selectRepresentativeFrames` 会算出每张图的角色（引拍 / 前挥 / 还原 / 准备），
 * 但调用点只把 `frameId` 传给 `buildKeyframes`，而那个函数的 `role` 参数
 * **带默认值 `"other"`** —— 于是每一张图的角色都落到默认值上。
 *
 * 后果不是"少一个字段"：提示词里写着 `角色=${k.role}`，模型看到六张一律 `other`，
 * 没法知道哪张是引拍、哪张在击球附近，只能讲"整体节奏"这类没有落点的话。
 *
 * 修法是**删掉那个默认值**（参数现在必须显式传角色），不是在调用点补一个实参：
 * 只要还能省略，下一次改动就会再漏一次。
 *
 * ## R3 · 挑帧时不管有没有图
 *
 * 选帧原先拿"时间窗内的姿态帧"当候选、`bytes` 填空数组，挑完才去缓存里找图，
 * 找不到只记一笔 `missing`。而图片是**每 3 帧**采一张，姿态帧却帧帧都有 ——
 * 两个集合不一样大，于是"挑中的那几张恰好没采图"是常态，
 * **附近明明有可用的图，却白白少发几张**给模型。
 */

import { describe, expect, it } from "vitest";
import type { EvidencePacket, EvidenceKeyframe } from "@pingpong/contracts";
import { TrainingSession } from "../src/training/training-session.js";
import { makeConfig, makeFrame, OFFSETS, READY } from "./helpers/synthetic-strokes.js";

/**
 * 连喂 3 轮挥拍并成组。
 *
 * @param withPixels 每帧是否都放一张（假）图片进缓存；给数字则按"每 N 帧一张"
 *   模拟真实的采集侧（`KEYFRAME_CAPTURE_EVERY_N_FRAMES = 3`）。
 */
function run(withPixels: boolean | number): {
  keyframes: EvidenceKeyframe[];
  keyframesMissing: number | null;
  statuses: string[];
  limitations: string[];
} {
  const keyframes: EvidenceKeyframe[] = [];
  const statuses: string[] = [];
  const limitations: string[] = [];
  const session = new TrainingSession(makeConfig({ strokesPerGroup: 1_000_000 }), {
    onStatus: (t) => statuses.push(t),
    onStroke: () => {},
    onFeedback: () => {},
    onGroupComplete: (p: EvidencePacket) => {
      keyframes.push(...p.keyframes);
      limitations.push(...p.limitations);
    },
  });
  session.setReadyZone(READY);

  const everyN = typeof withPixels === "number" ? withPixels : 1;
  let t = 0;
  let frames = 0;
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const offset of OFFSETS) {
      if (withPixels !== false && frames % everyN === 0) {
        // 一小段假字节代替真实 JPEG：本文件测的是"选帧与缓存是否对得上"
        session.addFramePixels(`f${frames}`, t, new Uint8Array([1, 2, 3]), 960, 540);
      }
      session.pushPoseResult(makeFrame(frames, t, offset));
      t += 40;
      frames++;
    }
  }
  session.finishGroup("测试用：本组到此为止");
  const missing = session.telemetry.keyframesMissing;
  session.dispose();
  return { keyframes, keyframesMissing: missing, statuses, limitations };
}

describe("R2 · 关键帧带上了阶段角色", () => {
  it("角色不是清一色 other —— 引拍/前挥至少各有一张", () => {
    const { keyframes } = run(true);
    expect(keyframes.length, "一张关键帧都没有，用例失效").toBeGreaterThan(0);

    const roles = keyframes.map((k) => k.role);
    expect(
      roles.every((r) => r === "other"),
      "所有关键帧的角色都是 other —— 阶段标签又丢了（role 的默认值复活了？）",
    ).toBe(false);
    // 选帧逻辑一定会挑锚点附近那张（forward）和区间前段那张（backswing）
    expect(roles, `角色集合是 ${JSON.stringify([...new Set(roles)])}`).toContain("forward");
    expect(roles).toContain("backswing");
  });
});

describe("R4 · 不让「按时间挑的图」冒充事件时刻", () => {
  it("有图时**如实写明**关键帧是按区间时间比例挑的，不是检出的事件", () => {
    const { keyframes, limitations } = run(true);
    expect(keyframes.length).toBeGreaterThan(0);
    expect(
      limitations.join("\n"),
      "关键帧的 role 名字很像事件（backswing / forward），却没说明它是怎么挑的",
    ).toContain("按挥拍区间的时间比例挑选");
  });

  it("**没有图**时不带这句话 —— 它只在真的有图时才有意义", () => {
    const { keyframes, limitations } = run(false);
    expect(keyframes).toHaveLength(0);
    expect(limitations.join("\n")).not.toContain("按挥拍区间的时间比例挑选");
  });
});

describe("R3 · 只从有图的帧里挑", () => {
  it("**每 3 帧一张图**（真实的采集频率）时，一张都不该缺", () => {
    const { keyframes, keyframesMissing, statuses } = run(3);
    expect(keyframes.length, "有图却一张都没选出来").toBeGreaterThan(0);
    expect(keyframesMissing, "有几十张可用的图，却还是报了「取不到图」—— 挑帧时又没看缓存").toBe(0);
    expect(
      statuses.some((s) => s.includes("取不到")),
      "不该出现的「取不到图」提示出现了",
    ).toBe(false);
  });

  it("每帧都有图时也是一张不缺（两种密度都成立）", () => {
    const { keyframes, keyframesMissing } = run(true);
    expect(keyframes.length).toBeGreaterThan(0);
    expect(keyframesMissing).toBe(0);
  });
});
