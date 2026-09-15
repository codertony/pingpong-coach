/**
 * 知识选择与允许输出集合测试。
 *
 * 这里要钉死的核心安全性质：
 * **只有 status === "reviewed" 且 referenceId 非 null 的知识，
 *   才允许支撑「达标/不达标」判断。**
 * 这条一旦失守，系统就会给用户一个没有依据的技术判定。
 */

import { describe, expect, it } from "vitest";
import {
  collectAllowedOutputs,
  selectKnowledge,
  type KnowledgeBase,
} from "../src/coach/knowledge.js";
import { makeKnowledgeEntry } from "./fixtures.js";

function makeKb(entries: ReturnType<typeof makeKnowledgeEntry>[]): KnowledgeBase {
  return { version: "1.0.0", entries };
}

describe("selectKnowledge", () => {
  it("按 strokeType + focusId + cameraView 三者同时匹配", () => {
    const kb = makeKb([makeKnowledgeEntry()]);
    const hit = selectKnowledge(kb, {
      strokeType: "forehand_drive",
      focusId: "return_to_ready_zone",
      cameraView: "front",
    });
    expect(hit).toHaveLength(1);
  });

  it("动作类型不匹配则不进入候选", () => {
    const kb = makeKb([makeKnowledgeEntry()]);
    const hit = selectKnowledge(kb, {
      strokeType: "backhand_drive",
      focusId: "return_to_ready_zone",
      cameraView: "front",
    });
    expect(hit).toHaveLength(0);
  });

  it("关注点不匹配则不进入候选", () => {
    const kb = makeKb([makeKnowledgeEntry()]);
    const hit = selectKnowledge(kb, {
      strokeType: "forehand_drive",
      focusId: "elbow_extension_pattern",
      cameraView: "front",
    });
    expect(hit).toHaveLength(0);
  });

  it("机位不在白名单内则不进入候选（避免把不适用建议发给用户）", () => {
    const kb = makeKb([makeKnowledgeEntry({ cameraViews: ["left_side"] })]);
    const hit = selectKnowledge(kb, {
      strokeType: "forehand_drive",
      focusId: "return_to_ready_zone",
      cameraView: "front",
    });
    expect(hit).toHaveLength(0);
  });

  it("cameraViews 为空数组表示不限机位", () => {
    const kb = makeKb([makeKnowledgeEntry({ cameraViews: [] })]);
    const hit = selectKnowledge(kb, {
      strokeType: "forehand_drive",
      focusId: "return_to_ready_zone",
      cameraView: "right_side",
    });
    expect(hit).toHaveLength(1);
  });

  it("空知识库返回空候选而不是抛错", () => {
    const hit = selectKnowledge(makeKb([]), {
      strokeType: "forehand_drive",
      focusId: "return_to_ready_zone",
      cameraView: "front",
    });
    expect(hit).toEqual([]);
  });
});

describe("collectAllowedOutputs", () => {
  it("没有条目时 hasReviewedReference 为 false（意味着只能 observation_only）", () => {
    const allowed = collectAllowedOutputs([]);
    expect(allowed.hasReviewedReference).toBe(false);
    expect(allowed.referenceId).toBeNull();
  });

  it("未审核条目：即使有 referenceId 也不构成已审核参考", () => {
    const allowed = collectAllowedOutputs([
      makeKnowledgeEntry({ status: "observation_only", referenceId: "ref-1" }),
    ]);
    // 这是关键安全性质：status 不是 reviewed，就不能算有参考。
    expect(allowed.hasReviewedReference).toBe(false);
  });

  it("reviewed 但 referenceId 为 null：同样不构成已审核参考", () => {
    const allowed = collectAllowedOutputs([
      makeKnowledgeEntry({ status: "reviewed", referenceId: null }),
    ]);
    // 两个条件必须同时满足，缺一不可。
    expect(allowed.hasReviewedReference).toBe(false);
  });

  it("reviewed 且 referenceId 非 null：构成已审核参考", () => {
    const allowed = collectAllowedOutputs([
      makeKnowledgeEntry({ status: "reviewed", referenceId: "ref-1" }),
    ]);
    expect(allowed.hasReviewedReference).toBe(true);
    expect(allowed.referenceId).toBe("ref-1");
  });

  it("多条知识：只要有一条已审核即视为有参考", () => {
    const allowed = collectAllowedOutputs([
      makeKnowledgeEntry({ id: "a", status: "observation_only", referenceId: null }),
      makeKnowledgeEntry({ id: "b", status: "reviewed", referenceId: "ref-b" }),
    ]);
    expect(allowed.hasReviewedReference).toBe(true);
    expect(allowed.referenceId).toBe("ref-b");
  });

  it("提示与训练项去重合并", () => {
    const allowed = collectAllowedOutputs([
      makeKnowledgeEntry({ reviewedCues: ["回到预备位", "保持节奏"], allowedDrillIds: ["d1"] }),
      makeKnowledgeEntry({ reviewedCues: ["回到预备位"], allowedDrillIds: ["d1", "d2"] }),
    ]);
    expect(allowed.cues.sort()).toEqual(["保持节奏", "回到预备位"].sort());
    expect(allowed.drillIds.sort()).toEqual(["d1", "d2"]);
  });

  it("真实仓库里的知识条目当前都未审核（防止有人误改成 reviewed）", async () => {
    // 这条测试记录一个事实状态：首版知识全部是 observation_only。
    // 如果有人把知识改成 reviewed，这个测试会失败，提醒他要同时准备好参考片段。
    const { loadKnowledge } = await import("../src/coach/knowledge.js");
    const kb = await loadKnowledge();
    const reviewed = kb.entries.filter((e) => e.status === "reviewed");
    expect(kb.entries.length).toBeGreaterThan(0);
    expect(reviewed).toHaveLength(0);
  });
});
