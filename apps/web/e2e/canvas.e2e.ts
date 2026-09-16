/**
 * 真实 Canvas 绘制测试。
 *
 * 为什么必须用真实浏览器：jsdom 的 canvas 是空实现，
 * `getContext("2d")` 返回 null 或无法 `getImageData`。
 * 而这个项目的骨架叠加层是**用户唯一直接看到的东西** ——
 * 画错了（镜像反了、坐标没缩放、关键点没画）在纯逻辑测试里完全测不出来。
 *
 * 这些测试读取真实像素来验证「确实画出了东西、画在了正确位置」。
 */

import { test, expect } from "@playwright/test";
import { KEYPOINTS } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/e2e/fixtures/fixture.html");
  await page.waitForFunction(() => Boolean(window.__fixture));
});

test.describe("drawSkeleton — 真实像素绘制", () => {
  test("画出骨架后画布上确实出现了非透明像素", async ({ page }) => {
    const result = await page.evaluate((keypoints) => {
      const canvas = document.getElementById("skeleton") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const before = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const beforeNonEmpty = before.some((v, i) => i % 4 === 3 && v > 0);

      window.__fixture.drawSkeleton(canvas, keypoints as never, "right", {
        mirrored: false,
        minScore: 0.5,
      });

      const after = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let drawn = 0;
      for (let i = 3; i < after.length; i += 4) if (after[i]! > 0) drawn++;

      return { beforeNonEmpty, drawn };
    }, KEYPOINTS);

    // 绘制前应是干净的（同一个 canvas，确认测试起点正确）
    expect(result.beforeNonEmpty).toBe(false);
    // 绘制后必须有像素被写上
    expect(result.drawn).toBeGreaterThan(0);
  });

  test("关键点为空时不绘制任何东西（不残留脏像素）", async ({ page }) => {
    const drawn = await page.evaluate(() => {
      const canvas = document.getElementById("skeleton") as HTMLCanvasElement;
      window.__fixture.drawSkeleton(canvas, [], "right", { mirrored: false, minScore: 0.5 });
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++;
      return n;
    });
    expect(drawn).toBe(0);
  });

  test("镜像只在绘制层生效：同一点在 mirrored 下画到左右相反位置", async ({ page }) => {
    const result = await page.evaluate((keypoints) => {
      const canvas = document.getElementById("skeleton") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const W = canvas.width;

      /** 找出最左侧与最右侧被绘制的像素列 */
      function columnRange(): { min: number; max: number } {
        const data = ctx.getImageData(0, 0, W, canvas.height).data;
        let min = Infinity;
        let max = -Infinity;
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < W; x++) {
            if (data[(y * W + x) * 4 + 3]! > 0) {
              if (x < min) min = x;
              if (x > max) max = x;
            }
          }
        }
        return { min, max };
      }

      ctx.clearRect(0, 0, W, canvas.height);
      window.__fixture.drawSkeleton(canvas, keypoints as never, "right", {
        mirrored: false,
        minScore: 0.5,
      });
      const plain = columnRange();

      ctx.clearRect(0, 0, W, canvas.height);
      window.__fixture.drawSkeleton(canvas, keypoints as never, "right", {
        mirrored: true,
        minScore: 0.5,
      });
      const mirrored = columnRange();

      return { plain, mirrored, W };
    }, KEYPOINTS);

    // 镜像后，左边界应大致等于 W - 原右边界，右边界大致等于 W - 原左边界。
    expect(result.mirrored.min).toBeCloseTo(result.W - result.plain.max, -1);
    expect(result.mirrored.max).toBeCloseTo(result.W - result.plain.min, -1);
  });

  test("visible=false 的关键点不参与绘制", async ({ page }) => {
    const result = await page.evaluate((keypoints) => {
      const canvas = document.getElementById("skeleton") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;

      const countPixels = () => {
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
        return n;
      };

      // 全部可见
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      window.__fixture.drawSkeleton(canvas, keypoints as never, "right", {
        mirrored: false,
        minScore: 0.5,
      });
      const allVisible = countPixels();

      // 全部不可见
      const hidden = (keypoints as Array<Record<string, unknown>>).map((k) => ({
        ...k,
        visible: false,
      }));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      window.__fixture.drawSkeleton(canvas, hidden as never, "right", {
        mirrored: false,
        minScore: 0.5,
      });
      const noneVisible = countPixels();

      return { allVisible, noneVisible };
    }, KEYPOINTS);

    expect(result.allVisible).toBeGreaterThan(0);
    expect(result.noneVisible).toBe(0);
  });

  test("低置信度点用不同颜色绘制（提示不可靠），但依然画出来", async ({ page }) => {
    const result = await page.evaluate((keypoints) => {
      const canvas = document.getElementById("skeleton") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;

      const collectColors = () => {
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const set = new Set<string>();
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3]! > 0) set.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
        }
        return set;
      };

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      window.__fixture.drawSkeleton(canvas, keypoints as never, "right", {
        mirrored: false,
        minScore: 0.5,
      });
      const high = collectColors();

      const low = (keypoints as Array<Record<string, unknown>>).map((k) => ({ ...k, score: 0.2 }));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      window.__fixture.drawSkeleton(canvas, low as never, "right", {
        mirrored: false,
        minScore: 0.5,
      });
      const lowSet = collectColors();

      return { high: [...high], low: [...lowSet] };
    }, KEYPOINTS);

    // 两种情形都画了东西
    expect(result.high.length).toBeGreaterThan(0);
    expect(result.low.length).toBeGreaterThan(0);
    // 但配色集合不同 —— 低置信度会换色提示
    expect(result.low.join("|")).not.toBe(result.high.join("|"));
  });
});

test.describe("drawReadyZone", () => {
  test("zone 为 null 时不绘制", async ({ page }) => {
    const n = await page.evaluate(() => {
      const canvas = document.getElementById("zone") as HTMLCanvasElement;
      window.__fixture.drawReadyZone(canvas, null, false);
      const d = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let c = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) c++;
      return c;
    });
    expect(n).toBe(0);
  });

  test("有效 zone 画出虚线圆环，且落在指定位置附近", async ({ page }) => {
    const result = await page.evaluate(() => {
      const canvas = document.getElementById("zone") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      window.__fixture.drawReadyZone(canvas, { xPx: 200, yPx: 150, radiusPx: 60 }, false);

      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          if (d[(y * canvas.width + x) * 4 + 3]! > 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return { minX, maxX, minY, maxY };
    });

    // 圆心 200,150 半径 60 → 包围盒约 [140,260] x [90,210]
    expect(result.minX).toBeGreaterThan(130);
    expect(result.maxX).toBeLessThan(270);
    expect(result.minY).toBeGreaterThan(80);
    expect(result.maxY).toBeLessThan(220);
  });

  test("镜像时准备区绘制到水平镜像位置", async ({ page }) => {
    const result = await page.evaluate(() => {
      const canvas = document.getElementById("zone") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const W = canvas.width;

      const centerX = () => {
        const d = ctx.getImageData(0, 0, W, canvas.height).data;
        let sum = 0;
        let n = 0;
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < W; x++) {
            if (d[(y * W + x) * 4 + 3]! > 0) {
              sum += x;
              n++;
            }
          }
        }
        return n === 0 ? null : sum / n;
      };

      window.__fixture.drawReadyZone(canvas, { xPx: 200, yPx: 150, radiusPx: 40 }, false);
      const plainCenter = centerX();

      ctx.clearRect(0, 0, W, canvas.height);
      window.__fixture.drawReadyZone(canvas, { xPx: 200, yPx: 150, radiusPx: 40 }, true);
      const mirroredCenter = centerX();

      return { plainCenter, mirroredCenter, W };
    });

    expect(result.plainCenter).not.toBeNull();
    expect(result.mirroredCenter).not.toBeNull();
    // 镜像中心应约为 W - 原中心
    expect(result.mirroredCenter as number).toBeCloseTo(
      result.W - (result.plainCenter as number),
      -1,
    );
  });
});

/**
 * 手部 21 点的绘制回归。
 *
 * 为什么要守：手部点是**可选**的（手部模型可能不可用），所以绘制层必须
 * 在"手部点缺失"时干净跳过，而不是画出一堆散落在 (0,0) 的点 ——
 * 后者会在真机上表现为画面角落出现一簇莫名的小圆点，且很难定位到原因。
 */
test.describe("drawSkeleton — 手部 21 点", () => {
  /** 造一只摊开的右手：腕在左下，四指朝右上，另加拇指。 */
  function rightHandPoints() {
    // ⚠️ 名字必须与契约 `HAND_LANDMARK_NAMES` 一致：**只有腕点**带 `_hand_` 中缀
    // （`right_hand_wrist`），手指是 `right_thumb_mcp` / `right_index_mcp` …
    //
    // 这里原先写的是 `right_hand_thumb_mcp` 这类**契约里根本不存在**的名字。
    // 而当时的绘制层也拼错了同样的名字 —— 测试与实现**错得一模一样**，
    // 于是这组测试一直在量"通用关键点循环把手部点当姿态点画出来的像素"，
    // 却报成"手部绘制通过"。真正的 `drawHand` 一次都没被执行过（F-021）。
    const pts = [
      { name: "right_hand_wrist", xPx: 300, yPx: 300, score: 0.9, visible: true },
      { name: "right_thumb_mcp", xPx: 290, yPx: 280, score: 0.9, visible: true },
      { name: "right_thumb_ip", xPx: 282, yPx: 268, score: 0.9, visible: true },
      { name: "right_thumb_tip", xPx: 276, yPx: 258, score: 0.9, visible: true },
    ];
    const bases = ["index", "middle", "ring", "pinky"];
    bases.forEach((f, i) => {
      const x = 320 + i * 18;
      pts.push(
        { name: `right_${f}_mcp`, xPx: x, yPx: 300, score: 0.9, visible: true },
        { name: `right_${f}_pip`, xPx: x, yPx: 280, score: 0.9, visible: true },
        { name: `right_${f}_dip`, xPx: x, yPx: 268, score: 0.9, visible: true },
        { name: `right_${f}_tip`, xPx: x, yPx: 256, score: 0.9, visible: true },
      );
    });
    return pts;
  }

  test("有手部点时确实画出手部像素", async ({ page }) => {
    const drawn = await page.evaluate((handPoints) => {
      const canvas = document.getElementById("skeleton") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      window.__fixture.drawSkeleton(canvas, handPoints as never, "right", {
        mirrored: false,
        minScore: 0.5,
      });

      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
      return n;
    }, rightHandPoints());

    expect(drawn).toBeGreaterThan(0);
  });

  test("手部锚点不全时不画手，尤其不把缺失点当成 (0,0) 画到左上角", async ({ page }) => {
    const result = await page.evaluate(() => {
      const canvas = document.getElementById("skeleton") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 只有掌心三个锚点中的腕，缺 index_mcp / pinky_mcp →
      // 手部绘制路径必须**整体放弃**：半个手比不画更容易被误读为"手就是这样"。
      window.__fixture.drawSkeleton(
        canvas,
        [{ name: "right_hand_wrist", xPx: 100, yPx: 100, score: 0.9, visible: true }] as never,
        "right",
        { mirrored: false, minScore: 0.5 },
      );

      const count = (x0: number, y0: number, w: number, h: number) => {
        const d = ctx.getImageData(x0, y0, w, h).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
        return n;
      };

      return {
        // 左上角 80×80：缺失点若被当成 (0,0) 就会落在这里
        topLeft: count(0, 0, 80, 80),
        // 整块画布：锚点不全时不该画出**任何**手部像素。
        // 这一条比"腕点附近>0"更强 —— 后者原先靠通用关键点循环画手部点来满足，
        // 而那正是把 21 个点糊成一团白的原因（F-021）。
        total: count(0, 0, canvas.width, canvas.height),
      };
    });

    // 关键：不能把缺失关键点当成 (0,0) 画出一簇点
    expect(result.topLeft).toBe(0);
    // 锚点不全 → 手部路径放弃，且通用关键点循环**不替它画**
    expect(result.total, "锚点不全时画出了手部像素 —— 通用关键点循环又把手部点画上了").toBe(0);
    // "绘制确实发生了"由上一条「有手部点时确实画出手部像素」作证：
    // 那一条现在走的是真正的 drawHand（名字已与契约一致）。
  });

  test("手部点不可见（visible=false）时不参与绘制", async ({ page }) => {
    const result = await page.evaluate((handPoints) => {
      const canvas = document.getElementById("skeleton") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const invisible = handPoints.map((p) => ({ ...p, visible: false }));
      window.__fixture.drawSkeleton(canvas, invisible as never, "right", {
        mirrored: false,
        minScore: 0.5,
      });

      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
      return n;
    }, rightHandPoints());

    expect(result).toBe(0);
  });
});
