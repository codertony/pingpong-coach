/**
 * R2 / R3 / R4 回归：关键帧的**阶段标签**、**候选是否真的有图**、
 * 以及**这张图是按什么挑出来的**。
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
 *
 * ## R4 · 「按时间挑的图」不能冒充事件时刻
 *
 * 这一条经历了两个阶段，值得记下来：
 * 1. 事件还没有的时候（F-054 之前），能做到的极限是**如实写明**「这些图是按区间
 *    时间比例挑的，不是检出的事件时刻」—— 名字像事件，不能让它被读成事件；
 * 2. 事件有了之后，比例挑法**整条拆掉**，改为每张图锚在检出的阶段转变上
 *    （`selectRepresentativeFrames`）。所以那句免责声明不再成立，
 *    换成"锚在哪些事件上、各偏了多少毫秒"，而且**配不上图时要报缺失**。
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
  packets: EvidencePacket[];
  keyframesMissing: number | null;
  statuses: string[];
  limitations: string[];
} {
  const keyframes: EvidenceKeyframe[] = [];
  const packets: EvidencePacket[] = [];
  const statuses: string[] = [];
  const limitations: string[] = [];
  const session = new TrainingSession(makeConfig({ strokesPerGroup: 1_000_000 }), {
    onStatus: (t) => statuses.push(t),
    onStroke: () => {},
    onFeedback: () => {},
    onGroupComplete: (p: EvidencePacket) => {
      packets.push(p);
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
  return { keyframes, packets, keyframesMissing: missing, statuses, limitations };
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
    // 角色现在**由事件推出**：这一板的合成动作里确实有引拍与前挥两个转变，
    // 所以对应的两张一定存在（不再依赖"锚点附近/区间前段"这种比例位置）
    expect(roles, `角色集合是 ${JSON.stringify([...new Set(roles)])}`).toContain("forward");
    expect(roles).toContain("backswing");
  });
});

describe("R4 · 关键帧锚在检出的事件上，不是按时间比例挑的", () => {
  it("每张图都写明**属于哪一板、锚在哪个事件上偏了多少**", () => {
    const { keyframes, packets } = run(true);
    expect(keyframes.length).toBeGreaterThan(0);

    const strokeIds = new Set(packets.flatMap((p) => p.strokes.map((s) => s.strokeId)));
    for (const k of keyframes) {
      expect(k.strokeId, `关键帧 ${k.id} 没有板号`).toBeTruthy();
      expect(strokeIds, `关键帧 ${k.id} 声明了一个不存在的板`).toContain(k.strokeId);
      // 偏移按定义是「本帧时刻 − 锚定事件时刻」，而候选只从**事件窗内**取，
      // 所以它不可能为负 —— 负偏移意味着挑到了事件之前的帧（借窗外的图）
      expect(
        k.eventTimeOffsetMs,
        `关键帧 ${k.id} 的偏移是负的（${k.eventTimeOffsetMs}）—— 挑到了锚定事件之前的帧`,
      ).toBeGreaterThanOrEqual(0);
    }
    // 至少有若干张是**恰在转变时刻**的，否则"锚在事件上"就是空话
    expect(
      keyframes.filter((k) => k.eventTimeOffsetMs === 0).length,
      "没有一张图落在转变时刻上",
    ).toBeGreaterThan(0);
  });

  it("限制说明改成**按实际挑法**讲，不再有「按区间时间比例挑选」那句", () => {
    const { keyframes, limitations } = run(true);
    expect(keyframes.length).toBeGreaterThan(0);
    const text = limitations.join("\n");
    expect(text, "比例挑法已经拆掉了，那句免责声明留着就是错的").not.toContain(
      "按挥拍区间的时间比例挑选",
    );
    expect(text, "没说清楚图是锚在事件上的").toContain("锚在");
    // 「前挥开始」不能被读成击球瞬间（红线 2）
    expect(text).toContain("不要把「前挥开始」读成「击球瞬间」");
    // 说了有几张是转变时刻、几张是相位内的峰值帧
    expect(text).toMatch(/\d+ 张就在转变时刻/);
  });

  it("三类的张数**互斥且加起来正好等于总张数**（峰值帧与退让帧不能混为一谈）", () => {
    // 偏移 > 0 有两种来路：故意的相位内峰值帧，与「转变那一刻没采到图」的退让。
    // 第一版把两者一律说成峰值帧 —— 那在真实素材上就是假话（18 张里只有 6 张偏移为 0）。
    const { keyframes, limitations } = run(3);
    const text = limitations.join("\n");
    const m = text.match(
      /共 (\d+) 张，其中 (\d+) 张就在转变时刻（偏移 0ms）、(\d+) 张是该相位内的腕速峰值帧、(\d+) 张是/,
    );
    expect(m, `没找到三类张数那句话：${text}`).not.toBeNull();
    const [total, atEvent, peak, fallback] = m!.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    expect(total).toBe(keyframes.length);
    expect(atEvent + peak + fallback, "三类不是互斥的（加起来不等于总数）").toBe(total);
    // 至少得有一张真的落在转变时刻上，否则「锚在事件上」是空话
    expect(atEvent).toBeGreaterThan(0);
  });

  it("**没有图**时不带这句说明 —— 它只在真的有图时才有意义", () => {
    const { keyframes, limitations } = run(false);
    expect(keyframes).toHaveLength(0);
    expect(limitations.join("\n")).not.toContain("锚在");
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
