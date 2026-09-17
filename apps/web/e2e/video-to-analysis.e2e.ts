/**
 * 导入视频的**完整链路**：播完 → 交出本组 → 真的拿到分析结论。
 *
 * ## 用户报的两件事，其实是这条链上的两个断点
 *
 * 1. 「视频导入后一直在轮询播放，反复播放且不会停止」—— `video.loop = true`。
 * 2. 「虽然已加入大模型，但运行后未看到任何评估结果返回」—— 两个原因叠在一起：
 *    - 后端起没起（`pnpm dev` 只起前端，见界面上的「后端未连接」提示）；
 *    - **即使后端起了也不会出结果**：组边界 `strokesPerGroup` 默认 3，
 *      而成组只在凑满时发生 —— 一段有限长的素材很可能只检出 1~2 次挥拍，
 *      于是**永远等不到第三拍**，一次请求都不会发出去。
 *
 * 这个文件钉住第 2 条里的后半段（前半段是环境问题，由界面提示兜底）：
 * **素材播完是硬事实，它优先于"这组还差几次挥拍"**。
 *
 * 走的是 mock 模式的真实 API 进程（见 playwright.config.ts）：
 * 这里要验的是"请求发出去了、回来了、渲染出来了"，不是模型质量。
 *
 * 需要 `PPC_VERIFY_VIDEO` 指向一段真实视频，缺失时 skip。
 */

import { existsSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { feedbackStatusSchema } from "@pingpong/contracts";

const VIDEO = process.env.PPC_VERIFY_VIDEO ?? "";
const hasVideo = VIDEO !== "" && existsSync(VIDEO);

/** 切到「导入视频」并选文件。 */
async function importVideo(page: Page, file: string): Promise<void> {
  const selects = page.locator("select");
  for (let i = 0, n = await selects.count(); i < n; i++) {
    const opts = await selects.nth(i).locator("option").allTextContents();
    if (opts.includes("导入视频")) {
      await selects.nth(i).selectOption({ label: "导入视频" });
      break;
    }
  }
  await page.locator('input[type="file"]').setInputFiles(file);
}

test.describe("导入视频 · 播完必须出结论", () => {
  test.skip(!hasVideo, "未提供 PPC_VERIFY_VIDEO（真实视频），跳过");

  test("播完之后：视频停住不再循环，并且真的发起了一次分析", async ({ page }) => {
    test.setTimeout(300_000);

    await page.goto("/");
    await importVideo(page, VIDEO);
    await page.getByRole("button", { name: "开始训练" }).click();
    await expect(page.locator(".badge", { hasText: "采集中" })).toBeVisible({ timeout: 120_000 });

    // 状态栏会写"视频已播放完毕…"。等它出现就等于等到了 `ended` 被处理。
    // 状态栏没有专属 class（就是一行 `.small`），所以按正文找 —— 不依赖位置。
    await expect
      .poll(async () => (await page.locator("body").innerText()).includes("播放完毕"), {
        timeout: 180_000,
        message: "素材播完了但状态栏没有反应 —— `ended` 没有被处理",
      })
      .toBe(true);

    // ① 不许循环：停住之后时间轴不能自己往回走
    const el = page.locator(".stage video");
    const t1 = await el.evaluate((v) => (v as HTMLVideoElement).currentTime);
    expect(await el.evaluate((v) => (v as HTMLVideoElement).paused), "播完应当停住").toBe(true);
    await page.waitForTimeout(2000);
    const t2 = await el.evaluate((v) => (v as HTMLVideoElement).currentTime);
    expect(t2, "播完又自己播起来了 —— 这就是用户报的「反复播放且不会停止」").toBe(t1);
    expect(await el.evaluate((v) => (v as HTMLVideoElement).loop), "loop 被重新打开了").toBe(false);

    // ② 真的发起了分析并拿到结论
    // 注意是 `tab` 不是 `button`：顶栏那几个按钮都显式设了 `role="tab"`，
    // 于是它们在可访问性树里**不再是 button**（第一版就写错了，白等 5 分钟）。
    await page.getByRole("tab", { name: /^复查/ }).click();
    const rows = page.locator("table tbody tr");
    await expect
      .poll(async () => rows.count(), {
        timeout: 120_000,
        message: "复查页一条记录都没有 —— 说明一次请求都没发出去（素材播完时本组没有被交出去）",
      })
      .toBeGreaterThan(0);

    // 状态列：成功时是模型的结论状态，失败时是错误码或字面的「无结果」。
    const badge = rows.first().locator("td").nth(1).locator(".badge");
    const verdict = ((await badge.textContent()) ?? "").trim();
    expect(verdict, "本组没有拿到任何结论，复查页只显示「无结果」—— 这正是用户看到的现象").not.toBe(
      "无结果",
    );
    // 用契约里的枚举，不自己抄一份：抄的那份迟早会漏掉新增的状态
    // （第一版就漏了 `observation_only`，于是把一次成功的分析判成了失败）
    expect(
      [...feedbackStatusSchema.options],
      `结论状态不是契约里的四档之一，而是「${verdict}」`,
    ).toContain(verdict);

    /*
     * ③ 关键帧那一栏必须**说出这张图是哪一板、锚在哪个事件上偏了多少**（R4）。
     *
     * 为什么断言"先有图"再断言"图上有话"：如果图本来就是空的，下面那两条会**空转通过** ——
     * 而"通过条件不需要被验的行为也能满足"是本仓库栽过好几次的形态（F-029 的教训）。
     * 真实导入链路会走产品的 `KeyframeCapturer`，所以这里图应当非空；
     * 真的空了就该红，那是 F-028 那一类"图片链路断了"的信号。
     */
    const kfGrid = page.locator(".kf-grid .kf");
    await expect
      .poll(async () => kfGrid.count(), {
        timeout: 30_000,
        message: "复查页一张关键帧都没有 —— 图片链路没接通，下面的断言只会空转",
      })
      .toBeGreaterThan(0);
    const metas = await kfGrid.locator(".meta").allTextContents();
    expect(
      metas.some((m) => m.includes("板 ") && m.includes("距事件")),
      `关键帧没写清属于哪一板、锚在哪个事件上，页面上是：${JSON.stringify(metas)}`,
    ).toBe(true);
  });
});
