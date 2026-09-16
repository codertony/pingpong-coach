/**
 * 关键帧图片链路的端到端验证（F-028）。
 *
 * 要证的是**整条链路真的接通了**，而不只是"函数能跑"：
 *   真实位图 → JPEG 编码（真实 OffscreenCanvas）→ 进缓存 → 成组时被选中
 *   → 出现在 EvidencePacket.keyframes 里，且字节非空。
 *
 * 为什么必须在真实浏览器里：编码依赖 `OffscreenCanvas.convertToBlob`，
 * jsdom 没有它。抽帧节奏与错误隔离那几条已经在 vitest 里覆盖了，这里只补
 * "真实编码 + 真实进包"这一段。
 *
 * 背景：在这之前 `KeyframeCache.add()` 在整个产品代码里**没有任何调用方**，
 * 于是 `keyframes` 恒为空数组 —— 所谓"多模态调用"收到的是纯文本。
 */

import { test, expect } from "@playwright/test";

test.describe("关键帧图片链路（F-028）", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/e2e/fixtures/fixture.html");
    await page.waitForFunction(() => Boolean(window.__fixture));
  });

  test("真实位图能编出 JPEG，且被压到声明的长边预算内", async ({ page }) => {
    const out = await page.evaluate(async () => {
      const { makeRealBitmap, encodeKeyframeJpeg, MAX_KEYFRAME_LONG_EDGE_PX } = window.__fixture;
      // 用一张有内容的图，别用纯色 —— 纯色 JPEG 太小，测不出"压没压对"以外的东西
      const bitmap = await makeRealBitmap(1280, 720, "steelblue");
      const encoded = await encodeKeyframeJpeg(bitmap, {
        maxLongEdgePx: MAX_KEYFRAME_LONG_EDGE_PX,
      });
      return {
        budget: MAX_KEYFRAME_LONG_EDGE_PX,
        encoded: encoded
          ? { bytes: encoded.bytes.byteLength, width: encoded.width, height: encoded.height }
          : null,
      };
    });

    expect(out.encoded, "编码返回了 null —— 真实浏览器里都编不出图，链路根本没通").not.toBeNull();
    expect(out.encoded!.bytes, "编出来的字节是空的").toBeGreaterThan(0);
    // 1280×720 的长边是 1280 > 960 → 应当被压到 960×540
    expect(Math.max(out.encoded!.width, out.encoded!.height)).toBeLessThanOrEqual(out.budget);
    expect(out.encoded!.width).toBe(960);
    expect(out.encoded!.height).toBe(540);
  });

  test("成组后的证据包里**真的有图片**，而不是空数组", async ({ page }) => {
    const out = await page.evaluate(async () => {
      const { TrainingSession, buildTrainingConfig, makeRealBitmap, encodeKeyframeJpeg } =
        window.__fixture;

      // 先编出一张真实 JPEG，喂给下面所有帧（内容相同不影响这条断言的目的：
      // 它要证的是"字节能进包"，不是"每帧图不一样"）
      const bitmap = await makeRealBitmap(1280, 720, "seagreen");
      const encoded = await encodeKeyframeJpeg(bitmap, { maxLongEdgePx: 960 });
      // 编码失败就直接炸 —— 这条用例的前提就是"真实编码能产出字节"，
      // 悄悄返回会让下面的断言在一个空场景上"通过"
      if (!encoded) throw new Error("编码失败：这条用例的前提不成立");

      let packet: {
        keyframes: Array<{ id: string; jpegBase64: string }>;
      } | null = null;

      const session = new TrainingSession(
        buildTrainingConfig({
          sessionId: "kf_e2e",
          handedness: "right",
          cameraView: "front",
          focusId: "return_to_ready_zone",
          strokesPerGroup: 3,
        }),
        {
          onStatus: () => {},
          onStroke: () => {},
          onFeedback: () => {},
          onGroupComplete: (p) => {
            packet = p;
          },
        },
      );
      session.setReadyZone({ x: 640, y: 420 });

      const READY = { x: 640, y: 420 };
      const SCALE = 200;
      const body = (wristX: number) => [
        { name: "nose", xPx: 640, yPx: 120, score: 0.95, visible: true },
        { name: "left_shoulder", xPx: 600, yPx: 200, score: 0.9, visible: true },
        { name: "right_shoulder", xPx: 680, yPx: 200, score: 0.9, visible: true },
        { name: "left_elbow", xPx: 580, yPx: 280, score: 0.9, visible: true },
        { name: "right_elbow", xPx: 700, yPx: 280, score: 0.9, visible: true },
        { name: "left_hip", xPx: 610, yPx: 400, score: 0.9, visible: true },
        { name: "right_hip", xPx: 670, yPx: 400, score: 0.9, visible: true },
        { name: "left_knee", xPx: 605, yPx: 520, score: 0.9, visible: true },
        { name: "right_knee", xPx: 675, yPx: 520, score: 0.9, visible: true },
        { name: "left_ankle", xPx: 600, yPx: 640, score: 0.9, visible: true },
        { name: "right_ankle", xPx: 680, yPx: 640, score: 0.9, visible: true },
        { name: "right_wrist", xPx: wristX, yPx: READY.y, score: 0.9, visible: true },
      ];

      const offsets = [
        0, 0, 0, 0, 0, 0, 0.2, 0.45, 0.45, 0.45, 0.45, 0.3, 0.15, 0.05, 0, 0, 0, 0, 0, 0,
      ];

      let t = 0;
      let i = 0;
      for (let cycle = 0; cycle < 6 && !packet; cycle++) {
        for (const offset of offsets) {
          if (packet) break;
          const frameId = `kf_${i}`;
          const sourceTimeMs = t;
          // ① 把这一帧的像素放进缓存（产品里由采集侧在交给引擎前做，见 App.tsx）
          session.addFramePixels(
            frameId,
            sourceTimeMs,
            encoded.bytes,
            encoded.width,
            encoded.height,
          );
          // ② 再喂姿态结果（顺序与产品一致：位图先被取走，结果稍后才回来）
          session.pushPoseResult({
            frameId,
            sourceEpoch: 0,
            sourceTimeMs,
            receivedAtMonoMs: t,
            inferredAtMonoMs: t,
            inferenceMs: 5,
            imageWidth: 1280,
            imageHeight: 720,
            keypoints2D: body(READY.x + offset * SCALE),
            detected: true,
            handDetected: false,
            keypointSet: "blaze_33",
          });
          t += 40;
          i++;
        }
      }

      const telemetry = session.telemetry;
      session.dispose();

      const kf = packet as {
        keyframes: Array<{ id: string; frameId: string; jpegBase64: string }>;
        strokes: Array<{ evidenceFrameIds: string[] }>;
      } | null;
      const strokeFrameIds = new Set(kf?.strokes.flatMap((s) => s.evidenceFrameIds) ?? []);

      return {
        completed: packet != null,
        // 只回传形状与体积，不回传 base64 本身（那会是几 MB 的字符串）
        keyframeCount: kf ? kf.keyframes.length : 0,
        keyframeBytes: kf ? kf.keyframes.map((k) => k.jpegBase64.length) : [],
        // 契约里写着"keyframes[].frameId 必须与 strokes[].evidenceFrameIds 对齐"
        alignedKeyframes: kf ? kf.keyframes.filter((x) => strokeFrameIds.has(x.frameId)).length : 0,
        strokeEvidenceIdCount: strokeFrameIds.size,
        keyframesMissing: telemetry.keyframesMissing,
      };
    });

    expect(out.completed, "没能在限定帧数内成组，这条测不到").toBe(true);
    // 契约要求：keyframes[].frameId 必须与 strokes[].evidenceFrameIds 对齐。
    // 实测过未收窄候选时 18 张里有 3 张不对齐（见 F-029），现在由选择器本身保证。
    expect(
      out.alignedKeyframes,
      `关键帧里有 ${out.keyframeCount - out.alignedKeyframes} 张的 frameId ` +
        `不在任何一板的 evidenceFrameIds 里 —— 契约要求对齐，而服务端会把关键帧 id ` +
        `并进可引用集合，于是模型能引用一张不属于它正在讲的那一板的图`,
    ).toBe(out.keyframeCount);
    expect(
      out.keyframeBytes.length,
      "证据包里的 keyframes 是空的 —— 图片链路还是断的（这正是 F-028）",
    ).toBeGreaterThan(0);
    for (const n of out.keyframeBytes) {
      expect(n, "有一张关键帧的 base64 是空的（那等于没有图）").toBeGreaterThan(0);
    }
    // 成组遥测也必须如实反映"这次取到了图"
    expect(out.keyframesMissing, "遥测说还有关键帧取不到图").toBe(0);
  });

  test("超出请求预算时**自动削减并如实记录**，而不是被服务端 413 打回（F-031）", async ({
    page,
  }) => {
    const out = await page.evaluate(async () => {
      const { TrainingSession, buildTrainingConfig, analyzeGroup } = window.__fixture;

      // 造一批"很大的图"：每张 600 KB 假字节 → 6 张的 base64 约 4.8 MB，
      // 远超 2 MiB 的请求预算。内容是不是真 JPEG 不影响这条用例 ——
      // 它测的是**体积削减与记录**，编码本身由上面那条用真实位图覆盖。
      const BIG = 600 * 1024;

      let packet: {
        keyframes: Array<{ frameId: string }>;
        limitations: string[];
        strokes: Array<{ evidenceFrameIds: string[] }>;
      } | null = null;

      const session = new TrainingSession(
        buildTrainingConfig({
          sessionId: "budget_e2e",
          handedness: "right",
          cameraView: "front",
          focusId: "return_to_ready_zone",
          strokesPerGroup: 3,
        }),
        {
          onStatus: () => {},
          onStroke: () => {},
          onFeedback: () => {},
          onGroupComplete: (p) => {
            packet = p;
          },
        },
      );
      session.setReadyZone({ x: 640, y: 420 });

      const READY = { x: 640, y: 420 };
      const body = (wristX: number) => [
        { name: "nose", xPx: 640, yPx: 120, score: 0.95, visible: true },
        { name: "left_shoulder", xPx: 600, yPx: 200, score: 0.9, visible: true },
        { name: "right_shoulder", xPx: 680, yPx: 200, score: 0.9, visible: true },
        { name: "left_elbow", xPx: 580, yPx: 280, score: 0.9, visible: true },
        { name: "right_elbow", xPx: 700, yPx: 280, score: 0.9, visible: true },
        { name: "left_hip", xPx: 610, yPx: 400, score: 0.9, visible: true },
        { name: "right_hip", xPx: 670, yPx: 400, score: 0.9, visible: true },
        { name: "left_knee", xPx: 605, yPx: 520, score: 0.9, visible: true },
        { name: "right_knee", xPx: 675, yPx: 520, score: 0.9, visible: true },
        { name: "left_ankle", xPx: 600, yPx: 640, score: 0.9, visible: true },
        { name: "right_ankle", xPx: 680, yPx: 640, score: 0.9, visible: true },
        { name: "right_wrist", xPx: wristX, yPx: READY.y, score: 0.9, visible: true },
      ];
      const bigBytes = new Uint8Array(BIG);

      const offsets = [
        0, 0, 0, 0, 0, 0, 0.2, 0.45, 0.45, 0.45, 0.45, 0.3, 0.15, 0.05, 0, 0, 0, 0, 0, 0,
      ];
      let t = 0;
      let i = 0;
      for (let cycle = 0; cycle < 6 && !packet; cycle++) {
        for (const offset of offsets) {
          if (packet) break;
          const frameId = `big_${i}`;
          session.addFramePixels(frameId, t, bigBytes, 960, 540);
          session.pushPoseResult({
            frameId,
            sourceEpoch: 0,
            sourceTimeMs: t,
            receivedAtMonoMs: t,
            inferredAtMonoMs: t,
            inferenceMs: 5,
            imageWidth: 1280,
            imageHeight: 720,
            keypoints2D: body(READY.x + offset * 200),
            detected: true,
            handDetected: false,
            keypointSet: "blaze_33",
          });
          t += 40;
          i++;
        }
      }

      const p = packet as {
        keyframes: Array<{ frameId: string }>;
        limitations: string[];
        strokes: Array<{ evidenceFrameIds: string[] }>;
      } | null;
      if (!p) return { completed: false } as const;

      // 注意：`completeGroup` 在回调**之前**就把包削减过了，
      // 所以这里看到的是削减**之后**的包 —— 削减前的大小观察不到。
      // "本来超没超预算"因此靠"有没有那条削减说明"来证（削减只在超预算时发生）。
      const finalBytes = JSON.stringify(p).length;
      const res = await analyzeGroup(p as never);
      session.dispose();
      return {
        completed: true as const,
        keyframeCount: p.keyframes.length,
        limitations: p.limitations,
        finalBytes,
        apiError: res.error,
        gotFeedback: res.feedback != null,
      };
    });

    expect(out.completed, "没能成组").toBe(true);
    if (!out.completed) return;
    // ① 削减确实发生了（而它只在超预算时发生）—— 这同时证明了用例前提成立
    expect(
      out.limitations.some((l) => l.includes("丢弃")),
      "没有削减说明：要么这组本来就没超预算（用例前提不成立），要么削减了却没记录",
    ).toBe(true);
    // ② 削减到了预算以内
    expect(
      out.finalBytes,
      `削减后仍有 ${out.finalBytes} 字节，超过 2 MiB 预算`,
    ).toBeLessThanOrEqual(2 * 1024 * 1024);
    // ③ 确实丢掉了图（最多 6 张，削减后更少）
    expect(out.keyframeCount, "说削减了，却一张都没少").toBeLessThan(6);
    // ④ 关键：服务端收了，而不是 413（这正是这条修复的目的）
    expect(out.apiError, `削减之后仍被服务端拒了：${JSON.stringify(out.apiError)}`).toBeNull();
    expect(out.gotFeedback, "没有拿到反馈").toBe(true);
  });
});
