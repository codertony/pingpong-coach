/**
 * 提示词构建测试。
 *
 * 提示词是第二道防线（第一道是服务端校验），但它仍有两个硬要求：
 * 1. 缺失值绝不能渲染成 0 —— 否则模型会把「没测到」当成「测到 0」。
 * 2. 未审核时必须把「不得输出合格」明写进提示词，减少模型越界概率。
 */

import { describe, expect, it } from "vitest";
import { buildPrompt, SYSTEM_PROMPT, OUTPUT_SCHEMA_HINT } from "../src/coach/prompt.js";
import type { AllowedOutputs, KnowledgeEntry } from "../src/coach/knowledge.js";
import { makeFeature, makeKnowledgeEntry, makePacket, makeStroke } from "./fixtures.js";

const noAllowed: AllowedOutputs = {
  cues: [],
  drillIds: [],
  hasReviewedReference: false,
  referenceId: null,
};

function entryList(...e: ReturnType<typeof makeKnowledgeEntry>[]): KnowledgeEntry[] {
  return e as unknown as KnowledgeEntry[];
}

describe("SYSTEM_PROMPT 内容约束", () => {
  it("明确禁止把 wrist_speed_peak 当作击球时刻", () => {
    expect(SYSTEM_PROMPT).toContain("wrist_speed_peak");
    expect(SYSTEM_PROMPT).toContain("击球时刻");
  });

  it("明确禁止由单目骨架推断发力类结论", () => {
    expect(SYSTEM_PROMPT).toContain("肌肉发力");
    expect(SYSTEM_PROMPT).toContain("足底承重");
  });

  it("明确缺失数据不是零", () => {
    expect(SYSTEM_PROMPT).toContain("缺失数据不是零");
  });

  it("明确无已审核参考时使用 observation_only", () => {
    expect(SYSTEM_PROMPT).toContain("observation_only");
  });
});

describe("buildPrompt — 缺失值渲染", () => {
  it("value 为 null 时渲染为「无可用值」并带原因，绝不渲染成 0", () => {
    const packet = makePacket({
      features: [
        makeFeature({
          id: "elbow_relative_torso_drift_body_scale",
          value: null,
          unit: "body_scale",
          coordinateSpace: "body_relative_2d",
          quality: "unusable",
          reasonIfMissing: "肩部关键点置信度过低",
        }),
      ],
    });
    const { user } = buildPrompt(packet, [], noAllowed);

    expect(user).toContain("无可用值");
    expect(user).toContain("肩部关键点置信度过低");
    // 关键：这个特征不能出现 "0 body_scale" 这种把缺失当测量的写法。
    expect(user).not.toContain("drift_body_scale: 0");
  });

  it("缺失且未给原因时使用占位说明而不是留空", () => {
    const packet = makePacket({
      features: [makeFeature({ value: null, quality: "unusable", reasonIfMissing: null })],
    });
    const { user } = buildPrompt(packet, [], noAllowed);
    expect(user).toContain("未说明");
  });

  it("有值时渲染数值与单位、坐标空间、质量", () => {
    const packet = makePacket({
      features: [makeFeature({ value: 260, unit: "ms", quality: "usable" })],
    });
    const { user } = buildPrompt(packet, [], noAllowed);
    expect(user).toContain("260 ms");
    expect(user).toContain("quality".replace("quality", "质量=usable"));
    expect(user).toContain("坐标空间=image_2d");
  });
});

describe("buildPrompt — 挥拍渲染", () => {
  it("endMs 为 null 时渲染为「未闭合」而不是 0", () => {
    const packet = makePacket({ strokes: [makeStroke({ endMs: null })] });
    const { user } = buildPrompt(packet, [], noAllowed);
    expect(user).toContain("未闭合");
  });

  it("不完整挥拍会带上问题原因", () => {
    const packet = makePacket({
      strokes: [makeStroke({ complete: false, reasons: ["sampling_gap_too_large"] })],
    });
    const { user } = buildPrompt(packet, [], noAllowed);
    expect(user).toContain("不完整");
    expect(user).toContain("sampling_gap_too_large");
  });

  it("无挥拍时给出明确占位", () => {
    const { user } = buildPrompt(makePacket({ strokes: [] }), [], noAllowed);
    expect(user).toContain("本组无有效挥拍");
  });
});

describe("buildPrompt — 审核状态与允许集合", () => {
  it("无已审核参考时，提示词写明「不得输出技术动作合格」", () => {
    const { user } = buildPrompt(makePacket(), [], noAllowed);
    expect(user).toContain("不得输出技术动作「合格」");
    expect(user).toContain("否（必须使用 observation_only，不得判断达标）");
  });

  it("有已审核参考时提示词不再写禁止句", () => {
    const allowed: AllowedOutputs = {
      cues: ["保持节奏"],
      drillIds: ["drill-1"],
      hasReviewedReference: true,
      referenceId: "ref-1",
    };
    const { user } = buildPrompt(makePacket({ referenceId: "ref-1" }), [], allowed);
    expect(user).not.toContain("不得输出技术动作「合格」");
    expect(user).toContain("ref-1");
  });

  it("无允许提示时明确要求 cue 必须为 null", () => {
    const { user } = buildPrompt(makePacket(), [], noAllowed);
    expect(user).toContain("cue 必须为 null");
  });

  it("无允许训练项时明确要求 nextDrillId 必须为 null", () => {
    const { user } = buildPrompt(makePacket(), [], noAllowed);
    expect(user).toContain("nextDrillId 必须为 null");
  });

  it("有允许提示与训练项时逐条列出", () => {
    const allowed: AllowedOutputs = {
      cues: ["回到预备位", "别耸肩"],
      drillIds: ["shadow_forehand_return_ready"],
      hasReviewedReference: false,
      referenceId: null,
    };
    const { user } = buildPrompt(makePacket(), [], allowed);
    expect(user).toContain("回到预备位");
    expect(user).toContain("别耸肩");
    expect(user).toContain("shadow_forehand_return_ready");
  });

  it("知识条目渲染包含审核状态，便于模型自知边界", () => {
    const { user } = buildPrompt(
      makePacket(),
      entryList(makeKnowledgeEntry({ status: "observation_only" })),
      noAllowed,
    );
    expect(user).toContain("审核状态：observation_only");
  });

  it("无知识时给出明确占位", () => {
    const { user } = buildPrompt(makePacket(), [], noAllowed);
    expect(user).toContain("本轮无适用的已审核知识");
  });
});

describe("buildPrompt — 结构与安全性", () => {
  it("返回 system 与 user 两段", () => {
    const p = buildPrompt(makePacket(), [], noAllowed);
    expect(p.system).toBe(SYSTEM_PROMPT);
    expect(typeof p.user).toBe("string");
    expect(p.user.length).toBeGreaterThan(0);
  });

  it("user 段包含输出 schema 提示", () => {
    const { user } = buildPrompt(makePacket(), [], noAllowed);
    expect(user).toContain("evidenceRefs");
    expect(user).toContain("observation_only");
  });

  it("提示词不包含任何密钥痕迹（防止装配错误泄露）", () => {
    const { user, system } = buildPrompt(makePacket(), [], noAllowed);
    const combined = `${system}\n${user}`;
    expect(combined).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(combined.toLowerCase()).not.toContain("authorization");
    expect(combined.toLowerCase()).not.toContain("bearer ");
  });

  it("限制列表会原样带进提示词，让模型知道边界", () => {
    const packet = makePacket({ limitations: ["仅正面机位", "无参考片段"] });
    const { user } = buildPrompt(packet, [], noAllowed);
    expect(user).toContain("仅正面机位");
    expect(user).toContain("无参考片段");
  });

  it("OUTPUT_SCHEMA_HINT 要求只返回 JSON、不要 Markdown 代码块", () => {
    expect(OUTPUT_SCHEMA_HINT).toContain("只返回如下 JSON");
    expect(OUTPUT_SCHEMA_HINT).toContain("不要包含任何解释文字或 Markdown 代码块");
  });
});
