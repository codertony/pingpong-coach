/**
 * 骨架叠加的**绘制层**回归（真实浏览器、真实 Canvas，不需要任何素材）。
 *
 * 为什么单独一份：手部叠加此前**一次都没画出来过**，而那是两个各自独立、
 * 又都静默的缺陷叠在一起（F-021）：
 *
 *   ① `drawHand` 按 `${侧}_hand_${后缀}` 拼名字去查点，但契约里只有**腕点**
 *      带 `_hand_` 中缀（`left_hand_wrist`），手指叫 `left_index_mcp` ——
 *      21 个点里 20 个查不到，守卫直接 return，什么都没画。
 *   ② 手部点同时又被上面那圈"通用关键点"按**姿态点的尺寸**画了一遍
 *      （持拍侧半径 7.5px）。手在画面里只有约 90px 宽，点比指间距还大，
 *      于是整只手糊成一团白 —— 看上去"画了"，实际什么都看不出来。
 *
 * 两者都不会让任何测试变红：画布是空的，而断言只检查"跑没跑过"。
 * 这里的做法是**只喂手部点**，然后数画布上到底有多少像素 ——
 * 空画布和糊成一团都能被这一条区分开，而且不需要真实素材，CI 上就会跑。
 */

import { test, expect } from "@playwright/test";

test.describe("骨架叠加 · 绘制层", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/e2e/fixtures/fixture.html");
    await page.waitForFunction(() => Boolean(window.__fixture));
  });

  test("只给手部 21 点时，手必须真的被画出来", async ({ page }) => {
    const out = await page.evaluate(() => {
      // 一副摊开的右手：腕在下方，四指朝上，拇指在左侧。
      // 名字必须与 `pose.worker.ts` 产出的**契约名**一致 ——
      // 这正是被测的那件事：绘制层认不认得这些名字。
      const pts = [
        { name: "right_hand_wrist", xPx: 200, yPx: 300 },
        { name: "right_thumb_cmc", xPx: 172, yPx: 292 },
        { name: "right_thumb_mcp", xPx: 160, yPx: 272 },
        { name: "right_thumb_ip", xPx: 150, yPx: 254 },
        { name: "right_thumb_tip", xPx: 142, yPx: 236 },
        { name: "right_index_mcp", xPx: 206, yPx: 236 },
        { name: "right_index_pip", xPx: 208, yPx: 214 },
        { name: "right_index_dip", xPx: 209, yPx: 196 },
        { name: "right_index_tip", xPx: 210, yPx: 178 },
        { name: "right_middle_mcp", xPx: 228, yPx: 232 },
        { name: "right_middle_pip", xPx: 231, yPx: 208 },
        { name: "right_middle_dip", xPx: 233, yPx: 188 },
        { name: "right_middle_tip", xPx: 234, yPx: 168 },
        { name: "right_ring_mcp", xPx: 250, yPx: 236 },
        { name: "right_ring_pip", xPx: 254, yPx: 214 },
        { name: "right_ring_dip", xPx: 257, yPx: 196 },
        { name: "right_ring_tip", xPx: 259, yPx: 180 },
        { name: "right_pinky_mcp", xPx: 270, yPx: 244 },
        { name: "right_pinky_pip", xPx: 274, yPx: 226 },
        { name: "right_pinky_dip", xPx: 277, yPx: 210 },
        { name: "right_pinky_tip", xPx: 280, yPx: 196 },
      ].map((p) => ({
        name: p.name,
        xPx: p.xPx,
        yPx: p.yPx,
        score: null,
        visible: null,
      }));

      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 640;
      window.__fixture.drawSkeleton(canvas, pts, "right", { mirrored: false, minScore: 0.5 });

      const data = canvas.getContext("2d")!.getImageData(0, 0, 640, 640).data;
      let drawn = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) drawn++;
      return { drawn };
    });

    // 一个非零下限就够抓住"名字查不到 → 整只手没画"。
    // 取 200：21 个点 + 掌心轮廓 + 五根手指的线，正常量级在千像素；
    // 而只画出一两个孤立点（名字大面积失配）会远低于这个数。
    //
    // ⚠️ **覆盖边界**：它抓的是"绘制层认不出这些名字"。若名字整体错位但仍能
    // 解析出**别处存在**的点（例如整张表平移一位），这条**不会**变红 ——
    // 那种情况下画出来的是一副错位但完整的手。实测确认过这一点。
    // 现在名字直接取自契约顺序，不存在"自己拼名字"这种错法了；
    // 这条断言守的是"将来又有人回去拼名字"。
    expect(
      out.drawn,
      "只给手部 21 点时画布几乎是空的 —— 绘制层认不出这些名字（F-021 的 ①）",
    ).toBeGreaterThan(200);
  });

  test("手部点不得按姿态点的尺寸重复画一遍", async ({ page }) => {
    const out = await page.evaluate(() => {
      // 只给**一个**手部点，且不是 drawHand 的三个锚点之一。
      //   - 若通用关键点那圈会画手部点 → 这个点会按姿态尺寸画出来（>0）
      //   - 修好后：通用那圈跳过手部点，drawHand 又因缺锚点不画 → 0
      const pts = [{ name: "right_index_tip", xPx: 320, yPx: 320, score: null, visible: null }];

      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 640;
      window.__fixture.drawSkeleton(canvas, pts, "right", { mirrored: false, minScore: 0.5 });

      const data = canvas.getContext("2d")!.getImageData(0, 0, 640, 640).data;
      let drawn = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) drawn++;
      return { drawn };
    });

    expect(
      out.drawn,
      "手部点被通用关键点那圈按姿态尺寸画了出来 —— 21 个点会糊成一团，" +
        "手指细节全被盖掉（F-021 的 ②）",
    ).toBe(0);
  });

  test("姿态点该画的仍然要画（跳过逻辑不能误伤）", async ({ page }) => {
    const out = await page.evaluate(() => {
      // 阴性对照：上面那条断言要求"不画"，必须确认它没有变成"什么都不画"。
      const pts = [
        { name: "left_shoulder", xPx: 200, yPx: 200, score: 0.9, visible: true },
        { name: "right_shoulder", xPx: 300, yPx: 200, score: 0.9, visible: true },
      ];

      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 640;
      window.__fixture.drawSkeleton(canvas, pts, "right", { mirrored: false, minScore: 0.5 });

      const data = canvas.getContext("2d")!.getImageData(0, 0, 640, 640).data;
      let drawn = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) drawn++;
      return { drawn };
    });

    expect(out.drawn, "姿态点没被画出来 —— 跳过手部点的那条判断误伤了姿态点").toBeGreaterThan(0);
  });
});
