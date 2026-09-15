import { describe, expect, it } from "vitest";
import type { EvidencePacket } from "@pingpong/contracts";
import { SCHEMA_VERSION } from "@pingpong/contracts";
import {
  scanForbiddenClaims,
  validateModelOutput,
  type ModelOutput,
} from "../src/coach/validate.js";
import type { AllowedOutputs } from "../src/coach/knowledge.js";

const PACKET: EvidencePacket = {
  schemaVersion: SCHEMA_VERSION,
  requestId: "req_1",
  sessionId: "sess_1",
  groupId: "grp_1",
  focusId: "return_to_ready_zone",
  strokeType: "forehand_drive",
  handedness: "right",
  cameraView: "front",
  strokes: [
    {
      strokeId: "st_1",
      startMs: 0,
      endMs: 900,
      anchor: { type: "wrist_speed_peak", timeMs: 400 },
      impactTimeMs: null,
      complete: true,
      evidenceFrameIds: ["f_1"],
      reasons: [],
    },
  ],
  features: [
    {
      id: "return_after_wrist_peak_ms",
      value: 420,
      unit: "ms",
      coordinateSpace: "image_2d",
      intervalMs: [400, 820],
      quality: "usable",
      reasonIfMissing: null,
    },
  ],
  keyframes: [
    {
      id: "kf_1",
      sourceTimeMs: 400,
      jpegBase64: "AAAA",
      frameId: "f_1",
      width: 960,
      height: 540,
      role: "forward",
    },
  ],
  ruleVersion: "1.0.0",
  referenceId: null,
  limitations: ["单目二维"],
  readyZone: { xPx: 640, yPx: 400, radiusPx: 80 },
};

const EXPECTED = {
  sessionId: "sess_1",
  groupId: "grp_1",
  focusId: "return_to_ready_zone",
  requestId: "req_1",
};

const ALLOWED_REVIEWED: AllowedOutputs = {
  cues: ["击球后先把重心带回准备位置，然后再看下一拍。"],
  drillIds: ["shadow_forehand_return_ready"],
  hasReviewedReference: true,
  referenceId: "ref_1",
};

const ALLOWED_UNREVIEWED: AllowedOutputs = {
  ...ALLOWED_REVIEWED,
  hasReviewedReference: false,
  referenceId: null,
};

function output(overrides: Partial<ModelOutput> = {}): ModelOutput {
  return {
    status: "suggest_adjustment",
    observation: "三次挥拍后回到准备区的中位时间偏长。",
    evidenceRefs: ["return_after_wrist_peak_ms"],
    cue: "击球后先把重心带回准备位置，然后再看下一拍。",
    nextDrillId: null,
    limitations: [],
    ...overrides,
  };
}

describe("scanForbiddenClaims", () => {
  it("识别肌肉发力类结论", () => {
    expect(scanForbiddenClaims("你的大臂肌肉紧张导致发力不足")).toContain("肌肉发力或紧张");
  });

  it("识别足底承重类结论", () => {
    expect(scanForbiddenClaims("足底承重偏向后脚")).toContain("足底承重");
  });

  it("识别力量传递效率类结论", () => {
    expect(scanForbiddenClaims("力量传递效率偏低")).toContain("力量传递效率");
  });

  it("识别精确拍面与毫秒级传力顺序类结论", () => {
    expect(scanForbiddenClaims("确定拍面角度为 30 度")).toContain("精确拍面姿态");
    expect(scanForbiddenClaims("毫秒级的传力顺序被打乱")).toContain("毫秒级传力顺序");
  });

  it("正常的动作观察不会被误判", () => {
    expect(scanForbiddenClaims("肘角变化范围偏小，回到准备区稍慢")).toEqual([]);
  });
});

describe("validateModelOutput — 硬性拒绝", () => {
  it("伪造证据引用被拒绝播报", () => {
    const r = validateModelOutput(
      output({ evidenceRefs: ["not_a_real_id"] }),
      PACKET,
      ALLOWED_REVIEWED,
      EXPECTED,
    );
    expect(r.feedback).toBeNull();
    expect(r.issues.some((i) => i.code === "evidence_ref_unknown")).toBe(true);
  });

  it("输出结论但完全不引用证据也被拒绝", () => {
    const r = validateModelOutput(
      output({ evidenceRefs: [] }),
      PACKET,
      ALLOWED_REVIEWED,
      EXPECTED,
    );
    expect(r.feedback).toBeNull();
    expect(r.issues.some((i) => i.code === "evidence_ref_unknown")).toBe(true);
  });

  it("结构不合法（缺字段）被拒绝", () => {
    const r = validateModelOutput({ status: "target_met" }, PACKET, ALLOWED_REVIEWED, EXPECTED);
    expect(r.feedback).toBeNull();
    expect(r.issues[0]?.code).toBe("model_invalid_json");
  });

  it("未知 status 被拒绝", () => {
    const r = validateModelOutput(
      { ...output(), status: "perfect" },
      PACKET,
      ALLOWED_REVIEWED,
      EXPECTED,
    );
    expect(r.feedback).toBeNull();
    expect(r.issues[0]?.code).toBe("model_invalid_json");
  });

  it("不允许的训练项被拒绝", () => {
    const r = validateModelOutput(
      output({ nextDrillId: "some_random_drill" }),
      PACKET,
      ALLOWED_REVIEWED,
      EXPECTED,
    );
    expect(r.feedback).toBeNull();
    expect(r.issues.some((i) => i.code === "disallowed_drill")).toBe(true);
  });

  it("陈旧会话响应被拒绝", () => {
    const stalePacket = { ...PACKET, sessionId: "sess_old" };
    const r = validateModelOutput(output(), stalePacket, ALLOWED_REVIEWED, EXPECTED);
    expect(r.feedback).toBeNull();
    expect(r.issues.some((i) => i.code === "stale_session_response")).toBe(true);
  });

  it("分组或关注点不匹配也被拒绝", () => {
    const r1 = validateModelOutput(
      output(),
      { ...PACKET, groupId: "grp_other" },
      ALLOWED_REVIEWED,
      EXPECTED,
    );
    expect(r1.feedback).toBeNull();

    const r2 = validateModelOutput(
      output(),
      { ...PACKET, focusId: "elbow_extension_pattern" },
      ALLOWED_REVIEWED,
      EXPECTED,
    );
    expect(r2.feedback).toBeNull();
  });
});

describe("validateModelOutput — 软性降级", () => {
  it("含发力类结论时降级为 observation_only", () => {
    const r = validateModelOutput(
      output({ observation: "你的大臂肌肉紧张，所以发力不够。" }),
      PACKET,
      ALLOWED_REVIEWED,
      EXPECTED,
    );
    expect(r.feedback).not.toBeNull();
    expect(r.feedback!.status).toBe("observation_only");
    expect(r.rejectedClaims.length).toBeGreaterThan(0);
  });

  it("无已审核参考时，达标结论被降级", () => {
    const r = validateModelOutput(
      output({ status: "target_met" }),
      PACKET,
      ALLOWED_UNREVIEWED,
      EXPECTED,
    );
    expect(r.feedback!.status).toBe("observation_only");
    expect(r.issues.some((i) => i.code === "reference_not_reviewed")).toBe(true);
  });

  it("不在允许集合中的提示被移除", () => {
    const r = validateModelOutput(
      output({ cue: "自己编的一条提示" }),
      PACKET,
      ALLOWED_REVIEWED,
      EXPECTED,
    );
    expect(r.feedback!.cue).toBeNull();
  });

  it("超过 30 字的提示被移除（语音播报限制）", () => {
    const longCue = "这是一条远远超过三十个汉字上限的很长的提示语句用来验证截断逻辑是否正确处理";
    const allowed = { ...ALLOWED_REVIEWED, cues: [longCue] };
    const r = validateModelOutput(output({ cue: longCue }), PACKET, allowed, EXPECTED);
    expect(r.feedback!.cue).toBeNull();
  });

  it("合法输出原样通过并保留证据引用", () => {
    const r = validateModelOutput(output(), PACKET, ALLOWED_REVIEWED, EXPECTED);
    expect(r.feedback).not.toBeNull();
    expect(r.feedback!.status).toBe("suggest_adjustment");
    expect(r.feedback!.evidenceRefs).toContain("return_after_wrist_peak_ms");
    expect(r.feedback!.cue).toBe("击球后先把重心带回准备位置，然后再看下一拍。");
    expect(r.issues).toEqual([]);
  });

  it("关键帧 ID 也可作为证据引用", () => {
    const r = validateModelOutput(
      output({ evidenceRefs: ["kf_1"] }),
      PACKET,
      ALLOWED_REVIEWED,
      EXPECTED,
    );
    expect(r.feedback).not.toBeNull();
  });

  it("挥拍 ID 也可作为证据引用", () => {
    const r = validateModelOutput(
      output({ evidenceRefs: ["st_1"] }),
      PACKET,
      ALLOWED_REVIEWED,
      EXPECTED,
    );
    expect(r.feedback).not.toBeNull();
  });

  it("nextDrillId 为 null 时总是允许", () => {
    const r = validateModelOutput(
      output({ nextDrillId: null }),
      PACKET,
      ALLOWED_REVIEWED,
      EXPECTED,
    );
    expect(r.feedback).not.toBeNull();
    expect(r.feedback!.nextDrillId).toBeNull();
  });

  it("insufficient_evidence 在无审核参考时不会被误降级", () => {
    const r = validateModelOutput(
      output({ status: "insufficient_evidence", evidenceRefs: [] }),
      PACKET,
      ALLOWED_UNREVIEWED,
      EXPECTED,
    );
    expect(r.feedback!.status).toBe("insufficient_evidence");
  });
});
