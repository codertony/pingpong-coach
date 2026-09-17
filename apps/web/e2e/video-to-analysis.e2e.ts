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

    /*
     * ⓪ 「帧率四列」的四个标签必须在（评审 §6.3 / 设计 §1.5.1）。
     *
     * 四者谁也不能代替谁：实时预览允许丢旧帧压延迟，关键帧又是每 3 帧才编一张。
     * 这一段只在真实 Chromium 里做得成 —— jsdom 既不解码也没有
     * `getVideoPlaybackQuality`，那一列在那边只能是"未知"。
     *
     * **数字留到播完再断言**：刚落第一帧时"实际解码"本来就是 0，
     * 在那一刻断言"必须大于 0"会把正常状态判成失败（第一版就是这么写的）。
     */
    const frameColumns = page.locator(".frame-columns");
    await expect(frameColumns).toBeVisible();
    for (const label of ["源视频（标称）", "实际解码", "姿态推理", "JPEG 候选"]) {
      await expect(frameColumns.getByText(label, { exact: false })).toBeVisible();
    }

    // 状态栏会写"视频已播放完毕…"。等它出现就等于等到了 `ended` 被处理。
    // 状态栏没有专属 class（就是一行 `.small`），所以按正文找 —— 不依赖位置。
    await expect
      .poll(async () => (await page.locator("body").innerText()).includes("播放完毕"), {
        timeout: 180_000,
        message: "素材播完了但状态栏没有反应 —— `ended` 没有被处理",
      })
      .toBe(true);

    /*
     * 播完之后再看数字：这时候解码列必须是浏览器报出的**真实帧数**。
     *
     * 「播完之后」不是随手挑的时点：素材播完会走 `stop()`，而 `stop()` 会把采集句柄
     * 置空 —— 第一版就是从那里面读元素，于是**恰好在最该看的时刻**数字变成了"未知"。
     * 现在元素与协商帧率单独存一个不随 `stop()` 清空的引用，这条断言同时守住那个行为。
     *
     * 两个量级关系也一并钉住 —— 抽帧是每 3 帧一张，所以
     * `JPEG 候选` 必然小于 `姿态推理`，而解码的帧不会少于进模型的帧。
     * 这两条不等式成立，才说明每一列数的确实是它自己那件事，而不是互相抄的。
     */
    const readColumn = async (label: string): Promise<number> => {
      const text = await frameColumns.innerText();
      const m = new RegExp(`${label}\\s*(\\d+)`).exec(text);
      return m ? Number(m[1]) : -1;
    };
    await expect
      .poll(async () => readColumn("实际解码"), {
        timeout: 60_000,
        message: "播完之后「实际解码」仍没有真实帧数（浏览器不支持？还是没接上）",
      })
      .toBeGreaterThan(0);
    const decoded = await readColumn("实际解码");
    const inferred = await readColumn("姿态推理");
    const jpegs = await readColumn("JPEG 候选");
    expect(
      jpegs,
      `抽帧列（${jpegs}）不该大于等于推理列（${inferred}）—— 每 3 帧才编一张`,
    ).toBeLessThan(inferred);
    expect(decoded, "解码的帧不该少于进模型的帧").toBeGreaterThanOrEqual(inferred);

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

    /*
     * ④ 逐板数值与**阶段时间线**也要在真浏览器里出现过（R5/R4 的用户可见面）。
     * 段落实时跑出来的东西不是 fixture —— 它证明这条链路真的把逐板数据带到了界面上。
     */
    await expect
      .poll(async () => page.locator(".phase-step").count(), {
        timeout: 30_000,
        message: "复查页没有阶段转变时间线 —— 逐板那一栏没渲染出来",
      })
      .toBeGreaterThan(0);
    await expect(page.getByText("逐板数值与过程")).toBeVisible();
    // 时间线上的每一步都要带时刻，用户才能与关键帧的 @Nms 对上
    const firstStep = await page.locator(".phase-step").first().textContent();
    expect(firstStep, `阶段步骤没带时刻：${firstStep}`).toMatch(/\d+ms/);
    // 证据包的局限要能看见 —— 模型只知道那里写了的事
    await expect(page.getByText("证据包的局限")).toBeVisible();

    /*
     * ⑤ 短片回放：点了要**真的跳到那一板的起点**（评审 §1.7）。
     *
     * 这是这一批里唯一"看得到动作"的能力，所以断言不停在"按钮存在" ——
     * 而是读回 `<video>` 的 currentTime，确认它跳到了那一板的起点。
     * 只在真浏览器里做得成：jsdom 的媒体元素是空壳（当前时间恒为 0）。
     *
     * 用**最后一板**试：第一板的起点可能是 0，跳到 0 秒什么都证明不了。
     */
    const replayButtons = page.getByRole("button", { name: "回放这一板" });
    await expect
      .poll(async () => replayButtons.count(), {
        timeout: 30_000,
        message: "导入视频的复查页没有回放按钮",
      })
      .toBeGreaterThan(0);

    // 从「本次挥拍」表里读最后一板的起点（按表头定位，避免抓成左边那张「本组记录」表）
    const strokeTable = page.locator("table", {
      has: page.getByRole("columnheader", { name: "区间" }),
    });
    const lastRow = strokeTable.locator("tbody tr").last();
    const lastRange = await lastRow.locator("td").nth(1).textContent();
    const startMs = Number((lastRange ?? "").split("–")[0]);
    expect(Number.isFinite(startMs) && startMs > 0, `最后一板的起点异常：${lastRange}`).toBe(true);

    await replayButtons.last().click();
    await expect
      .poll(
        async () =>
          page.locator("video.replay").evaluate((v) => (v as HTMLVideoElement).currentTime * 1000),
        {
          timeout: 15_000,
          message: `点了最后一板（起点 ${startMs}ms），视频却没有跳到那里`,
        },
      )
      // 播放会往前走，所以给一个宽松的上界：只要从该板起点开始放即可
      .toBeGreaterThanOrEqual(startMs - 50);

    /*
     * ⑥ 逐帧肘角曲线：真实素材上要**真的画出线来**（评审 §1.6 第一行）。
     *
     * 断言"有折线"而不是"有那个面板"：面板在、线没画出来是最容易发生的失败
     * （比如所有样本都被判成缺失，或者区间算错导致点全落在框外）。
     */
    await expect(page.getByText("肘角曲线（逐帧）")).toBeVisible();
    await expect
      .poll(async () => page.locator(".elbow-segment").count(), {
        timeout: 30_000,
        message: "曲线那一栏在，但一段线都没画出来",
      })
      .toBeGreaterThan(0);
    // 说明里必须给出覆盖率 —— 缺了多少要看得见，不能只有一条好看的线
    await expect(page.getByText(/共 \d+\/\d+ 帧测到肘角/)).toBeVisible();

    /*
     * ⑦ 同阶段·跨板对照（评审 §1.7 的"并排图"，只做用户自己那半边）。
     *
     * 真实素材这一段检出了 4 板，所以至少有一个阶段是"多板都有图"的。
     * 断言"每一行里的图数 ≥ 2"—— 那正是这一栏的定义：一行不足两板就不叫对照。
     */
    await expect(page.getByText("同阶段 · 跨板对照")).toBeVisible();
    // 红线：不能让用户把"这几板一致"读成"这几板对"
    await expect(page.getByText(/不是与标准的对照/)).toBeVisible();
    await expect(page.getByText(/稳定地做错也是一致的/)).toBeVisible();
    const crossRows = page.locator(".stroke-block", { has: page.locator(".kf-grid") });
    const rowCount = await crossRows.count();
    if (rowCount === 0) {
      /*
       * 这一次的组分不出"有两板可对照"的阶段 —— 那是允许的（成组只要求凑满几板，
       * 不保证每个阶段都落到多板上；而且这条链路按浏览器实际交付的帧处理，
       * 两次跑出来的组不保证一样）。但**必须明说**，不能留一片空白让人以为漏了。
       */
      await expect(crossRows).toHaveCount(0);
      await expect(page.getByText(/凑不出可对照的第二板/)).toBeVisible();
    } else {
      for (let i = 0; i < rowCount; i++) {
        const row = crossRows.nth(i);
        const n = await row.locator(".kf").count();
        expect(n, `跨板对照有一行只有 ${n} 张图 —— 对照至少要两板`).toBeGreaterThanOrEqual(2);
        // 每张图要标出它是第几板，否则"跨板"就无从读起
        await expect(row.getByText(/^第 \d+ 板$/).first()).toBeVisible();
      }
    }
  });
});
