/**
 * 摄像头中途不可用的界面行为。
 *
 * 为什么需要这个用例：不处理的后果（实测确认过）是**界面撒谎** ——
 * 轨道 `readyState` 已经是 `ended`、画面停在最后一帧，而徽标照样显示
 * "采集中"、状态栏照样说"等待有效挥拍"。用户会一直干等一个不会再来的画面，
 * 而且没有任何线索指向真正的原因。这类"静默失败"是本项目反复出现的形状。
 *
 * 触发方式：直接 `track.stop()`。它不完全等价于拔掉设备，但**恰好覆盖了
 * 最难测的那条路径** —— 实测 `track.stop()` 会立刻把 `readyState` 变成
 * `ended`，却**不派发 `ended`/`mute` 事件**。所以只监听事件的实现会被这个
 * 用例抓住（真实拔设备时浏览器是否派发事件取决于实现，不能只依赖事件）。
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 模型资产在不在。**不在时必须跳过，而不是失败。**
 *
 * 这条纪律本仓库到处都在用（`app.e2e.ts` 的同一句、以及所有 `PPC_VERIFY_VIDEO` 探针），
 * 而这两个用例此前**漏了**它，后果实测过：一份全新克隆（或 CI）上，它们会在
 * "等练习页出现"那里**超时 90 秒**，报错是 `expected 练习, got 拍摄检查` ——
 * 读起来像界面坏了，其实只是**没下模型**（`pnpm models:fetch` 与复制 WASM 是
 * 清单的**阶段 3**，而 `pnpm test:e2e` 在**阶段 2**：照清单顺序做，必然先撞上这个）。
 *
 * 一个"看起来像真缺陷"的假失败，会把真信号淹掉 —— 这比测试少跑两条更糟。
 */
const assetsPresent =
  existsSync(resolve(webRoot, "public/models/pose_landmarker_full.task")) &&
  existsSync(resolve(webRoot, "public/wasm/vision_wasm_internal.js"));

/** 结束页面上那个 <video> 持有的所有轨道，模拟摄像头消失。 */
async function killCameraTracks(page: import("@playwright/test").Page): Promise<void> {
  await page.locator(".stage video").evaluate((el) => {
    const s = (el as HTMLVideoElement).srcObject;
    if (s instanceof MediaStream) for (const t of s.getTracks()) t.stop();
  });
}

test.describe("摄像头中途不可用", () => {
  /** 要走到"开始训练 → 练习页"，必须先有模型资产（同 `app.e2e.ts` 的那句）。 */
  test.skip(
    !assetsPresent,
    "缺少模型资产（apps/web/public/models、apps/web/public/wasm）——" +
      " 先跑 pnpm models:fetch 与复制 WASM，见 docs/local-verification.md 阶段 3",
  );

  test("轨道消失后界面如实报错并停止，不再假装在采集", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/");
    await page.getByRole("button", { name: "开始训练" }).click();
    await expect(page.locator(".tab.active")).toHaveText("练习", { timeout: 90_000 });
    await expect(page.locator(".badge", { hasText: "采集中" })).toBeVisible();

    await killCameraTracks(page);

    // 核心断言：徽标必须从"采集中"变成"已停止"。
    // 停留在"采集中"就是这个缺陷本身。
    await expect(page.locator(".badge", { hasText: "已停止" })).toBeVisible({ timeout: 10_000 });

    // 而且必须给出**原因**。练习页唯一能看到的解释就是这行状态栏 ——
    // 只说"已停止"等于把真相藏起来（这条是修完第一版后补的：
    // 第一版只改了徽标和拍摄检查页的错误框，练习页仍然没有任何提示）。
    await expect(page.locator(".small.muted", { hasText: "摄像头已断开" })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("用户主动停止不会误报成设备断开", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/");
    await page.getByRole("button", { name: "开始训练" }).click();
    await expect(page.locator(".tab.active")).toHaveText("练习", { timeout: 90_000 });

    // 主动停止：也会让轨道 ended，但这不是故障，不该报"已断开"。
    await page.getByRole("button", { name: "停止" }).click();
    await expect(page.locator(".badge", { hasText: "已停止" })).toBeVisible({ timeout: 15_000 });

    // 状态栏应是普通的"已停止"，不能出现故障文案
    await expect(page.locator(".small.muted", { hasText: "摄像头已断开" })).toHaveCount(0);
    // 按钮不能变成 [object Object]（stop 带可选 message 参数时的经典陷阱）
    await expect(page.locator(".small.muted", { hasText: "[object" })).toHaveCount(0);
  });
});
