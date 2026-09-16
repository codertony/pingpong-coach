/**
 * **真实摄像头链路**：用「把一个真实视频文件当成摄像头」的方式，
 * 让产品自己那条 `getUserMedia → MediaStream → <video> → 调度器 → Worker → 叠加层`
 * 的路径跑在**真人画面**上。
 *
 * ## 为什么需要它（F-006 / F-009 到底卡住了什么）
 *
 * 本项目此前所有 e2e 用的都是 `--use-fake-device-for-media-stream` 的**合成图案** ——
 * 那上面**没有人**，于是 `detected` 恒为 `false`，画布每帧都被清空，
 * **叠加层一次都没在真实画面上画过**。这就是 F-006 里"骨架是否贴合"始终只能
 * 靠离线抽帧目视、而不能在活链路里断言的原因。
 *
 * Chrome 还有另一个开关：`--use-file-for-fake-video-capture=<file.y4m>` ——
 * 它让 `getUserMedia` 返回**文件里的帧**。配上真实挥拍素材，整条活链路
 * 就跑在真人画面上，不需要本机有可用的摄像头（那正是 F-009 卡住的东西）。
 *
 * ⇒ 这两件事被分开了：
 *   - **链路是否成立**（有真人时会不会检出、会不会画）—— 本用例，机器可判；
 *   - **你这台机器的摄像头能不能起来** —— 仍是 F-009，只有你能修。
 *
 * ## 断言为什么落在画布像素上
 *
 * 界面上的徽标会显示"采集中"，而采集到合成图案时它**一样显示"采集中"** ——
 * 那个徽标证明不了有真人。画布则分得清：`App.tsx` 在 `detected` 为假时
 * `clearRect`，为真时才 `drawSkeleton`。所以"画布上出现了骨架专用的颜色"
 * 等价于"活链路上真的检出了人"。
 *
 * 蓝色（`#4ea1ff`，持拍侧骨链与手部）**只有骨架画**；
 * 绿色（`rgba(63,185,80)`）只有准备区画，而准备区半径依赖实测体尺度
 * （肩+髋，见 F-032），所以绿色出现本身也是"关键点落到了躯干上"的证据。
 * 灰色/琥珀色是低置信度与另一侧，刻意**不**计入蓝色判据 —— 否则
 * "画了点低置信度噪声"也会算通过。
 *
 * ## 反向对照（同一个文件里的第二个用例）
 *
 * 光有"真素材上出现骨架"还不够 —— 得排除"这个判据本身恒真"。
 * 所以第二个用例**去掉文件开关**（退回合成图案，画面上没有人）。
 *
 * ⚠️ 但它**不能**断言"一个骨架像素都没有"：实测合成图案上 MediaPipe 会
 * **偶发误检**，而且幅度不比真人小多少（量到过单帧 71 像素 vs 真人 135~198）。
 * 真正能分开真假的是**时间占比**：真人在素材里逐帧都在（离线回放量到
 * 检出 244/244），幻觉是零星的。所以两条用例量的都是"出现率"：
 * 真人要求 ≥70%，无人要求 <30%。
 *
 * 需要 `PPC_FAKE_CAMERA_Y4M=<y4m 绝对路径>`，否则 skip。
 * 该文件由真实素材转出、**含真人画面**，必须放在 git 之外
 * （见 `evaluation/samples.json` 的 `dataPolicy.notInRepo`）
 * —— 默认输出目录 `apps/web/.tmp-fakecam/` 已被 `.gitignore` 忽略。
 *
 * 生成方式（ffmpeg，本机已具备）：
 *   mkdir -p apps/web/.tmp-fakecam
 *   ffmpeg -y -i <素材> -vf "scale=640:360:flags=lanczos,fps=30" \
 *     -pix_fmt yuv420p -f yuv4mpegpipe apps/web/.tmp-fakecam/clip.y4m
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium, test, expect, type Page } from "@playwright/test";

const Y4M_ARG = process.env.PPC_FAKE_CAMERA_Y4M ?? "";
const Y4M_PATH = Y4M_ARG ? resolve(Y4M_ARG) : "";
const ENABLED = Y4M_PATH !== "" && existsSync(Y4M_PATH);

/** 真实浏览器可执行文件。与 playwright.config.ts / camera-enumeration 同一套探测顺序。 */
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

/** 起一个只带指定摄像头开关的浏览器（绕开项目级 launchOptions）。 */
async function launchWith(args: string[]) {
  const executablePath = resolveChrome();
  return chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--use-fake-ui-for-media-stream", ...args],
  });
}

/**
 * 数画布上的两类像素。
 *
 * 采样步长 3：判据看的是"有没有"，不是精确面积，隔点采样足够且快得多
 * （640×360 逐点取 23 万像素，在每次轮询里做会明显拖慢）。
 */
async function countOverlayPixels(
  page: Page,
): Promise<{ skeleton: number; readyZone: number; sampled: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".stage canvas");
    if (!canvas || canvas.width === 0) return { skeleton: 0, readyZone: 0, sampled: 0 };
    const ctx = canvas.getContext("2d");
    if (!ctx) return { skeleton: 0, readyZone: 0, sampled: 0 };
    const { width: w, height: h } = canvas;
    const data = ctx.getImageData(0, 0, w, h).data;

    let skeleton = 0;
    let readyZone = 0;
    let sampled = 0;
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const i = (y * w + x) * 4;
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        const a = data[i + 3] ?? 0;
        if (a === 0) continue;
        sampled++;
        // 骨架蓝：`#4ea1ff` 与 `rgba(78,161,255,.85)`。琥珀/灰/绿都不会落进来。
        if (b >= 190 && b - r >= 90 && b - g >= 50) skeleton++;
        // 准备区绿：`rgba(63,185,80,.9)`
        else if (g - r >= 50 && g - b >= 50 && g >= 120) readyZone++;
      }
    }
    return { skeleton, readyZone, sampled };
  });
}

/** 走一遍真实的界面路径：开始训练 → 练习页 → 采集中。 */
async function startTraining(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "开始训练" }).click();
  await expect(page.locator(".tab.active")).toHaveText("练习", { timeout: 120_000 });
  await expect(page.locator(".badge", { hasText: "采集中" })).toBeVisible({ timeout: 120_000 });
}

/**
 * 连续采样 n 次（每次间隔 intervalMs），统计"有多少次画出了骨架 / 准备区"。
 *
 * 量的是**时间占比**而不是单帧幅度 —— 理由见真人那条用例里的长注释：
 * 真人单帧与幻觉单帧的像素量只差不到两倍，"有没有像素"分不开它们，
 * 但"是不是持续"能分开。
 */
async function sampleOverlay(
  page: Page,
  n: number,
  intervalMs: number,
): Promise<{
  n: number;
  skeletonFrames: number;
  readyZoneFrames: number;
  maxSkeleton: number;
  maxReadyZone: number;
}> {
  let skeletonFrames = 0;
  let readyZoneFrames = 0;
  let maxSkeleton = 0;
  let maxReadyZone = 0;
  for (let i = 0; i < n; i++) {
    await page.waitForTimeout(intervalMs);
    const c = await countOverlayPixels(page);
    if (c.skeleton > 0) skeletonFrames++;
    if (c.readyZone > 0) readyZoneFrames++;
    maxSkeleton = Math.max(maxSkeleton, c.skeleton);
    maxReadyZone = Math.max(maxReadyZone, c.readyZone);
  }
  return { n, skeletonFrames, readyZoneFrames, maxSkeleton, maxReadyZone };
}

test.describe("真实摄像头链路 · 文件当摄像头", () => {
  test.skip(
    !ENABLED,
    "未提供 PPC_FAKE_CAMERA_Y4M（真实素材转出的 y4m），跳过 —— 见本文件顶部的生成方式",
  );

  test("真人画面走完整条活链路：持续检出人体、画出骨架、标定准备区", async () => {
    test.setTimeout(300_000);

    const browser = await launchWith([
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${Y4M_PATH}`,
    ]);

    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await startTraining(page);

      // 先等第一帧骨架。放宽到 90s：要含模型加载 + GPU 初始化 + 前几帧推理。
      let waited = 0;
      while (waited < 90_000) {
        await page.waitForTimeout(1_000);
        waited += 1_000;
        if ((await countOverlayPixels(page)).skeleton > 0) break;
      }

      /**
       * ⚠️ **判据是"持续"，不是"有没有"** —— 这一点是被数据纠正过的。
       *
       * 第一版只断言"某个采样帧上骨架像素 > 0"。实测发现这**不够**：
       * 合成图案（画面上没有人）上 MediaPipe 偶发误检，峰值能到 **71** 像素，
       * 而真人画面的**单帧**只有 135~198 —— 两者不足两倍之差，
       * "有没有像素"根本分不开真实与幻觉。
       *
       * 分开它们的是**时间占比**：真人在这段素材里逐帧都在（离线回放量到
       * 检出 **244/244**），幻觉则是零星几帧。所以这里量的是
       * "20 次采样里有多少次画出了骨架"。
       */
      const samples = await sampleOverlay(page, 20, 500);

      console.warn(
        `[live-capture] 真人画面：骨架出现率 ${samples.skeletonFrames}/${samples.n}` +
          `（单帧峰值 ${samples.maxSkeleton}）、准备区出现率 ${samples.readyZoneFrames}/${samples.n}`,
      );

      expect(
        samples.skeletonFrames,
        `活链路上骨架只出现在 ${samples.skeletonFrames}/${samples.n} 次采样里 —— ` +
          `真人素材应当逐帧都在（离线回放量到 244/244）`,
      ).toBeGreaterThanOrEqual(Math.ceil(samples.n * 0.7));

      // 准备区绿：它的半径依赖实测体尺度（肩+髋），所以它出现
      // 说明关键点落到了躯干上，而不只是随手画了个圈。
      expect(
        samples.readyZoneFrames,
        "准备区很少出现 —— 体尺度（肩+髋）没稳定测到",
      ).toBeGreaterThan(0);

      // 「未检测到持拍手腕」这行提示必须消失。它是界面对"有没有检出人"的
      // 另一种表述，且和骨架像素走的是两条不同的代码路径，互为交叉验证。
      await expect(page.locator(".small", { hasText: "未检测到持拍手腕" })).toHaveCount(0);

      // 端到端延迟必须是一个真的数（F-024 修好后它才不是 0）。
      const latency = await page.locator("text=/端到端处理延迟 P95/").first().textContent();
      expect(latency, "延迟行没找到").toBeTruthy();

      // 留一张现场图给人工看（含真人画面 → 落在 git 之外的临时目录，
      // 即 y4m 自己所在的那个目录，已被 `.gitignore` 的 `.tmp-*/` 覆盖）。
      await page.locator(".stage").screenshot({
        path: resolve(dirname(Y4M_PATH), "live-capture.png"),
      });
    } finally {
      await browser.close();
    }
  });

  test("反向对照：合成图案（画面上没有人）上，骨架只允许零星出现", async () => {
    test.setTimeout(180_000);

    // 只有 fake device，**不带**文件开关 → 合成滚动图案，没有人。
    const browser = await launchWith(["--use-fake-device-for-media-stream"]);

    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await startTraining(page);

      /**
       * 为什么这里**不是**断言 `=== 0`：实测发现合成图案上 MediaPipe 会
       * **偶发误检**，而且幅度**不比真人小多少** —— 量到过单帧骨架
       * **71** 像素，而真人单帧只有 **135~198**。不到两倍之差。
       *
       * 所以"有没有像素"这条判据**本身就不够用**，这也是上一条用例改成量
       * **出现率**的原因。这里同样量出现率：幻觉是零星的，真人是持续的。
       *
       * 钉成 `=== 0` 会让这条用例随模型心情时红时绿 —— 而
       * "被绕过的门禁等于没有门禁"，那种测试最后一定会被人删掉。
       *
       * ⚠️ 这条对照还顺带量到过一个**真实缺陷（F-036）**：合成图案上
       * **准备区圆稳定画出来（当时 10/20），而骨架只零星出现（1/20）** ——
       * 屏幕在画一个"它几乎不肯承认看得见"的身体的约束圈。
       * 根因是同一件事实（"这具身体看得清吗"）在 `findPoint`
       * （只挡 `visible === false`，而 `visible` 是 `confidence > 0`）
       * 与绘制层（要求 ≥ 0.5）处口径不同。
       *
       * **已修**：体尺度改用与绘制层同一个常量。修后在真实素材上
       * **一帧都没掉**（躯干四点最低置信度实测 0.985，244 帧全部 ≥0.5），
       * 而这里的准备区出现率从 10/20 掉到 **0/20**。
       * 见 `docs/known-failures.md` F-036。
       */
      const samples = await sampleOverlay(page, 20, 500);

      console.warn(
        `[live-capture] 合成图案（无人）：骨架出现率 ${samples.skeletonFrames}/${samples.n}` +
          `（单帧峰值 ${samples.maxSkeleton}）、准备区出现率 ${samples.readyZoneFrames}/${samples.n}`,
      );

      // 上限取 30%：真人那条要求 ≥70%，两条合起来才说明"出现率能分开真假"。
      // 中间留了 40 个百分点的空档 —— 偶发误检不会把这条撞红。
      expect(
        samples.skeletonFrames,
        `合成图案（无人）上骨架出现在 ${samples.skeletonFrames}/${samples.n} 次采样里 —— ` +
          `与真人的"持续出现"没有区别了，说明上一条用例的通过没有意义`,
      ).toBeLessThan(Math.floor(samples.n * 0.3));

      // 这一条是 **F-036 的活链路回归**：准备区圆的半径来自体尺度，
      // 而体尺度**只有置信度够的躯干点**才算得出来（与绘制层同一个门槛）。
      // 修之前这里量到过 **10/20** —— 屏幕上画着一个"它不肯承认看得见"的
      // 身体的约束圈；修之后是 0/20。把体尺度那个门槛去掉，这条立刻红。
      expect(
        samples.readyZoneFrames,
        `合成图案（无人）上准备区圆画出了 ${samples.readyZoneFrames}/${samples.n} 次 —— ` +
          `圈的半径来自一个置信度不够的身体（F-036）`,
      ).toBeLessThan(Math.floor(samples.n * 0.3));

      // 反向对照里状态栏必须如实说"没看到人"。这一条与像素无关，
      // 是另一条独立路径上的同一事实（互相印证）。
      await expect(page.locator(".small.muted", { hasText: "未检测到人体" })).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
