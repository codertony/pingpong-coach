/**
 * 「选设备」这条修法到底通不通（F-009 的验证，走**产品界面**而不是裸 API）。
 *
 * 背景：F-009 是**间歇性**的摄像头启动失败 —— 同一台 `HIK 2K USB CAMERA`、同一套约束，
 * 实测过一个时刻超时 8005ms、约 1.5 小时后起流 2926ms；默认设备那条路同样时好时坏。
 * 所以"产品到底能不能拿到画面"**不能靠单次裸 `getUserMedia` 回答**，得走产品自己的链路、
 * 挑一台当下能用的设备来测。
 *
 * 拍摄检查页的「摄像头设备」下拉**本来就存在**（`videoDeviceId` → `startCapture({deviceId})`
 * → `getUserMedia({deviceId: {exact}})`），但**从来没有一条测试证明它真的能让产品拿到画面**。
 *
 * 与 `camera-enumeration.e2e.ts` 的分工：那个探的是**裸 `getUserMedia` + 逐设备试开**
 * （回答"哪台设备能起流"）；这条探的是**产品链路** —— 在下拉里选中某台设备之后，
 * 采集流有没有真的接到界面上那个 `<video>` 上（F-008 的那条缝）。
 * 两者都要：设备能起流 ≠ 产品接得上。
 *
 * ⚠️ 需要真实摄像头，且会**短暂弹出浏览器窗口并亮起摄像头**。未设 `PPC_PROBE_CAMERA=1` 时 skip。
 */

import { existsSync } from "node:fs";
import { chromium, test, expect } from "@playwright/test";

const ENABLED = process.env.PPC_PROBE_CAMERA === "1";

/** 单台设备的尝试上限（引擎初始化 + 取流）。起不来的设备不能把整个探针挂住。 */
const PER_DEVICE_TIMEOUT_MS = Number(process.env.PPC_CAMERA_TIMEOUT_MS ?? 20_000);

/** 真实浏览器可执行文件。与 `camera-enumeration.e2e.ts` 同一套探测顺序。 */
function resolveChrome(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.find((p) => existsSync(p));
}

test.describe("摄像头设备选择（产品链路）", () => {
  test.skip(!ENABLED, "未设置 PPC_PROBE_CAMERA=1（需要真实摄像头），跳过");

  test("在下拉里选中一台设备之后，产品真的拿到画面", async () => {
    test.setTimeout(600_000);

    const executablePath = resolveChrome();
    const browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      // 只自动接受权限弹窗，**不**替换设备 —— 换掉设备这条就白测了
      args: ["--use-fake-ui-for-media-stream"],
    });

    try {
      const page = await browser.newPage();
      await page.goto("/");

      // 没有权限时浏览器不返回 deviceId / 设备名，下拉是**不渲染**的（selectableCameras 为空）。
      // 所以先点「授权并刷新设备名」。
      await page.getByRole("button", { name: "授权并刷新设备名" }).click();
      const select = page.getByLabel("摄像头设备");
      await expect(select).toBeVisible({ timeout: 15_000 });

      const options = await select
        .locator("option")
        .evaluateAll((els) =>
          els
            .map((e) => ({ value: (e as HTMLOptionElement).value, label: e.textContent ?? "" }))
            .filter((o) => o.value !== ""),
        );
      expect(options.length, "下拉里一台设备都没有 —— 与 F-009 的前提不符").toBeGreaterThan(0);

      const rows: Array<{ label: string; ok: boolean; detail: string }> = [];

      for (const opt of options) {
        await select.selectOption(opt.value);
        await page.getByRole("button", { name: "开始训练" }).click();

        /**
         * 两种结局都要等：成功 = 切到练习页且徽标「采集中」；
         * 失败 = 留在拍摄检查页并给出 `.notice.danger`（消息 + 可操作建议 + 原始错误）。
         * 用 60s 是因为引擎初始化 + 某些设备要 6~8s 才出第一帧。
         */
        const success = await Promise.race([
          page
            .waitForSelector(".badge:has-text('采集中')", { timeout: PER_DEVICE_TIMEOUT_MS })
            .then(() => true)
            .catch(() => false),
          page
            .waitForSelector(".notice.danger", { timeout: PER_DEVICE_TIMEOUT_MS })
            .then(() => false)
            .catch(() => false),
        ]);

        if (success) {
          // 关键断言：**采集流真的接到了界面上那个 `<video>`**（F-008 的那条缝）。
          const size = await page.locator(".stage video").evaluate((el) => ({
            w: (el as HTMLVideoElement).videoWidth,
            h: (el as HTMLVideoElement).videoHeight,
          }));
          rows.push({ label: opt.label, ok: size.w > 0, detail: `${size.w}×${size.h}` });
          await page.getByRole("button", { name: "停止" }).click();
          await page.getByRole("tab", { name: "拍摄检查" }).click();
          if (size.w > 0) break; // 只要证明「选设备 → 有画面」这一条通即可
        } else {
          const detail = await page
            .locator(".notice.danger")
            .evaluate((el) => (el.textContent ?? "").replace(/\s+/g, " ").slice(0, 90));
          rows.push({ label: opt.label, ok: false, detail });
          await page.getByRole("tab", { name: "拍摄检查" }).click();
        }
      }

      const table = rows.map((r) => `  ${r.ok ? "✅" : "❌"} ${r.label} — ${r.detail}`).join("\n");
      // 用 warn 而不是 log：本仓库的 eslint 只放行 warn/error（与另两个探针一致）
      console.warn(`[camera-picker] 逐设备走产品链路：\n${table}`);

      // 1) **至少一台设备**能让产品拿到画面 —— 这就是 F-009 那条修法的正面证据。
      expect(
        rows.some((r) => r.ok),
        `没有任何一台设备能让产品拿到画面（下拉里试了 ${options.length} 台）：\n${table}`,
      ).toBe(true);

      // 2) 起不来的那些必须**给出可操作的错误**，不能静默停在「等待有效挥拍」。
      //    这条守的是 F-009 的原始症状：界面对失败不给任何线索。
      for (const r of rows.filter((x) => !x.ok)) {
        expect(r.detail.length, `设备「${r.label}」失败了却没给出任何文案`).toBeGreaterThan(0);
      }
    } finally {
      await browser.close();
    }
  });
});
