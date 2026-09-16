/**
 * 真实姿态输出的**解剖比例自检**。
 *
 * 这是"骨架是否贴合关节"（F-006）里**机器能查**的那一半。
 * 目视贴合只有人能判断 —— 本文件不声称能替代它。但有一类故障机器查得到：
 * **关键点错位或串了身体部位**。那种情况下，用体尺度归一化后的骨段比例会
 * 明显偏离正常人体范围（比如前臂比上臂还长、大腿与小腿差出两倍）。
 *
 * 所以这里钉的是**解剖学不自洽**的检测，不是精度。
 *
 * ⚠️ 需要一段真实的挥拍视频。缺失时整体 skip（CI 上没有该文件）——
 * 不伪装成通过。把文件放到下面 VIDEO 指向的路径即可启用。
 *
 * 阈值来源：在**一支**真实视频上实测后取的宽松边界（见 docs/known-failures.md）。
 * 样本量为 1，**不能**据此宣称识别准确率；它只挡"明显不像人"的输出。
 */

import { existsSync, readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

/** 真实素材。不存在时跳过 —— 素材本身在 Git 之外（见 docs/data-contracts.md）。 */
const VIDEO = process.env.PPC_VERIFY_VIDEO ?? "";
const hasVideo = VIDEO !== "" && existsSync(VIDEO);

test.describe("真实姿态输出的解剖比例自检", () => {
  test.skip(!hasVideo, "未提供 PPC_VERIFY_VIDEO（真实挥拍素材），跳过");

  test("关键点落在解剖学连贯的位置上，不是错位的点", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/e2e/fixtures/fixture.html");
    await page.waitForFunction(() => Boolean(window.__fixture));

    const b64 = readFileSync(VIDEO).toString("base64");

    const out = await page.evaluate(async (videoB64: string) => {
      const bin = atob(videoB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      const video = document.createElement("video");
      video.muted = true;
      video.src = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      await new Promise<void>((r, j) => {
        video.onloadeddata = () => r();
        video.onerror = () => j(new Error("视频加载失败"));
      });
      // 取中间一帧，避开开头可能的静止段
      video.currentTime = 0.5;
      await new Promise<void>((r) => {
        video.onseeked = () => r();
      });

      // 这里必须用**浏览器里可解析的模块路径**，而不是裸包名 ——
      // page.evaluate 的代码跑在页面上下文，没有 Node 的包解析。
      // 代价是 tsc 解析不了这个路径（它只在 Vite 的模块图里存在），
      // 所以用变量拼出说明符，让 tsc 不去静态解析它。
      const bundlePath = "/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs";
      const { FilesetResolver, PoseLandmarker } = (await import(
        /* @vite-ignore */ bundlePath
      )) as typeof import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks(new URL("/wasm", document.baseURI).href);
      const lm = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: new URL("/models/pose_landmarker_full.task", document.baseURI).href,
          delegate: "GPU",
        },
        runningMode: "IMAGE",
        numPoses: 1,
      });

      const r = lm.detect(video);
      const kp = r.landmarks?.[0];
      if (!kp) return { detected: false } as const;

      const W = video.videoWidth;
      const H = video.videoHeight;
      const p = (i: number) => ({ x: kp[i]!.x * W, y: kp[i]!.y * H });
      const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        Math.hypot(a.x - b.x, a.y - b.y);

      const lS = p(11),
        rS = p(12),
        lE = p(13),
        rE = p(14),
        rW = p(16);
      const lH = p(23),
        rH = p(24),
        lK = p(25),
        rK = p(26),
        lA = p(27),
        rA = p(28);

      const shoulderW = dist(lS, rS);
      const hipW = dist(lH, rH);
      const torso = dist(
        { x: (lS.x + rS.x) / 2, y: (lS.y + rS.y) / 2 },
        { x: (lH.x + rH.x) / 2, y: (lH.y + rH.y) / 2 },
      );

      return {
        detected: true as const,
        shoulderW_over_hipW: shoulderW / hipW,
        upperArmR_over_torso: dist(rS, rE) / torso,
        foreArmR_over_torso: dist(rE, rW) / torso,
        thighR_over_torso: dist(rH, rK) / torso,
        shinR_over_torso: dist(rK, rA) / torso,
        upperArmSymmetry: dist(lS, lE) / dist(rS, rE),
        thighSymmetry: dist(lH, lK) / dist(rH, rK),
        shinSymmetry: dist(lK, lA) / dist(rK, rA),
        // 置信度：对称性断言必须在**两侧都看得见**时才成立
        vis: {
          lAnkle: kp[27]!.visibility ?? 1,
          rAnkle: kp[28]!.visibility ?? 1,
          lThigh: Math.min(kp[23]!.visibility ?? 1, kp[25]!.visibility ?? 1),
          rThigh: Math.min(kp[24]!.visibility ?? 1, kp[26]!.visibility ?? 1),
          lArm: Math.min(kp[11]!.visibility ?? 1, kp[13]!.visibility ?? 1),
          rArm: Math.min(kp[12]!.visibility ?? 1, kp[14]!.visibility ?? 1),
        },
      };
    }, b64);

    // 先确认真的检出了人体 —— 否则下面的断言毫无意义
    expect(out.detected, "未检出人体，无法做比例自检").toBe(true);
    if (!out.detected) return;

    // ── 解剖学合理性：阈值是**宽松边界**，只挡"明显不像人"的输出 ──
    // 实测参考值（一支视频、一帧）：肩宽/髋宽 1.96、上臂 0.58、前臂 0.51、
    // 大腿 0.81、小腿 0.85。下面是它的宽区间，不是精度门槛。

    // 肩比髋宽：任何正常体型都在这个区间；串了部位就会离谱
    expect(out.shoulderW_over_hipW).toBeGreaterThan(1.2);
    expect(out.shoulderW_over_hipW).toBeLessThan(3.0);

    // 前臂应短于上臂（人体前臂≈上臂×0.85~0.95）；
    // 若前臂明显长于上臂，说明肘/腕点串位了
    expect(out.foreArmR_over_torso).toBeLessThan(out.upperArmR_over_torso * 1.1);

    // 大腿与小腿长度相当（人体大腿≈小腿×0.95~1.05）；
    // 超出 2 倍说明膝或踝落在错误的位置上
    const legRatio = out.thighR_over_torso / out.shinR_over_torso;
    expect(legRatio).toBeGreaterThan(0.7);
    expect(legRatio).toBeLessThan(1.4);

    // 左右对称：同一段骨在两侧长度应接近。
    // 透视会让远侧短一些，所以给到 35% 的容差 —— 这个宽度仍能抓住
    // "左右点互换了"这类错误（那种情况下比值会接近两边长度的反比）。
    //
    // ⚠️ **必须按置信度门控**。实测踩过：某帧左踝 `visibility` 只有 0.394
    // （脚快出画了），模型外推出的位置让左右小腿长度比变成 **0.10** ——
    // 在不可靠的点上做几何断言本身就是错的，会得到"测试失败但代码没错"。
    // 置信度低于阈值就跳过该侧的对称性检查，而不是硬判。
    const VIS_OK = 0.5;

    if (out.vis.lArm >= VIS_OK && out.vis.rArm >= VIS_OK) {
      expect(out.upperArmSymmetry).toBeGreaterThan(0.65);
      expect(out.upperArmSymmetry).toBeLessThan(1.5);
    }

    if (out.vis.lThigh >= VIS_OK && out.vis.rThigh >= VIS_OK) {
      expect(out.thighSymmetry).toBeGreaterThan(0.65);
      expect(out.thighSymmetry).toBeLessThan(1.5);
    }

    if (out.vis.lAnkle >= VIS_OK && out.vis.rAnkle >= VIS_OK) {
      expect(out.shinSymmetry).toBeGreaterThan(0.65);
      expect(out.shinSymmetry).toBeLessThan(1.5);
    } else {
      // 不静默跳过：把"因为看不全所以没查"说出来，而不是让它看起来查过了
      console.warn(
        `小腿对称性未检查：踝部置信度不足（左 ${out.vis.lAnkle.toFixed(2)} / 右 ${out.vis.rAnkle.toFixed(2)}，阈值 ${VIS_OK}）`,
      );
    }
  });
});
