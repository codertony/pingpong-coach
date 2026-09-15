/**
 * 准备区标定测试。
 *
 * 这组测试守的是一个**真实踩过的坑**：准备区中心写死在画面坐标上，
 * 而用户手停的位置不在那里，于是分段状态机一次都不触发，
 * 界面却只显示"等待有效挥拍"，没有任何报错。
 *
 * 第一版估计器是「取落点最密集的格子」，在**真实连续对练视频**上选错了：
 * 180 帧里最密集的格子只占 8%，手腕几乎不停顿，于是选中的是引拍最高点。
 * 现在的估计器改用局部速度加权 —— 挥拍时腕部快、准备与还原时慢，
 * 只保留最慢的一半样本再取中位数。真机对照实验里它 20 秒识别出 7 次
 * 有效挥拍，而落点法只有 1 次。
 *
 * 对照口径的注意：那次实验里"腕部中位数"作对照时 +0，但它是在速度加权
 * 已经跑出 8 次之后才接手的，起点被预热，所以这个 +0 有系统偏差，
 * 不能当作"中位数法无效"的证据。
 *
 * 关键断言：
 * 1. 慢速段的位置决定结果，快速扫过的轨迹不参与（这是与旧版的本质区别）；
 * 2. 视频循环回绕造成的假跳变不被当成真实高速（要排除，否则慢速段会被丢光）；
 * 3. 样本不足时返回 null，不允许拿默认值顶替。
 */

import { describe, expect, it } from "vitest";
import {
  DWELL_MIN_SAMPLES,
  estimateReadyZoneFromDwell,
  type WristSample,
} from "../src/readiness.js";

interface Sample {
  p: WristSample;
  t: number;
}

/** 在一点附近造 count 个带抖动的样本（模拟"停在准备姿势"）。 */
function dwellAt(x: number, y: number, count: number, startT: number, dtMs = 33): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < count; i++) {
    // 确定性抖动：不用随机数，保证失败可复现
    const dx = ((i % 5) - 2) * 2;
    const dy = ((i % 3) - 1) * 2;
    out.push({ p: { x: x + dx, y: y + dy }, t: startT + i * dtMs });
  }
  return out;
}

/** 沿直线匀速扫过（模拟挥拍），每帧位移 stepPx。 */
function sweep(
  from: WristSample,
  to: WristSample,
  count: number,
  startT: number,
  dtMs = 33,
): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 0 : i / (count - 1);
    out.push({
      p: { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f },
      t: startT + i * dtMs,
    });
  }
  return out;
}

function split(samples: Sample[]): [WristSample[], number[]] {
  return [samples.map((s) => s.p), samples.map((s) => s.t)];
}

describe("estimateReadyZoneFromDwell（速度加权）", () => {
  it("样本不足时返回 null，不用默认值顶替", () => {
    const [p] = split(dwellAt(640, 400, DWELL_MIN_SAMPLES - 1, 0));
    expect(estimateReadyZoneFromDwell(p)).toBeNull();
    expect(estimateReadyZoneFromDwell([])).toBeNull();
  });

  it("快速扫过的轨迹不参与估计，结果由慢速段决定", () => {
    // 慢速停在 (300, 500) 60 帧；随后快速扫到 (900, 200) 60 帧（每帧 ~11px）。
    // 落点法会偏向轨迹中段，速度加权必须仍钉在 (300, 500)。
    const slow = dwellAt(300, 500, 60, 0);
    const fast = sweep({ x: 300, y: 500 }, { x: 900, y: 200 }, 60, 2000);
    const [p, t] = split([...slow, ...fast]);

    const center = estimateReadyZoneFromDwell(p, t);
    expect(center).not.toBeNull();
    expect(Math.abs(center!.x - 300)).toBeLessThan(15);
    expect(Math.abs(center!.y - 500)).toBeLessThan(15);
  });

  it("准备姿势与画面中心差很远时，结果跟着准备姿势走", () => {
    const [p, t] = split(dwellAt(300, 520, 60, 0));
    const center = estimateReadyZoneFromDwell(p, t);
    expect(center).not.toBeNull();
    expect(Math.abs(center!.x - 300)).toBeLessThan(15);
    expect(Math.abs(center!.y - 520)).toBeLessThan(15);
  });

  it("时间戳显示是视频循环回绕（大跳变）时，不被当成高速而丢掉慢速段", () => {
    // 同一段准备姿势样本，时间戳从 8000ms 跳回 0（循环回绕）。
    // 若把这次跳变当成真实位移，慢速段会被判成高速而剔除，结果就会跑偏。
    const a = dwellAt(400, 400, 30, 7500);
    const b = dwellAt(400, 400, 30, 0);
    const [p, t] = split([...a, ...b]);

    const center = estimateReadyZoneFromDwell(p, t);
    expect(center).not.toBeNull();
    expect(Math.abs(center!.x - 400)).toBeLessThan(15);
    expect(Math.abs(center!.y - 400)).toBeLessThan(15);
  });

  it("忽略非有限坐标，不让 NaN 污染估计", () => {
    const [p, t] = split(dwellAt(500, 300, 40, 0));
    const withBad = [...p, { x: Number.NaN, y: 300 }, { x: 500, y: Number.POSITIVE_INFINITY }];
    const center = estimateReadyZoneFromDwell(withBad, t);
    expect(center).not.toBeNull();
    expect(Number.isFinite(center!.x)).toBe(true);
    expect(Number.isFinite(center!.y)).toBe(true);
  });

  it("全部是非有限坐标时返回 null，而不是造出一个中心", () => {
    const bad: WristSample[] = Array.from({ length: 40 }, () => ({ x: Number.NaN, y: Number.NaN }));
    expect(estimateReadyZoneFromDwell(bad)).toBeNull();
  });

  it("不给时间戳也能工作（退化到按相邻索引算速度）", () => {
    const [p] = split([...dwellAt(350, 450, 60, 0)]);
    const center = estimateReadyZoneFromDwell(p);
    expect(center).not.toBeNull();
    expect(Math.abs(center!.x - 350)).toBeLessThan(15);
  });
});
