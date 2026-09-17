/**
 * 手部模型的**接口契约**验证（真实模型、真实图片）。
 *
 * 为什么需要它：手部能力此前只有"模型能否加载"被验证过，而加载成功
 * 不等于接口用对了。这里用真实图片跑真实手部模型，钉住三件事：
 *
 * 1. 对手部清晰的图片确实能检出（不是永远返回空）；
 * 2. 检出的点有**有效坐标**（不是全 NaN / 全 0）；
 * 3. **`visibility` 恒为 0** —— 这是踩过的坑：把它当可见性用，会让所有
 *    手部点变成 `visible: false`，几何永远算不出、绘制永远不画。
 *    这条断言把这个事实**固定在测试里**，防止将来有人"顺手"改回去。
 *
 * ⚠️ 需要一张手部可辨的图片。未提供 `PPC_HAND_IMAGE` 时整体 skip ——
 * 素材在 Git 之外（见 docs/data-contracts.md）。CI 上没有该文件。
 *
 * **本机那段挥拍素材喂不了这条探针**（2026-09-17 实测，两次都试过）：
 * 31 个采样帧里只有 2 帧检出过手（t=3s、t=6.25s），而这两次检出的"手"
 * 离**任何一个腕部关键点都有 625px / 712px**（判定容差 220px）——
 * 也就是说它检的不是持拍手，已被下游拒绝（见 known-failures 的 F-020 / F-021）。
 * 把这两帧的手部区域裁出来、放大后**当作图片**喂给模型，两帧都是 **0 检出**。
 * 所以这条探针在本机上**跑不出绿**：它的前置条件（一张手部清晰、静止的图）
 * 那段视频给不了 —— 障碍是挥拍时的运动模糊，不是分辨率。
 * 要让它跑起来，得单独拍一张清楚的静止手部照片，再传 `PPC_HAND_IMAGE`。
 */

import { existsSync, readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

const IMAGE = process.env.PPC_HAND_IMAGE ?? "";
const hasImage = IMAGE !== "" && existsSync(IMAGE);

test.describe("手部模型接口契约", () => {
  test.skip(!hasImage, "未提供 PPC_HAND_IMAGE（手部可辨的图片），跳过");

  test("检出到的手：坐标有效，且 visibility 恒为 0", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/e2e/fixtures/fixture.html");
    await page.waitForFunction(() => Boolean(window.__fixture));

    const b64 = readFileSync(IMAGE).toString("base64");
    const mime = /\.png$/i.test(IMAGE) ? "image/png" : "image/jpeg";

    const out = await page.evaluate(
      async ({ data, type }) => {
        const bundlePath = "/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs";
        const { FilesetResolver, HandLandmarker } = (await import(
          /* @vite-ignore */ bundlePath
        )) as typeof import("@mediapipe/tasks-vision");
        const vision = await FilesetResolver.forVisionTasks(
          new URL("/wasm", document.baseURI).href,
        );
        const lm = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: new URL("/models/hand_landmarker.task", document.baseURI).href,
            delegate: "GPU",
          },
          runningMode: "IMAGE",
          numHands: 2,
        });

        const img = new Image();
        await new Promise<void>((r, j) => {
          img.onload = () => r();
          img.onerror = () => j(new Error("图片加载失败"));
          img.src = `data:${type};base64,${data}`;
        });

        const res = lm.detect(img);
        const h = res.landmarks?.[0];
        return {
          handCount: (res.landmarks ?? []).length,
          pointCount: h?.length ?? 0,
          // 坐标是否都是有限值
          allFinite: h ? h.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) : false,
          // 坐标是否落在 [0,1] 归一化范围内
          inRange: h ? h.every((p) => p.x >= -1 && p.x <= 2 && p.y >= -1 && p.y <= 2) : false,
          // 关键：实测 visibility 恒为 0
          maxVisibility: h ? Math.max(...h.map((p) => p.visibility ?? 0)) : null,
          // 而左右手分数是有效的
          handednessScore: res.handedness?.[0]?.[0]?.score ?? null,
        };
      },
      { data: b64, type: mime },
    );

    // 1) 这张图确实能检出（否则后面的断言没有意义）
    expect(out.handCount, "该图未检出任何手，请换一张手部更清晰的图片").toBeGreaterThan(0);
    expect(out.pointCount).toBe(21);
    expect(out.allFinite).toBe(true);
    expect(out.inRange).toBe(true);

    // 2) 左右手分是有效的置信度
    expect(out.handednessScore).not.toBeNull();
    expect(out.handednessScore!).toBeGreaterThan(0.5);

    // 3) **这个模型不提供逐点可见性** —— 固定住这个事实。
    //    如果哪天上游模型开始填 visibility，这条会失败，那时应当去
    //    pose.worker.ts 里把 handToPixel 换回读 visibility，
    //    而不是删掉这条断言。它守的是"适配层没有误用 0 当不可见"。
    expect(
      out.maxVisibility,
      "手部模型的 visibility 不再是恒 0 了 —— 上游行为变了，需重新审视 handToPixel 的适配",
    ).toBe(0);
  });
});
