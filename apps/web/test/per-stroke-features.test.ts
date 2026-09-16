/**
 * 逐板测量值（R5）。
 *
 * 评审的原话是"用组统计替代逐板过程"：角度范围、返回时间都在**整组区间**求值，
 * 模型只拿到少量汇总标量 ⇒ 它没法回答"哪一板、哪个阶段、从何时开始"。
 *
 * 而逐板的数**本来就在手里**（组级特征的口径就是"先算每板、再取中位数"），
 * 只是在聚合时被丢掉了。这个文件钉住两件事：
 *
 * 1. **一一对应**：每一板都有条目，条目也对得上某一板（漏一板 = 悄悄丢一板的证据，
 *    而它读起来像"那一板没有可测的量"）；
 * 2. **两层一致**：组级中位数必须等于逐板值的中位数 —— 它们必须来自**同一批挥拍、
 *    同一批几何**。这正是把 `currentGroupWindow()` 抽出来的原因：
 *    两处各过滤一遍，改了其中一处就会让两个层级的数字来自不同的帧集合，而谁都看不出来。
 */

import { describe, expect, it } from "vitest";
import type { EvidencePacket, FeatureValue } from "@pingpong/contracts";
import { median } from "@pingpong/motion-core";
import { TrainingSession } from "../src/training/training-session.js";
import { driveCycles, makeConfig, READY } from "./helpers/synthetic-strokes.js";

function run(cycles: number): EvidencePacket {
  let packet: EvidencePacket | null = null;
  const session = new TrainingSession(makeConfig({ strokesPerGroup: 1_000_000 }), {
    onStatus: () => {},
    onStroke: () => {},
    onFeedback: () => {},
    onGroupComplete: (p) => {
      packet = p;
    },
  });
  session.setReadyZone(READY);
  driveCycles(session, cycles);
  session.finishGroup("测试用：本组到此为止");
  session.dispose();
  expect(packet, "没有成组，用例失效").not.toBeNull();
  return packet!;
}

function perStrokeValue(
  p: EvidencePacket,
  strokeId: string,
  featureId: string,
): FeatureValue | null {
  const entry = p.perStrokeFeatures.find((e) => e.strokeId === strokeId);
  return entry?.features.find((f) => f.id === featureId) ?? null;
}

describe("逐板测量值", () => {
  it("**每一板都有条目**，且条目都能对上某一板", () => {
    const p = run(3);
    expect(p.strokes.length).toBeGreaterThan(0);
    expect(p.perStrokeFeatures).toHaveLength(p.strokes.length);

    const strokeIds = p.strokes.map((s) => s.strokeId).sort();
    const entryIds = p.perStrokeFeatures.map((e) => e.strokeId).sort();
    expect(entryIds).toEqual(strokeIds);
    // 空的 features 数组仍然是一一对应，但那意味着"这一板什么都没算"——
    // 这里要求每条都真的带了测量
    for (const e of p.perStrokeFeatures) {
      expect(e.features.length, `${e.strokeId} 一条测量都没有`).toBeGreaterThan(0);
    }
  });

  it("**组级中位数 = 逐板值的中位数**（两层必须来自同一批数据）", () => {
    const p = run(3);
    const group = p.features.find((f) => f.id === "return_after_wrist_peak_ms");
    expect(group, "组级返回时间特征不存在").toBeDefined();

    const perStroke = p.strokes
      .map((s) => perStrokeValue(p, s.strokeId, "return_after_wrist_peak_ms")?.value)
      .filter((v): v is number => v != null);
    expect(perStroke.length, "一次都没算到逐板返回时间").toBeGreaterThan(0);

    expect(group!.value).toBeCloseTo(median(perStroke)!, 6);
  });

  it("每一板的区间是**它自己的**锚点—终点，不是组区间", () => {
    const p = run(3);
    for (const s of p.strokes) {
      const f = perStrokeValue(p, s.strokeId, "return_after_wrist_peak_ms");
      expect(f, `${s.strokeId} 没有返回时间`).not.toBeNull();
      expect(f!.intervalMs[0]).toBe(s.anchor.timeMs);
      expect(f!.intervalMs[1]).toBe(s.endMs);
    }
  });

  it("逐板值带上质量与缺失原因字段（缺失不写成 0 的前提）", () => {
    const p = run(3);
    for (const e of p.perStrokeFeatures) {
      for (const f of e.features) {
        expect(f.quality, `${f.id} 没有质量档`).toBeTruthy();
        // 有值时不许带缺失原因 —— 那是自相矛盾
        if (f.value != null) expect(f.reasonIfMissing).toBeNull();
      }
    }
  });
});

/**
 * 阶段事件（R4）：这一板的**过程**随证据包一起走。
 *
 * 上面测的是"逐板的数"，这里测的是"逐板的**分段**" —— 两者合起来，
 * 模型才有素材回答"哪一板、哪个阶段、从何时开始"。
 */
describe("阶段事件", () => {
  it("每一板都带**有序**的阶段事件，且落在该板自己的起止范围内", () => {
    const p = run(3);
    for (const s of p.strokes) {
      expect(s.phaseEvents.length, `${s.strokeId} 没有阶段事件 —— 过程又丢了`).toBeGreaterThan(0);
      const times = s.phaseEvents.map((e) => e.timeMs);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(times[0]!).toBeGreaterThanOrEqual(s.startMs);
      expect(times[times.length - 1]!).toBeLessThanOrEqual(s.endMs!);
    }
  });

  it("完整走完的一板以 `stroke_closed` 收尾（过程与结论对得上）", () => {
    const p = run(3);
    for (const s of p.strokes) {
      expect(s.complete).toBe(true);
      expect(s.phaseEvents[s.phaseEvents.length - 1]!.eventType).toBe("stroke_closed");
    }
  });
});

/**
 * 逐阶段时长（R5 后半）：证据包里**每一个量都在描述分段**了。
 *
 * 这条走的是**产品链路**（TrainingSession → 证据包），不是纯函数直调 ——
 * 纯函数有自己的单测，这里要确认它真的被接进去了、且与事件时刻对得上。
 */
describe("逐阶段时长", () => {
  const PHASE_DURATIONS = ["backswing_duration_ms", "forward_duration_ms", "return_duration_ms"];

  it("每一板都带上三个阶段时长，且都算出了值", () => {
    const p = run(3);
    expect(p.strokes.length).toBeGreaterThan(0);
    for (const s of p.strokes) {
      const entry = p.perStrokeFeatures.find((e) => e.strokeId === s.strokeId)!;
      for (const id of PHASE_DURATIONS) {
        const f = entry.features.find((x) => x.id === id);
        expect(f, `${s.strokeId} 缺 ${id} —— 过程还是没被量化`).toBeDefined();
        expect(f!.value, `${id} 在本板不该缺失（这一板是完整闭合的）`).not.toBeNull();
        expect(f!.value!).toBeGreaterThan(0);
      }
    }
  });

  it("时长与**这一板自己的事件时刻**对得上（不是别处算来的）", () => {
    const p = run(3);
    for (const s of p.strokes) {
      const entry = p.perStrokeFeatures.find((e) => e.strokeId === s.strokeId)!;
      const first = (t: string): number => s.phaseEvents.find((e) => e.eventType === t)!.timeMs;

      // 合成夹具每板只走一遍各阶段，所以时长就等于相邻事件之差
      expect(entry.features.find((x) => x.id === "backswing_duration_ms")!.value).toBe(
        first("forward_start") - first("backswing_start"),
      );
      expect(entry.features.find((x) => x.id === "return_duration_ms")!.value).toBe(
        first("stroke_closed") - first("return_start"),
      );
    }
  });
});
