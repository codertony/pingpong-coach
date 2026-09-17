/**
 * 解码侧读数（评审 §6.3 / 设计 §1.5.1）。
 *
 * 这一列的前提是"**浏览器自己报的**"：丢帧与时间戳回绕都发生在解码层（F-011），
 * 而我们能数的只是"回调被调了几次"—— 那看不到解码器默默丢了多少。
 * 所以这里的重点是**可用性边界**：浏览器不提供时返回 `null`，
 * 让界面如实显示"未知"，而不是显示 0（红线 1：缺失不是零）。
 */

import { describe, expect, it } from "vitest";
import { readVideoDecodeStats } from "../src/capture/video-decode-stats.js";

/** 造一个"能报解码计数"的最小元素替身。 */
const fakeVideo = (quality: unknown) => ({
  getVideoPlaybackQuality: () => quality,
});

describe("readVideoDecodeStats", () => {
  it("读得到时给出解出帧数与解码器丢帧数", () => {
    const stats = readVideoDecodeStats(
      fakeVideo({ totalVideoFrames: 244, droppedVideoFrames: 3, creationTime: 0 }),
    );
    expect(stats).toEqual({ decodedFrames: 244, droppedByDecoder: 3 });
  });

  it("老 Safari 的带前缀版本也认", () => {
    const stats = readVideoDecodeStats({
      webkitGetVideoPlaybackQuality: () => ({ totalVideoFrames: 100, droppedVideoFrames: 0 }),
    });
    expect(stats?.decodedFrames).toBe(100);
  });

  it("**浏览器不提供时为 null**，不是 0（缺失不等于零）", () => {
    expect(readVideoDecodeStats({})).toBeNull();
    expect(readVideoDecodeStats(null)).toBeNull();
    expect(readVideoDecodeStats(undefined)).toBeNull();
  });

  it("调用抛错时返回 null —— 读数失败不等于「没有丢帧」", () => {
    const stats = readVideoDecodeStats({
      getVideoPlaybackQuality: () => {
        throw new Error("元素已卸载");
      },
    });
    expect(stats).toBeNull();
  });

  it("总帧数不是有限数时也算拿不到（不拿 NaN 当数字渲染）", () => {
    expect(readVideoDecodeStats(fakeVideo({ totalVideoFrames: Number.NaN }))).toBeNull();
    expect(readVideoDecodeStats(fakeVideo({}))).toBeNull();
  });

  it("有总帧数但缺丢帧数时，丢帧按 0 报（这一项确实是 0，不是未知）", () => {
    const stats = readVideoDecodeStats(fakeVideo({ totalVideoFrames: 10 }));
    expect(stats).toEqual({ decodedFrames: 10, droppedByDecoder: 0 });
  });
});
