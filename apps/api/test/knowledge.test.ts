/**
 * 知识选择与允许输出集合测试。
 *
 * 这里要钉死的核心安全性质：
 * **只有一条知识"经得起审"（status 是 reviewed，且审核人／来源／许可／适用条件／
 *   参考片段五项都给全），才允许支撑「达标/不达标」判断。**
 * 这条一旦失守，系统就会给用户一个没有依据的技术判定。
 *
 * ⚠️ 第一版的门禁只看 `status` 与 `referenceId` 两项 —— 于是把 status 改一下、
 * 随便填个字符串当 referenceId，「达标」就通了（F-062）。现在缺任何一项都
 * **按未审核处理**，并且要**被记下来**（`unsupportedReviewedClaims`），
 * 由服务端写进 limitations 与提示词 —— 静默降级与"当成审过了"在结果上是一样的。
 */

import { describe, expect, it } from "vitest";
import {
  collectAllowedOutputs,
  reviewedClaimDefects,
  selectKnowledge,
  type KnowledgeBase,
} from "../src/coach/knowledge.js";
import { makeKnowledgeEntry, makeReviewedKnowledgeEntry } from "./fixtures.js";

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

  it("reviewed 但 referenceId 为 null：不构成已审核参考", () => {
    const allowed = collectAllowedOutputs([
      makeKnowledgeEntry({ status: "reviewed", referenceId: null }),
    ]);
    expect(allowed.hasReviewedReference).toBe(false);
  });

  it("**五项都给全**才算站得住的已审核参考", () => {
    const allowed = collectAllowedOutputs([makeReviewedKnowledgeEntry()]);
    expect(allowed.hasReviewedReference).toBe(true);
    expect(allowed.referenceId).toBe("ref-1");
    expect(allowed.unsupportedReviewedClaims).toEqual([]);
  });

  it("多条知识：只要有一条经得起审即视为有参考", () => {
    const allowed = collectAllowedOutputs([
      makeKnowledgeEntry({ id: "a", status: "observation_only", referenceId: null }),
      makeReviewedKnowledgeEntry({ id: "b", referenceId: "ref-b" }),
    ]);
    expect(allowed.hasReviewedReference).toBe(true);
    expect(allowed.referenceId).toBe("ref-b");
  });

  /**
   * 缺任何一项前置条件，都**不解锁**，并且要**被记下来**。
   *
   * 这一组就是 F-062 的核心：光改 `status` 不够 —— 审核不是改一个字段，
   * 而是"参考真实存在、来源与审核人写清、适用条件说明白"。
   * 上一版只看 `status` 与 `referenceId`，于是「随便填个字符串」就能解锁达标判定。
   */
  it("**缺审核人**：即使 status/referenceId 都齐，也不解锁，且被记账", () => {
    const allowed = collectAllowedOutputs([makeReviewedKnowledgeEntry({ reviewer: null })]);
    expect(allowed.hasReviewedReference).toBe(false);
    expect(allowed.unsupportedReviewedClaims).toEqual([{ id: "kb-1", defects: ["没有审核人"] }]);
  });

  it("**缺许可 / 缺适用条件 / 缺来源**：各自都不解锁，理由写清", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ license: null }, "没有许可说明"],
      [{ appliesTo: null }, "没有适用条件"],
      [{ sources: [] }, "没有来源"],
    ];
    for (const [overrides, expectedDefect] of cases) {
      const allowed = collectAllowedOutputs([makeReviewedKnowledgeEntry(overrides)]);
      expect(allowed.hasReviewedReference, `缺「${expectedDefect}」却解锁了达标判定`).toBe(false);
      expect(allowed.unsupportedReviewedClaims[0]?.defects).toContain(expectedDefect);
    }
  });

  it("**只写空白字符不算写了**（「   」与缺项同等处理）", () => {
    const allowed = collectAllowedOutputs([makeReviewedKnowledgeEntry({ reviewer: "   " })]);
    expect(allowed.hasReviewedReference).toBe(false);
    expect(allowed.unsupportedReviewedClaims[0]?.defects).toContain("没有审核人");
  });

  it("未审核的条目不会出现在 unsupported 里（它没声称过什么）", () => {
    const allowed = collectAllowedOutputs([makeKnowledgeEntry()]);
    expect(allowed.unsupportedReviewedClaims).toEqual([]);
  });

  it("`reviewedClaimDefects` 一次给出**全部**缺项，不是只报第一个", () => {
    const defects = reviewedClaimDefects(
      makeKnowledgeEntry({ status: "reviewed", sources: [] }) as Parameters<
        typeof reviewedClaimDefects
      >[0],
    );
    expect(defects).toEqual([
      "没有审核人",
      "没有来源",
      "没有许可说明",
      "没有适用条件",
      "没有参考片段 id",
    ]);
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
