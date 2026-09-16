/**
 * App 整页链路：真实浏览器 + 真实模型 + 假摄像头。
 *
 * 与其它 e2e 的分工：`canvas` / `pose-engine` / `worker` 三个文件测的是**模块级**行为，
 * 夹具把模块直接挂到 `window.__fixture` 上，绕开了界面接线本身；
 * 这里测的是**整页真实链路** —— 从拍摄检查页点「开始训练」到练习页出画面。
 *
 * 它守着两个只在整页串联时才会暴露的缺陷（见 docs/known-failures.md F-007 / F-008）：
 * - F-007：姿态引擎能否在模块 Worker 里真正就绪（WASM 加载器与模型权重都下载得到）；
 * - F-008：采集流是否真的接到了**界面上**那个 `<video>` ——
 *   采集用的是离屏元素，两者是两回事，接错地方的表现就是推理照跑、画面全黑。
 *
 * ⚠️ 需要真实模型资产。CI 与受限网络下 `storage.googleapis.com` 不可达（F-006），
 * 缺资产时整体 skip —— 不伪装成通过。
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const assetsPresent =
  existsSync(resolve(webRoot, "public/models/pose_landmarker_full.task")) &&
  existsSync(resolve(webRoot, "public/wasm/vision_wasm_internal.js"));

/** 读练习页那个 <video> 的真实接线状态。 */
function readStageVideo(page: Page) {
  return page.locator(".stage video").evaluate((el) => {
    const video = el as HTMLVideoElement;
    const stream = video.srcObject;
    return {
      isStream: stream instanceof MediaStream,
      tracks: stream instanceof MediaStream ? stream.getVideoTracks().length : 0,
      width: video.videoWidth,
      height: video.videoHeight,
      paused: video.paused,
    };
  });
}

test.describe("App 整页链路", () => {
  test.skip(
    !assetsPresent,
    "缺少模型资产（apps/web/public/models、apps/web/public/wasm）—— 见 docs/known-failures.md F-006",
  );

  test("点开始训练后：引擎真实就绪，练习页拿到实时画面", async ({ page }) => {
    // 首次要下载约 9 MB 模型 + 11 MB WASM，并完成委托初始化
    test.setTimeout(120_000);

    await page.goto("/");
    await page.getByRole("button", { name: "开始训练" }).click();

    // F-007 回归：引擎初始化失败时 start() 会静默返回，界面永远停在「拍摄检查」页，
    // 而失败文案还会误指向 models:fetch。能切到「练习」页说明 init() 真的 ready 了。
    await expect(page.locator(".tab.active")).toHaveText("练习", { timeout: 90_000 });
    await expect(page.locator(".badge", { hasText: "采集中" })).toBeVisible();

    // F-007 的更深一层证据：遥测里出现实测频率，说明 detectForVideo 确实在跑，
    // 而不是只加载了模型就报 ready。
    await expect
      .poll(() => page.locator(".metric", { hasText: "实测处理频率" }).innerText(), {
        timeout: 60_000,
      })
      .toContain("fps");

    // F-008 回归：离屏的那个 video 有流，不代表界面上这个有。
    await expect
      .poll(async () => (await readStageVideo(page)).width, { timeout: 30_000 })
      .toBeGreaterThan(0);

    const stage = await readStageVideo(page);
    expect(stage.isStream).toBe(true);
    expect(stage.tracks).toBe(1);
    expect(stage.paused).toBe(false);

    // F-010 回归：骨架在**绘制层**做了水平镜像，预览这一侧必须做同样的镜像，
    // 否则骨架会与人物左右相反（看起来像"骨架贴不上人"）。
    const flip = await page.locator(".stage video").evaluate((el) => {
      const m = getComputedStyle(el as HTMLVideoElement).transform.match(/matrix\(([^)]+)\)/);
      if (!m) return null;
      const n = m[1]!.split(",").map((v) => Number(v.trim()));
      return { a: n[0], d: n[3], tx: n[4] };
    });
    expect(flip?.a).toBe(-1);
    expect(flip?.d).toBe(1);
    expect(flip?.tx).toBe(0);
  });

  test("停止后摄像头轨道被真正关闭", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/");
    await page.getByRole("button", { name: "开始训练" }).click();
    await expect(page.locator(".tab.active")).toHaveText("练习", { timeout: 90_000 });

    // 读轨道自身的状态，而不是轨道条数：界面上的 <video> 与离屏元素共用同一个
    // MediaStream，停止后它仍持有那个已结束的流（保留最后一帧），条数不会归零。
    const trackState = () =>
      page.locator(".stage video").evaluate((el) => {
        const stream = (el as HTMLVideoElement).srcObject;
        const track = stream instanceof MediaStream ? stream.getVideoTracks()[0] : null;
        return track?.readyState ?? "none";
      });

    expect(await trackState()).toBe("live");

    await page.getByRole("button", { name: "停止" }).click();

    // 多了一个元素持有同一个流之后，最容易漏的就是关闭时只停了离屏那份。
    // 轨道必须真的 ended，否则摄像头指示灯不会灭。
    await expect.poll(trackState, { timeout: 15_000 }).toBe("ended");
    await expect(page.locator(".badge", { hasText: "已停止" })).toBeVisible();
  });
});

/**
 * F-013 回归：导入视频的镜像必须可切换，且两侧同步。
 *
 * 为什么需要这个开关：镜像只与**素材怎么拍的**有关 —— 手机自拍录的片段需要镜像，
 * 别人从对面拍的则不需要，二者像素上完全一样，程序分辨不出来。
 * 写死任何一边都会把另一半用错，而错了的表现是"骨架与人物左右相反"，
 * 看上去像识别故障。
 *
 * 这条用例守的正是 F-010/F-013 那个坑的形状：`mirrored` 必须**两侧取同一个值** ——
 * 预览的 class 与绘制层共用同一个表达式，改开关时两边一起变。
 */
/**
 * 真实挥拍素材的路径。未提供 `PPC_VERIFY_VIDEO` 时相关用例 skip —— 不伪装成通过。
 * 素材含个人信息，**不随仓库分发**，必须由使用者自己指定。
 */
const VIDEO = process.env.PPC_VERIFY_VIDEO ?? "";

test.describe("导入视频镜像开关（F-013）", () => {
  test("开关切换后，预览的翻转真的随之消失", async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(!VIDEO || !existsSync(VIDEO), "未提供 PPC_VERIFY_VIDEO（真实挥拍素材），跳过");

    await page.goto("/");
    await page
      .locator('select:has(option:text-is("导入视频"))')
      .selectOption({ label: "导入视频" });
    await page.locator('input[type="file"]').setInputFiles(VIDEO);

    // 读的是**实际计算样式**，不是控件取值 ——
    // 控件对了但样式没跟上，正是 F-010/F-013 那个坑的形状。
    const readFlip = () =>
      page.locator(".stage video").evaluate((el) => {
        const t = getComputedStyle(el as HTMLVideoElement).transform;
        return t.includes("matrix(-1");
      });

    await page.getByRole("button", { name: "开始训练" }).click();
    await expect(page.locator(".tab.active")).toHaveText("练习", { timeout: 90_000 });
    // 默认镜像（自拍视角）
    await expect.poll(readFlip, { timeout: 15_000 }).toBe(true);

    // 回设置页改成"不镜像"
    await page.locator(".tab", { hasText: "拍摄检查" }).click();
    await page.locator('select:has(option:text-is("不镜像（他人从对面拍摄）"))').selectOption("no");
    await page.locator(".tab", { hasText: "练习" }).click();

    // 翻转必须随之消失
    await expect.poll(readFlip, { timeout: 15_000 }).toBe(false);
  });

  test("开关只在「导入视频」下出现，摄像头下没有该选项", async ({ page }) => {
    await page.goto("/");
    // 默认是摄像头：不该有镜像开关
    await expect(page.locator("select", { hasText: "镜像（手机自拍录制）" })).toHaveCount(0);

    await page
      .locator('select:has(option:text-is("导入视频"))')
      .selectOption({ label: "导入视频" });
    await expect(page.locator("select", { hasText: "镜像（手机自拍录制）" })).toHaveCount(1);
  });
});
