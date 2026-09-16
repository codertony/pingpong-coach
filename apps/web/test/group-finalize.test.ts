/**
 * 素材播完后，**已经收集到的那半组怎么办**。
 *
 * 用户报的现象："导入视频后一直在轮询播放，反复播放且不会停止"，
 * 以及"运行后未看到任何评估结果返回"。后者有两层，这里是第二层：
 *
 * 组边界 `strokesPerGroup`（默认 3）是**交互概念**，而导入的视频是**有限长**的。
 * 成组只在凑满时发生，于是"导入一段视频 → 什么都不发生"就是默认体验 ——
 * 一次有效挥拍都不会被送出去分析。
 *
 * 这个文件钉住的是：**素材结束**这个客观事实优先于"这组还差几次挥拍"，
 * 并且**不足额必须写在证据包里**，不能假装这组本来就该这么大。
 */

import { describe, expect, it } from "vitest";
import type { EvidencePacket } from "@pingpong/contracts";
import { TrainingSession } from "../src/training/training-session.js";
import { driveCycles, makeConfig } from "./helpers/synthetic-strokes.js";

interface Recorder {
  packets: EvidencePacket[];
  statuses: string[];
  session: TrainingSession;
}

function makeSession(strokesPerGroup = 3): Recorder {
  const packets: EvidencePacket[] = [];
  const statuses: string[] = [];
  const session = new TrainingSession(makeConfig({ strokesPerGroup }), {
    onStatus: (t) => statuses.push(t),
    onStroke: () => {},
    onFeedback: () => {},
    onGroupComplete: (p) => packets.push(p),
  });
  session.setReadyZone({ x: 640, y: 420 });
  return { packets, statuses, session };
}

describe("素材播完时把当前这组交出去", () => {
  it("凑不满 strokesPerGroup 时，**仍然**交出一组（否则导入视频永远没有结果）", () => {
    const r = makeSession(3);
    // 只喂 1 轮：1 次有效挥拍，离 3 还差 2 次
    driveCycles(r.session, 1);
    expect(r.packets, "还没到成组条件，此刻不该有包").toHaveLength(0);

    const emitted = r.session.finishGroup("视频已播放完毕");

    expect(emitted).toBe(true);
    expect(r.packets).toHaveLength(1);
    // 交出去的就是**实际收到的那几次**，不补齐、不重复
    expect(r.packets[0]!.strokes).toHaveLength(1);
    r.session.dispose();
  });

  it("不足额这件事必须写进 limitations —— 不能假装这组本来就该这么大", () => {
    const r = makeSession(3);
    driveCycles(r.session, 2); // 2/3
    r.session.finishGroup("视频已播放完毕");

    const limitations = r.packets[0]!.limitations.join("\n");
    expect(limitations, "没写不足额，模型会把 2 次挥拍当成本组全部表现").toContain("提前结束");
    // 原因与具体数字都要有：只写"提前结束"没法判断缺了多少
    expect(limitations).toContain("视频已播放完毕");
    expect(limitations).toContain("2/3");
    r.session.dispose();
  });

  it("**正常凑满**的那一组不带「提前结束」的说明（否则这句话就成了背景噪音）", () => {
    const r = makeSession(3);
    driveCycles(r.session, 3); // 正好 3 次 → 正常成组
    expect(r.packets).toHaveLength(1);
    expect(r.packets[0]!.strokes).toHaveLength(3);
    expect(r.packets[0]!.limitations.join("\n")).not.toContain("提前结束");
    r.session.dispose();
  });

  it("一次有效挥拍都没有时**不交空包**，并且说明白", () => {
    const r = makeSession(3);
    // 只喂准备帧：完全没有挥拍
    driveCycles(r.session, 0);

    const emitted = r.session.finishGroup("视频已播放完毕");

    expect(emitted, "没有挥拍却交出一组 = 让模型对空样本编结论").toBe(false);
    expect(r.packets).toHaveLength(0);
    expect(r.statuses.join("\n")).toContain("没有检出");
    r.session.dispose();
  });

  it("成组之后素材才结束，不会再多出一个空组", () => {
    const r = makeSession(3);
    driveCycles(r.session, 3); // 正好凑满并被交出去
    expect(r.packets).toHaveLength(1);

    const emitted = r.session.finishGroup("视频已播放完毕");

    expect(emitted, "组已经交出去了，结束事件不该再补一个空组").toBe(false);
    expect(r.packets).toHaveLength(1);
    r.session.dispose();
  });

  it("交出去之后组计数前进，不会被下一段素材续用", () => {
    const r = makeSession(3);
    driveCycles(r.session, 1);
    const firstGroupId = r.session.groupId;
    r.session.finishGroup("视频已播放完毕");
    expect(r.session.groupId, "提前结束的组也要推进组号，否则两段的证据会同名").not.toBe(
      firstGroupId,
    );
    r.session.dispose();
  });
});
