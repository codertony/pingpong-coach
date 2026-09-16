/**
 * 导入视频：**画面与分析必须同步**（F-040）。
 *
 * ## 用户报的现象
 *
 * 「导入视频，视频已经停止了，框架还在移动」。
 *
 * ## 根因
 *
 * 摄像头那条路是「离屏元素采集 + 界面元素显示**同一路 MediaStream**」，
 * 两边共享一个流，天然同步。**导入视频没有流** —— 原先给它单独
 * `el.src = handle.video.src`，于是同一个文件被**播了两遍**：
 *
 * | 元素 | 用途 | loop |
 * | --- | --- | --- |
 * | 离屏（`document.createElement`）| 喂分析（rVFC → 推理 → 叠加层）| **true** |
 * | 界面上的 `<video>` | 只负责显示 | false（默认）|
 *
 * 两者各自计时、互不影响。于是**界面上的那段播完停住了，而喂分析的还在循环**
 * —— 叠加层当然继续动。用户看到的就是"视频停了，骨架还在动"。
 *
 * ## 修法
 *
 * 导入视频时把**采集元素本身**挂进 `.stage` —— 只有一个播放实例，
 * 画面与分析永远是同一帧。
 *
 * ## 这个文件钉住的两件事
 *
 * 1. **结构**：`.stage` 里只能有 **1 个** `<video>`。有人再引入第二路播放时立刻红。
 * 2. **行为**：视频一停，叠加层必须在很短的时间内**停止变化**
 *    （修复前实测每秒画 31 次；修复后剩余 26 次调用全部发生在暂停后 2ms 内）。
 *
 * 需要 `PPC_VERIFY_VIDEO` 指向一段真实视频，缺失时 skip。
 */

import { existsSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const VIDEO = process.env.PPC_VERIFY_VIDEO ?? "";
const hasVideo = VIDEO !== "" && existsSync(VIDEO);

/**
 * 画布内容的指纹（逐像素哈希 + 非透明像素数）。
 *
 * 只看"有没有像素"不够 —— 修复前的现象正是**像素数在变**。
 */
async function overlayFingerprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".stage canvas");
    if (!c || c.width === 0) return "no-canvas";
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let h = 2166136261;
    let nz = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] !== 0) nz++;
      h ^= d[i]! + d[i + 1]! * 3 + d[i + 2]! * 7 + d[i + 3]! * 11;
      h = Math.imul(h, 16777619);
    }
    return `${(h >>> 0).toString(16)}/nz=${nz}`;
  });
}

test.describe("导入视频 · 画面与分析同步（F-040）", () => {
  test.skip(!hasVideo, "未提供 PPC_VERIFY_VIDEO（真实视频），跳过");

  test("视频暂停后，叠加层必须停止变化；且 .stage 里只有一个 <video>", async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto("/");
    // 「导入视频」那个 select（不要假定它是第几个）
    const selects = page.locator("select");
    for (let i = 0, n = await selects.count(); i < n; i++) {
      const opts = await selects.nth(i).locator("option").allTextContents();
      if (opts.includes("导入视频")) {
        await selects.nth(i).selectOption({ label: "导入视频" });
        break;
      }
    }
    await page.locator('input[type="file"]').setInputFiles(VIDEO);
    await page.getByRole("button", { name: "开始训练" }).click();
    await expect(page.locator(".badge", { hasText: "采集中" })).toBeVisible({ timeout: 120_000 });

    // ① 结构断言：显示与采集必须是同一个元素，所以只能有一个
    await expect(
      page.locator(".stage video"),
      "`.stage` 里出现了多个 <video> —— 显示与采集又变成两路播放了（正是 F-040 的成因）",
    ).toHaveCount(1);

    // 等叠加层真的画出东西（否则"没变化"是废话）。
    // ⚠️ 判据必须是 `nz>0`，不能是"指纹不等于某个字符串" —— 哈希每次都不同，
    // 那种轮询会在第一帧就立刻返回（第一版就写错了，白等 3 秒拿到 nz=0）。
    await expect
      .poll(async () => (await overlayFingerprint(page)).includes("nz=0") === false, {
        timeout: 90_000,
        message: "叠加层一直没有画出内容（模型没加载？视频没播？）",
      })
      .toBe(true);

    // 视频得真的在走，否则"暂停后不变"没有意义
    const t1 = await page
      .locator(".stage video")
      .evaluate((el) => (el as HTMLVideoElement).currentTime);
    await page.waitForTimeout(600);
    const t2 = await page
      .locator(".stage video")
      .evaluate((el) => (el as HTMLVideoElement).currentTime);
    expect(t2, "视频没有在播放，这条用例测不到东西").toBeGreaterThan(t1);

    await page.waitForTimeout(1500);
    const beforePause = await overlayFingerprint(page);
    expect(beforePause, "暂停前叠加层是空的").not.toContain("nz=0");

    // ② 行为断言：暂停视频 → 叠加层停止变化
    await page.locator(".stage video").evaluate((el) => (el as HTMLVideoElement).pause());
    // 给在途帧一点时间排空（实测修复后 2ms 内就画完了）
    await page.waitForTimeout(1000);
    const afterPause = await overlayFingerprint(page);
    await page.waitForTimeout(1500);
    const later = await overlayFingerprint(page);

    expect(later, "视频已经停了，叠加层还在变 —— 画面与分析又不同步了（F-040 复发）").toBe(
      afterPause,
    );
    // 暂停后画的最后一帧应当就是暂停那一刻的画面（不是清空）
    expect(later).not.toContain("nz=0");
  });
});
