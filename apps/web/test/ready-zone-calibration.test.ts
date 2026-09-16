/**
 * 自动标定准备区的**准入条件**。
 *
 * ## 为什么单独守这一条
 *
 * 准备区是整条分段状态机的**入口**：腕部要先在区内驻留，才谈得上引拍、前挥。
 * 而它是**自动标定**出来的 —— 标到哪里，后面所有阈值就在哪里生效。
 *
 * 实测（真实对拉素材 8.15s）：同一段素材、同一套动作，**只改"从哪一刻开始标定"**，
 * 检出次数在 **0~4 之间跳**：标定落在 (442,339) 时 0 次，落在 (680,212) 时 4 次。
 * 原因就是 `DWELL_MIN_SAMPLES = 20`（≈0.67 秒）一满足就成交 ——
 * 那 20 帧完全可能整段落在一次引拍里。
 *
 * 用户看到的现象就是"导入视频以后什么都没有"，而它看起来像是"识别不行"，
 * 实际是"入口被一个偶然的位置定住了"。
 *
 * 所以这里钉住：**样本够多 + 估计已稳定**，两者缺一不可。
 */

import { describe, expect, it } from "vitest";
import { TrainingSession } from "../src/training/training-session.js";
import { makeConfig, makeFrame, OFFSETS, READY, BODY_SCALE } from "./helpers/synthetic-strokes.js";

/** 喂一轮完整挥拍（含准备区驻留），从 `start` 续上时间。 */
function feedCycle(
  session: TrainingSession,
  start: { frames: number; t: number },
): { frames: number; t: number } {
  let { frames, t } = start;
  for (const offset of OFFSETS) {
    session.pushPoseResult(makeFrame(frames, t, offset));
    t += 40;
    frames++;
  }
  return { frames, t };
}

function makeSession(): TrainingSession {
  return new TrainingSession(makeConfig({ strokesPerGroup: 1_000_000 }), {
    onStatus: () => {},
    onStroke: () => {},
    onFeedback: () => {},
    onGroupComplete: () => {},
  });
}

describe("准备区自动标定：什么时候才允许定下来", () => {
  it("**只攒够估计器的最低样本数（20）时不许定** —— 那 20 帧可能全在一次引拍里", () => {
    const s = makeSession();
    s.setReadyZone({ x: 100, y: 100 });
    // 20 帧全部处在引拍峰值附近（正是"偶然经过"的位置）
    let st = { frames: 0, t: 0 };
    for (let i = 0; i < 20; i++) {
      s.pushPoseResult(makeFrame(st.frames, st.t, 0.45));
      st = { frames: st.frames + 1, t: st.t + 40 };
    }

    const used = s.calibrateReadyZoneFromDwell();

    expect(used, "20 个样本就成交了 —— 入口又被偶然位置定住了").toBe(0);
    expect(s.readyZoneDisplay, "没成交就不该动准备区").toEqual({
      xPx: 100,
      yPx: 100,
      radiusPx: s.readyZoneDisplay?.radiusPx ?? 0,
    });
    s.dispose();
  });

  it("**跨越多次挥拍后**才定，且定在准备姿势附近，而不是引拍峰值", () => {
    const s = makeSession();
    let st = { frames: 0, t: 0 };
    // 连喂 6 轮：每轮里"准备驻留"占 6 帧、引拍峰值占 4 帧 —— 中位数该落在准备位置
    for (let i = 0; i < 6; i++) st = feedCycle(s, st);

    let used = 0;
    // 调用方在真实链路里也是**每帧重试**（见 App.tsx），这里照着来
    for (let i = 0; i < 5 && used === 0; i++) {
      used = s.calibrateReadyZoneFromDwell();
      if (used === 0) st = feedCycle(s, st);
    }

    expect(used, "喂了 6 轮以上还是定不下来").toBeGreaterThan(0);
    const zone = s.readyZoneDisplay!;
    expect(
      Math.abs(zone.xPx - READY.x),
      `准备区标到了 x=${zone.xPx.toFixed(0)}，准备姿势在 ${READY.x} —— 偏到挥拍途中去了`,
    ).toBeLessThan(BODY_SCALE * 0.25);
    // 引拍峰值在 READY.x + 0.45×体尺度 ≈ +90px，标到那儿就说明抓错了位置
    expect(Math.abs(zone.xPx - (READY.x + 0.45 * BODY_SCALE))).toBeGreaterThan(BODY_SCALE * 0.2);
    s.dispose();
  });

  it("对照用的中位数标定**走同一道门**（否则比较出来的差异分不清来源）", () => {
    const s = makeSession();
    let st = { frames: 0, t: 0 };
    for (let i = 0; i < 20; i++) {
      s.pushPoseResult(makeFrame(st.frames, st.t, 0.45));
      st = { frames: st.frames + 1, t: st.t + 40 };
    }
    expect(s.calibrateReadyZoneFromMedian(), "中位数标定绕过了准入条件").toBe(0);
    s.dispose();
  });

  it("换了源（seek/重播/切摄像头）之后，**稳定性记忆要一起清掉**", () => {
    /*
     * 为什么这条不是"跑一下看看是不是 0"就算数：reset 之后样本是空的，
     * 任何实现都会返回 0 —— 那样写的话，删掉 `lastDwellEstimate = null`
     * 测试照样绿，等于什么都没守。
     *
     * 要能**区分**，就得让新旧源估出来的是同一个位置：合成动作每轮完全一样，
     * 所以旧源稳定在 P、新源也稳定在 P。
     * 于是第一次调用就成了判据：
     *   - 记忆被清掉 → 没有"上一次"，**必须返回 0**（还要再看到一次才敢定）；
     *   - 记忆留着 → 上一次就是 P、这次也是 P → 一次采样就成交。
     */
    const s = makeSession();
    let st = { frames: 0, t: 0 };
    for (let i = 0; i < 6; i++) st = feedCycle(s, st);
    let used = 0;
    for (let i = 0; i < 5 && used === 0; i++) {
      used = s.calibrateReadyZoneFromDwell();
      if (used === 0) st = feedCycle(s, st);
    }
    expect(used, "夹具失效：先得能在旧源上标定成功").toBeGreaterThan(0);

    s.resetSegmentation();

    // 新源：同样的动作，估出来的位置与旧源相同
    let st2 = { frames: st.frames, t: st.t };
    for (let i = 0; i < 6; i++) st2 = feedCycle(s, st2);

    expect(
      s.calibrateReadyZoneFromDwell(),
      "换了源还把旧源的估计当基准 —— 新源只看到一批样本就成交了",
    ).toBe(0);
    // 第二次才允许（此时"上一次"来自新源自己）
    expect(s.calibrateReadyZoneFromDwell()).toBeGreaterThan(0);
    s.dispose();
  });
});
