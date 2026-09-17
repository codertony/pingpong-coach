/**
 * 交给 MediaPipe 的时间戳必须**严格递增**（F-011）。
 *
 * 这条修好之前**一个测试都没有** —— 而它的坏法是**静默**的：
 * 喂进一个不增的时间戳，`detectForVideo` 报一次 `Packet timestamp mismatch`，
 * 之后**每一帧都继续失败**，界面只是不再更新骨架。用户看到的就是
 * "视频里明明有挥拍，却一直等待有效挥拍"。
 *
 * 所以这里的重点不是"正常情况能用"，而是**回绕、seek、重复帧**这三种不增的形态。
 */

import { describe, expect, it } from "vitest";
import { createMonotonicTimestamp } from "../src/vision/monotonic-timestamp.js";

describe("createMonotonicTimestamp", () => {
  it("正常递增的媒体时间原样通过（不引入多余的偏移）", () => {
    const clock = createMonotonicTimestamp();
    expect(clock.next(0)).toBe(0);
    expect(clock.next(33)).toBe(33);
    expect(clock.next(66)).toBe(66);
  });

  it("**循环回绕**（结尾跳回 0）之后仍然严格递增", () => {
    const clock = createMonotonicTimestamp();
    clock.next(8000);
    // 循环播放：媒体时间跳回开头
    expect(clock.next(0)).toBe(8001);
    expect(clock.next(33)).toBe(8002);
  });

  it("**seek 重播**（跳到更早的时刻）同样被抬起来", () => {
    const clock = createMonotonicTimestamp();
    clock.next(5000);
    clock.next(5200);
    expect(clock.next(1000)).toBe(5201);
  });

  it("**重复帧**（时间戳相等）也要抬 1ms —— 相等同样算「不增」，一样会踩报错", () => {
    const clock = createMonotonicTimestamp();
    clock.next(1000);
    expect(clock.next(1000)).toBe(1001);
    expect(clock.next(1000)).toBe(1002);
  });

  it("负数与非法值一律当成 0（MediaPipe 不接受负时间戳），且仍严格递增", () => {
    const clock = createMonotonicTimestamp();
    expect(clock.next(-5)).toBe(0);
    // 连续来两个非法值也要递增：第二个不是 0 而是 1
    // （相等就违反"严格递增"，一样会让整条推理死掉）
    expect(clock.next(Number.NaN)).toBe(1);
    expect(clock.next(Number.POSITIVE_INFINITY)).toBe(2);
  });

  it("`reset()` 之后可以从小时间戳重新开始（重新加载模型时用）", () => {
    const clock = createMonotonicTimestamp();
    clock.next(9000);
    clock.reset();
    expect(clock.next(0)).toBe(0);
    expect(clock.next(33)).toBe(33);
  });

  it("**任意输入序列下输出都严格递增**（把三种坏形态混在一起喂）", () => {
    // 固定序列，不用随机：失败了要能一模一样地复现
    const inputs = [0, 33, 66, 99, 0, 33, 5000, 1000, 1000, 1001, 0, 20_000, 5];
    const clock = createMonotonicTimestamp();
    const out = inputs.map((t) => clock.next(t));
    for (let i = 1; i < out.length; i++) {
      expect(
        out[i]!,
        `第 ${i} 个输出 ${out[i]} 不大于前一个 ${out[i - 1]}（输入 ${inputs[i]}）`,
      ).toBeGreaterThan(out[i - 1]!);
    }
  });
});
