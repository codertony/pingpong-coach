/**
 * 关键帧可解码性守卫的测试（F-042）。
 *
 * 判据是**结构**（SOI / EOI / SOF 且宽高非零），**不是尺寸阈值** ——
 * 实测（DeepSeek）：1×1 的图是合法的、灰度单分量也是合法的，
 * 被拒的是"根本不是图片"的负载。拿自己编的尺寸下限去卡会误杀合法小图。
 */

import { describe, expect, it } from "vitest";
import { isDecodableJpeg, splitDecodableKeyframes } from "../src/coach/keyframe-guard.js";

/** fixtures 里那张真实的 1×1 灰度 JPEG —— 实测提供商**接受**它。 */
const REAL_1PX =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

/** 造一个只含 SOI + SOF0(指定宽高) + EOI 的最小 JPEG。 */
function minimalJpeg(width: number, height: number): string {
  const b = Buffer.alloc(2 + 2 + 11 + 2);
  let i = 0;
  b[i++] = 0xff;
  b[i++] = 0xd8; // SOI
  b[i++] = 0xff;
  b[i++] = 0xc0; // SOF0
  b[i++] = 0x00;
  b[i++] = 0x0b; // 段长 11（1 个分量）
  b[i++] = 0x08; // 精度
  b[i++] = (height >> 8) & 0xff;
  b[i++] = height & 0xff;
  b[i++] = (width >> 8) & 0xff;
  b[i++] = width & 0xff;
  b[i++] = 0x01; // 分量数
  b[i++] = 0x01; // 分量 id
  b[i++] = 0x11; // 采样
  b[i++] = 0x00; // 量化表
  b[i++] = 0xff;
  b[i++] = 0xd9; // EOI
  return b.toString("base64");
}

describe("isDecodableJpeg", () => {
  it("接受 fixtures 里那张真实的 1×1 灰度 JPEG（实测提供商也接受它）", () => {
    expect(isDecodableJpeg(REAL_1PX)).toBe(true);
  });

  it("接受最小的合法 JPEG（含非零宽高）", () => {
    expect(isDecodableJpeg(minimalJpeg(1, 1))).toBe(true);
    expect(isDecodableJpeg(minimalJpeg(1920, 1080))).toBe(true);
  });

  it("**拒绝随机字节** —— 这正是把整次分析打挂的那种负载", () => {
    const garbage = Buffer.alloc(600 * 1024, 0xab).toString("base64");
    expect(isDecodableJpeg(garbage)).toBe(false);
  });

  it("拒绝空串 / 非 base64 / 太短的串", () => {
    expect(isDecodableJpeg("")).toBe(false);
    expect(isDecodableJpeg("这不是 base64")).toBe(false);
    expect(isDecodableJpeg("AAAA")).toBe(false);
  });

  it("拒绝**被截断**的 JPEG（有 SOI 没有 EOI）", () => {
    const full = Buffer.from(minimalJpeg(8, 8), "base64");
    const cut = full.subarray(0, full.length - 4).toString("base64");
    expect(isDecodableJpeg(cut)).toBe(false);
  });

  it("拒绝有 SOI/EOI 但**没有 SOF**的（拿不到宽高）", () => {
    const b = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    expect(isDecodableJpeg(b.toString("base64"))).toBe(false);
  });

  it("拒绝宽或高为 0 的（SOF 存在但尺寸非法）", () => {
    expect(isDecodableJpeg(minimalJpeg(0, 8))).toBe(false);
    expect(isDecodableJpeg(minimalJpeg(8, 0))).toBe(false);
  });

  it("拒绝只有 SOI 开头、后面是垃圾的", () => {
    const b = Buffer.alloc(64, 0x11);
    b[0] = 0xff;
    b[1] = 0xd8;
    expect(isDecodableJpeg(b.toString("base64"))).toBe(false);
  });
});

describe("splitDecodableKeyframes", () => {
  it("按顺序保留可用的，并**逐个报出**被丢的 id（不许静默）", () => {
    const garbage = Buffer.alloc(1024, 0xab).toString("base64");
    const result = splitDecodableKeyframes([
      { id: "kf-1", jpegBase64: REAL_1PX },
      { id: "kf-2", jpegBase64: garbage },
      { id: "kf-3", jpegBase64: minimalJpeg(64, 64) },
      { id: "kf-4", jpegBase64: "" },
    ]);

    expect(result.valid.map((k) => k.id)).toEqual(["kf-1", "kf-3"]);
    expect(result.droppedIds).toEqual(["kf-2", "kf-4"]);
  });

  it("全部合法时一个都不丢", () => {
    const r = splitDecodableKeyframes([{ id: "a", jpegBase64: REAL_1PX }]);
    expect(r.droppedIds).toEqual([]);
    expect(r.valid).toHaveLength(1);
  });

  it("空列表不崩", () => {
    expect(splitDecodableKeyframes([])).toEqual({ valid: [], droppedIds: [] });
  });
});
