/**
 * 请求体积预算的裁剪逻辑（F-031）。
 *
 * 契约写着请求超限要"先减少冗余图片并记录降采样"，而在此之前代码里没有这回事：
 * 服务端直接 413，用户什么都拿不到。这个文件守的是**做出来的那版**：
 * 按**角色优先级**从最不关键的一张开始丢、至少留一张、丢过就如实记一笔。
 *
 * ⚠️ 曾经是"从数组末尾丢"，理由是选帧器按 引拍→向前→还原→准备 返回、
 * 末尾最不关键。选帧器改成**时间序**（R4）之后那个理由不成立了 ——
 * 末尾变成最后一板的闭合帧，从末尾丢恰恰会先丢后段证据。所以改成按角色丢，
 * 与返回顺序解耦。
 */

import { describe, expect, it } from "vitest";
import type { EvidenceKeyframe } from "@pingpong/contracts";
import {
  MAX_REQUEST_BYTES_BUDGET,
  describeKeyframeTrim,
  keyframeDropRank,
  trimKeyframesToBudget,
  utf8ByteLength,
} from "../src/evidence/evidence-budget.js";

/** 造一批"关键帧"，体积按给定的字节数计。 */
const kfs = (...items: Array<[size: number, role: EvidenceKeyframe["role"], offset?: number]>) =>
  items.map(([bytes, role, offset]) => ({
    bytes,
    role,
    eventTimeOffsetMs: offset ?? 0,
  }));
const sizeSum = (kept: readonly { bytes: number }[]) => kept.reduce((a, k) => a + k.bytes, 0);

describe("utf8ByteLength", () => {
  it("按 UTF-8 计字节，**不是**按字符数（中文一字三字节）", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    // 服务端用 Buffer.byteLength(json, "utf8") 量，口径必须一致，
    // 否则客户端算"压过了"、服务端仍然 413
    expect(utf8ByteLength("中")).toBe(3);
    expect(utf8ByteLength("中文")).toBe(6);
  });
});

describe("keyframeDropRank", () => {
  it("次序是 闭合帧 < 还原 < 引拍 < 峰值帧 < 恰在转变时刻的挥拍帧", () => {
    const rank = (role: EvidenceKeyframe["role"], offset = 0) =>
      keyframeDropRank({ role, eventTimeOffsetMs: offset });
    // 闭合帧是「回到准备位并稳住」那一帧，与下一板起始帧近乎重复 → 先丢
    expect(rank("ready")).toBeLessThan(rank("return"));
    expect(rank("return")).toBeLessThan(rank("backswing"));
    expect(rank("backswing")).toBeLessThan(rank("forward", 120));
    // 恰在 forward_start 的那一张是**可核对的转变时刻**，最后才丢
    expect(rank("forward", 120)).toBeLessThan(rank("forward", 0));
  });
});

describe("trimKeyframesToBudget", () => {
  it("放得下就一张不动", () => {
    const r = trimKeyframesToBudget(
      kfs([100, "backswing"], [100, "forward"], [100, "return"]),
      sizeSum,
      keyframeDropRank,
      1000,
    );
    expect(r.dropped).toBe(0);
    expect(r.kept).toHaveLength(3);
    expect(r.fits).toBe(true);
  });

  it("超预算时先丢**闭合帧**，而不是从末尾丢", () => {
    /*
     * ⚠️ 必须用**两板**才试得出这条。
     *
     * 第一版只放了一板的四张（引拍→挥拍→还原→闭合），而闭合帧既是最低优先级、
     * 又恰好在末尾 —— 于是「按角色丢」与「从末尾丢」给出**同一个结果**，
     * 把实现改回从末尾丢，这条用例照样通过（我实测过：改回去 148 项全绿）。
     * 一个通过条件不需要被验行为也能满足的用例，等于没有。
     *
     * 两板时两条路径就分开了：按角色丢丢掉的是**低优先级的闭合帧与还原帧**，
     * 从末尾丢只是把第二板末尾那两张削掉。
     */
    const r = trimKeyframesToBudget(
      // 第一板：引拍 / 挥拍 / 还原 / 闭合；第二板：引拍 / 挥拍
      kfs(
        [100, "backswing"],
        [100, "forward"],
        [100, "return"],
        [100, "ready"],
        [100, "backswing"],
        [100, "forward"],
      ),
      sizeSum,
      keyframeDropRank,
      400,
    );
    expect(r.dropped).toBe(2);
    expect(r.bytes).toBe(400);
    // 先丢闭合帧，再丢还原帧（这一批里只有这两张是低优先级的）
    expect(r.kept.map((k) => k.role)).toEqual(["backswing", "forward", "backswing", "forward"]);
    // 从末尾丢会得到 [引拍, 挥拍, 还原, 闭合] —— 把第二板的两次挥拍整个丢掉、
    // 却留着第一板的还原与闭合帧，正是这条要挡的
    expect(r.kept.map((k) => k.role)).not.toEqual(["backswing", "forward", "return", "ready"]);
  });

  it("丢一张还不够就继续按角色丢（不是按位置）", () => {
    // 两板共 600 > 300 → 丢 3 张。
    // 按角色：闭合(0) → 还原(1) → 同 rank 里**更靠后**的引拍(2) ⇒ 留下 引拍/挥拍/挥拍
    // 从末尾：挥拍/引拍/闭合 ⇒ 留下 引拍/挥拍/还原（把第二板整个丢掉）
    const r = trimKeyframesToBudget(
      kfs(
        [100, "backswing"],
        [100, "forward"],
        [100, "return"],
        [100, "ready"],
        [100, "backswing"],
        [100, "forward"],
      ),
      sizeSum,
      keyframeDropRank,
      300,
    );
    expect(r.dropped).toBe(3);
    expect(r.kept.map((k) => k.role)).toEqual(["backswing", "forward", "forward"]);
    expect(r.kept.map((k) => k.role)).not.toEqual(["backswing", "forward", "return"]);
  });

  it("同一优先级里**后出现的先丢**（时间序下即后段的先舍）", () => {
    const r = trimKeyframesToBudget(
      kfs([100, "backswing"], [100, "backswing"], [50, "backswing"]),
      sizeSum,
      keyframeDropRank,
      150,
    );
    // 三张同级：先丢最后一张（50）→ 200 仍超；再丢现在最后一张（100）→ 100 放下
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toBe(2);
    expect(r.bytes).toBe(100);
  });

  it("**至少留一张**：一张都不给等于没有图片证据，不如让服务端明确 413", () => {
    const r = trimKeyframesToBudget(
      kfs([10, "backswing"], [10, "forward"], [10, "ready"]),
      () => 999999,
      keyframeDropRank,
      1000,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toBe(2);
    // 只剩一张仍超预算 → 如实说"没压下去"，不假装成功
    expect(r.fits).toBe(false);
  });

  it("本来就没有关键帧时不崩，也不声称成功", () => {
    const r = trimKeyframesToBudget([], () => 5, keyframeDropRank, 1000);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toBe(0);
    expect(r.fits).toBe(true); // 空包没有图片，体积就是 5 < 1000
  });

  it("刚好在预算上算放得下（边界不抖）", () => {
    const r = trimKeyframesToBudget(
      kfs([100, "forward"], [100, "return"]),
      sizeSum,
      keyframeDropRank,
      200,
    );
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
