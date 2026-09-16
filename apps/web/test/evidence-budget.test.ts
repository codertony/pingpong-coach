/**
 * 请求体积预算的裁剪逻辑（F-031）。
 *
 * 契约写着请求超限要"先减少冗余图片并记录降采样"，而在此之前代码里没有这回事：
 * 服务端直接 413，用户什么都拿不到。这个文件守的是**做出来的那版**：
 * 从最不关键的一张开始丢、至少留一张、丢过就如实记一笔。
 */

import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_BYTES_BUDGET,
  describeKeyframeTrim,
  trimKeyframesToBudget,
  utf8ByteLength,
} from "../src/evidence/evidence-budget.js";

/** 造一批"关键帧"，体积按给定的字节数计。 */
const kfs = (...sizes: number[]) => sizes.map((n) => ({ bytes: n }));

describe("utf8ByteLength", () => {
  it("按 UTF-8 计字节，**不是**按字符数（中文一字三字节）", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    // 服务端用 Buffer.byteLength(json, "utf8") 量，口径必须一致，
    // 否则客户端算"压过了"、服务端仍然 413
    expect(utf8ByteLength("中")).toBe(3);
    expect(utf8ByteLength("中文")).toBe(6);
  });
});

describe("trimKeyframesToBudget", () => {
  const sizeSum = (kept: readonly { bytes: number }[]) => kept.reduce((a, k) => a + k.bytes, 0);

  it("放得下就一张不动", () => {
    const r = trimKeyframesToBudget(kfs(100, 100, 100), sizeSum, 1000);
    expect(r.dropped).toBe(0);
    expect(r.kept).toHaveLength(3);
    expect(r.fits).toBe(true);
  });

  it("超预算时**从最后一张开始丢**，直到放得下", () => {
    // 顺序即优先级：末尾最不关键（selectRepresentativeFrames 按
    // 引拍→向前→还原→准备 返回）。合计 260 > 200，丢掉末尾那张 80 之后 180 就放得下了。
    const r = trimKeyframesToBudget(kfs(50, 60, 70, 80), sizeSum, 200);
    expect(r.fits).toBe(true);
    expect(r.kept).toEqual([{ bytes: 50 }, { bytes: 60 }, { bytes: 70 }]);
    expect(r.dropped).toBe(1);
    expect(r.bytes).toBe(180);
  });

  it("丢一张还不够就继续丢，且**始终从末尾**拿", () => {
    // 100+90+80 = 270 > 150 → 丢 80 → 190 仍超 → 丢 90 → 100 放得下
    const r = trimKeyframesToBudget(kfs(100, 90, 80), sizeSum, 150);
    expect(r.kept).toEqual([{ bytes: 100 }]);
    expect(r.dropped).toBe(2);
    expect(r.fits).toBe(true);
  });

  it("**至少留一张**：一张都不给等于没有图片证据，不如让服务端明确 413", () => {
    const r = trimKeyframesToBudget(kfs(10, 10, 10), () => 999999, 1000);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toBe(2);
    // 只剩一张仍超预算 → 如实说"没压下去"，不假装成功
    expect(r.fits).toBe(false);
  });

  it("本来就没有关键帧时不崩，也不声称成功", () => {
    const r = trimKeyframesToBudget([], () => 5, 1000);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toBe(0);
    expect(r.fits).toBe(true); // 空包没有图片，体积就是 5 < 1000
  });

  it("刚好在预算上算放得下（边界不抖）", () => {
    const r = trimKeyframesToBudget(kfs(100, 100), sizeSum, 200);
    expect(r.dropped).toBe(0);
    expect(r.fits).toBe(true);
  });

  it("默认预算与服务端默认一致（2 MiB）", () => {
    expect(MAX_REQUEST_BYTES_BUDGET).toBe(2 * 1024 * 1024);
  });
});

describe("describeKeyframeTrim", () => {
  it("说明里必须带丢弃张数，并要求涉及画面的结论保守", () => {
    const s = describeKeyframeTrim(3, 1.5 * 1024 * 1024);
    expect(s).toContain("3 张");
    expect(s).toContain("1.50 MiB");
    // 这一句是给模型看的行为约束，不能省 —— 图少了，结论就该更保守
    expect(s).toMatch(/保守|少/);
  });
});
