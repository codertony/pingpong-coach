/**
 * 手部左右分配测试。
 *
 * 为什么值得单独测：手部点分错左右，下游会拿**另一只手**算指关节角度，
 * 结果是"数字看着正常但完全不对"。这类错误不会让任何东西崩溃，
 * 只会让建议变得莫名其妙，而且极难在真机上定位。
 *
 * 所以这里钉住三件事：
 * 1. 按姿态腕部锚点就近分配，不依赖 MediaPipe 的 handedness 标签；
 * 2. 两只手不会都被判给同一侧；
 * 3. 超出容差的手**不分配**（宁可不给，也不给错的），且丢弃原因可查。
 */

import { describe, expect, it } from "vitest";
import { assignHandsToSides } from "../src/hand-assignment.js";

interface P {
  x: number;
  y: number;
}

/** 造一只手的 21 个点，腕点放在 (x, y)，其余点依次错开以免重合。 */
function hand(x: number, y: number): P[] {
  return Array.from({ length: 21 }, (_, i) => ({ x: x + i * 0.1, y: y + i * 0.1 }));
}

const TOL = 100;

describe("assignHandsToSides", () => {
  it("按姿态腕部就近分配：靠近 left_wrist 的手判为左手", () => {
    const { assigned } = assignHandsToSides(
      [hand(300, 200)],
      { left: { x: 310, y: 205 }, right: { x: 900, y: 205 } },
      TOL,
    );
    expect(assigned.left).toHaveLength(21);
    expect(assigned.right).toBeUndefined();
  });

  it("两只手各自归位，不会都被判给同一侧", () => {
    const { assigned, rejected } = assignHandsToSides(
      [hand(300, 200), hand(900, 200)],
      { left: { x: 305, y: 205 }, right: { x: 895, y: 205 } },
      TOL,
    );
    expect(assigned.left).toHaveLength(21);
    expect(assigned.right).toHaveLength(21);
    expect(rejected).toHaveLength(0);
    // 两侧拿到的是各自那只手，不是同一只
    expect(assigned.left![0]!.x).toBeCloseTo(300, 5);
    expect(assigned.right![0]!.x).toBeCloseTo(900, 5);
  });

  it("两只手都更靠近同一侧时，最近的那只胜出，另一只被拒（不覆盖）", () => {
    const { assigned, rejected } = assignHandsToSides(
      [hand(300, 200), hand(340, 200)],
      { left: { x: 300, y: 200 }, right: null },
      TOL,
    );
    expect(assigned.left![0]!.x).toBeCloseTo(300, 5);
    expect(assigned.right).toBeUndefined();
    // 第二只手必须有明确的丢弃记录，否则"手没显示"会变成查不出的问题
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.nearestSide).toBe("left");
  });

  it("超出容差的手不分配 —— 宁可不给，也不给错的", () => {
    const { assigned } = assignHandsToSides(
      [hand(300, 200)],
      { left: { x: 300, y: 200 }, right: null },
      50,
    );
    // 腕点距离 0，在容差内 → 应分配；再用一个远离的验证拒绝
    expect(assigned.left).toHaveLength(21);

    const far = assignHandsToSides([hand(300, 200)], { left: { x: 900, y: 900 }, right: null }, 50);
    expect(far.assigned.left).toBeUndefined();
    expect(far.rejected).toHaveLength(1);
    expect(far.rejected[0]!.distancePx).toBeGreaterThan(50);
  });

  it("锚点缺失（姿态没测到该侧腕）时不硬分配", () => {
    const { assigned, rejected } = assignHandsToSides(
      [hand(300, 200)],
      { left: null, right: null },
      TOL,
    );
    expect(assigned.left).toBeUndefined();
    expect(assigned.right).toBeUndefined();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.nearestSide).toBeNull();
  });

  it("空输入返回空结果，不抛异常", () => {
    const { assigned, rejected } = assignHandsToSides([], { left: null, right: null }, TOL);
    expect(assigned).toEqual({});
    expect(rejected).toEqual([]);
  });

  it("没有腕点的畸形手被忽略，不让 undefined 参与距离计算", () => {
    const { assigned, rejected } = assignHandsToSides(
      [[], hand(300, 200)],
      { left: { x: 300, y: 200 }, right: null },
      TOL,
    );
    expect(assigned.left).toHaveLength(21);
    // 空的畸形手不进入 rejected（它连距离都算不出来），但绝不能占用 left
    expect(rejected).toHaveLength(0);
  });

  it("返回的是副本，调用方改动不会污染输入", () => {
    const input = hand(300, 200);
    const { assigned } = assignHandsToSides(
      [input],
      { left: { x: 300, y: 200 }, right: null },
      TOL,
    );
    assigned.left![0]!.x = -9999;
    expect(input[0]!.x).toBe(300);
  });
});
