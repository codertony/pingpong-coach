/**
 * 把**产品自己的**骨架叠加画在**真实视频**上，导出图片供目视检查。
 *
 * 这份文件回答 F-006 里"目视确认骨架是否画在关节上"那一步。
 * 之所以要单独写它，是因为此前所有真实推理测试都只*看数字*：
 * `pose-anatomy.e2e.ts` 断言的是骨段比例自洽，
 * 而比例自洽是"贴合"的**必要条件而非充分条件** ——
 * 一个整体缩放、整体平移、或镜像过的骨架，比例全对，但画在人是错的。
 * 只有把点画到画面上、再**真的看一眼**，才能发现那一类问题。
 *
 * 关节是否落在关节上，最终仍由人（或看图的多模态模型）判断；
 * 本文件能自动断言的是**别的东西**：
 *   ① 关键点真的检出了；
 *   ② 产品的 `drawSkeleton` 用这批点**真的画出了东西**（不是空叠加层）——
 *      这一条同时兜住"语义名与绘制代码脱节"（那种情况下画布一片空白）；
 *   ③ 导出的图真的写到磁盘上了。
 * 图像本身由 `PPC_OVERLAY_OUT` 指向的目录给出，供人看。
 *
 * ⚠️ 需要一段真实挥拍视频（`PPC_VERIFY_VIDEO`）。缺失时整体 skip —— 不伪装成通过。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const VIDEO = process.env.PPC_VERIFY_VIDEO ?? "";
const hasVideo = VIDEO !== "" && existsSync(VIDEO);

/** 采样时刻（秒）。覆盖整段片子，而不是只看第一帧。 */
const SAMPLE_TIMES_SEC = [1, 2, 3, 4, 5, 6, 7];

/** 导出目录。默认落在 apps/web 下的临时目录（已被 .gitignore 的 .tmp-* 覆盖）。 */
const OUT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  process.env.PPC_OVERLAY_OUT ?? "../.tmp-overlay",
);

test.describe("真实视频上的骨架叠加（供目视检查）", () => {
  test.skip(!hasVideo, "未提供 PPC_VERIFY_VIDEO（真实挥拍素材），跳过");

  test("导出的叠加图里，骨架真的画在画面上了", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/e2e/fixtures/fixture.html");
    await page.waitForFunction(() => Boolean(window.__fixture));

    const b64 = readFileSync(VIDEO).toString("base64");

    const frames = await page.evaluate(
      async ({ videoB64, times }) => {
        const bin = atob(videoB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        const video = document.createElement("video");
        video.muted = true;
        video.src = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
        await new Promise<void>((r, j) => {
          video.onloadeddata = () => r();
          video.onerror = () => j(new Error("视频加载失败"));
        });

        const W = video.videoWidth;
        const H = video.videoHeight;

        // 与 pose.worker.ts 的 BLAZE33_TO_SEMANTIC **同一张表**。
        // 若这张表与绘制代码的语义名脱节，叠加层会画不出东西，
        // 下面的 drawnPixels 断言就会失败 —— 不需要额外机制去守它。
        const IDX_TO_NAME: Record<number, string> = {
          0: "nose",
          11: "left_shoulder",
          12: "right_shoulder",
          13: "left_elbow",
          14: "right_elbow",
          15: "left_wrist",
          16: "right_wrist",
          23: "left_hip",
          24: "right_hip",
          25: "left_knee",
          26: "right_knee",
          27: "left_ankle",
          28: "right_ankle",
        };

        const bundlePath = "/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs";
        const { FilesetResolver, PoseLandmarker } = (await import(
          /* @vite-ignore */ bundlePath
        )) as typeof import("@mediapipe/tasks-vision");
        const vision = await FilesetResolver.forVisionTasks(
          new URL("/wasm", document.baseURI).href,
        );
        const lm = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: new URL("/models/pose_landmarker_full.task", document.baseURI).href,
            delegate: "GPU",
          },
          runningMode: "IMAGE",
          numPoses: 1,
        });

        const out: Array<{
          tSec: number;
          detected: boolean;
          /** 叠加层上非透明像素数 —— 为 0 说明产品没画出任何东西 */
          drawnPixels: number;
          minVisibility: number;
          png: string;
          /** 放大格的原生分辨率单独一份，看图时按 1:1 显示用 */
          zoomPng: string;
        }> = [];

        for (const tSec of times) {
          video.currentTime = tSec;
          await new Promise<void>((r) => {
            video.onseeked = () => r();
          });

          const res = lm.detect(video);
          const kp = res.landmarks?.[0];

          let detected = false;
          let minVisibility = 1;
          const points: Array<{
            name: string;
            xPx: number;
            yPx: number;
            score: number | null;
            visible: boolean;
          }> = [];

          if (kp) {
            detected = true;
            for (const [i, name] of Object.entries(IDX_TO_NAME)) {
              const p = kp[Number(i)];
              if (!p) continue;
              const vis = p.visibility ?? 1;
              if (vis < minVisibility) minVisibility = vis;
              points.push({
                name,
                xPx: p.x * W,
                yPx: p.y * H,
                score: p.visibility ?? null,
                visible: vis > 0,
              });
            }
          }

          // 产品自己的绘制函数，画在原尺寸的透明覆盖层上（与产品一致）
          const overlay = document.createElement("canvas");
          overlay.width = W;
          overlay.height = H;
          if (detected) {
            window.__fixture.drawSkeleton(overlay, points, "right", {
              mirrored: false,
              minScore: 0.5,
            });
          }

          let drawnPixels = 0;
          const px = overlay.getContext("2d")!.getImageData(0, 0, W, H).data;
          for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) drawnPixels++;

          // ── 第三格：把**持拍侧手臂**裁出来放大 ──
          // 全帧尺度下"点是否落在关节上"看不出差别 —— 一个点错开 20px
          // 在 1280 宽的画面里只有 1.5%，肉眼判不了。
          //
          // 裁上半身而不是全身：全身 bbox 高约等于画面高，放大后必然被裁掉，
          // 而真正要判的关节（肩肘腕）都在上半身。全身缩略图里的肩肘腕
          // 只有几十像素，等于没放大。
          const UPPER_BODY = new Set([
            "nose",
            "left_shoulder",
            "right_shoulder",
            "left_elbow",
            "right_elbow",
            "left_wrist",
            "right_wrist",
          ]);
          const upper = points.filter((p) => UPPER_BODY.has(p.name));

          let crop = { x: 0, y: 0, w: W, h: H };
          if (upper.length >= 3) {
            const xs = upper.map((p) => p.xPx);
            const ys = upper.map((p) => p.yPx);
            const spanX = Math.max(...xs) - Math.min(...xs);
            const spanY = Math.max(...ys) - Math.min(...ys);
            const padX = spanX * 0.45;
            const padY = spanY * 0.45;
            const x0 = Math.max(0, Math.min(...xs) - padX);
            const y0 = Math.max(0, Math.min(...ys) - padY);
            const x1 = Math.min(W, Math.max(...xs) + padX);
            const y1 = Math.min(H, Math.max(...ys) + padY);
            crop = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
          }

          // 放大倍数取"最大 2×，且不超出画布"—— 放不下就降，而不是裁掉
          const ZOOM = Math.max(1, Math.min(2, H / crop.h, 900 / crop.w));
          const zoomW = Math.round(crop.w * ZOOM);
          const zoomH = Math.round(crop.h * ZOOM);

          const composed = document.createElement("canvas");
          composed.width = W * 2 + zoomW;
          composed.height = H;
          const ctx = composed.getContext("2d")!;

          // 左半：原帧；中：**同一帧** + 骨架叠加；右：局部放大。
          // 三格必须是同一帧，否则"点有没有落在关节上"无从比较 ——
          // 挥拍中相邻帧的人体位置差很多。
          ctx.drawImage(video, 0, 0, W, H);
          ctx.drawImage(video, W, 0, W, H);
          ctx.drawImage(overlay, W, 0);
          // 放大格：先把裁剪出的帧区域放大，再叠同一区域的骨架
          ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, W * 2, 0, zoomW, zoomH);
          ctx.drawImage(overlay, crop.x, crop.y, crop.w, crop.h, W * 2, 0, zoomW, zoomH);

          // 分隔线，便于分辨三格
          ctx.strokeStyle = "rgba(255,255,255,0.35)";
          ctx.lineWidth = 2;
          for (const x of [W, W * 2]) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, H);
            ctx.stroke();
          }
          ctx.fillStyle = "#ffffff";
          ctx.font = "20px system-ui, sans-serif";
          ctx.fillText(`原帧 ${tSec}s`, 12, 30);
          ctx.fillText(`叠加（产品 drawSkeleton）${detected ? "" : " —— 未检出人体"}`, W + 12, 30);
          ctx.fillText(`持拍侧手臂局部放大 ${ZOOM.toFixed(1)}×`, W * 2 + 12, 30);

          // 放大格单独再存一份**原生分辨率**的文件。
          // 理由：合成图很宽，看图时会被整体缩小显示，放大格的细节就白生成了。
          // 单独存一份才能按 1:1 看，而"点是否落在关节上"正是 1:1 才判得了的事。
          const zoomOnly = document.createElement("canvas");
          zoomOnly.width = zoomW;
          zoomOnly.height = zoomH;
          const zctx = zoomOnly.getContext("2d")!;
          zctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, zoomW, zoomH);
          zctx.drawImage(overlay, crop.x, crop.y, crop.w, crop.h, 0, 0, zoomW, zoomH);

          out.push({
            tSec,
            detected,
            drawnPixels,
            minVisibility,
            png: composed.toDataURL("image/png").split(",")[1]!,
            zoomPng: zoomOnly.toDataURL("image/png").split(",")[1]!,
          });
        }

        return out;
      },
      { videoB64: b64, times: SAMPLE_TIMES_SEC },
    );

    mkdirSync(OUT_DIR, { recursive: true });
    for (const f of frames) {
      const tag = String(f.tSec).padStart(2, "0");
      writeFileSync(resolve(OUT_DIR, `overlay_${tag}s.png`), Buffer.from(f.png, "base64"));
      writeFileSync(resolve(OUT_DIR, `zoom_${tag}s.png`), Buffer.from(f.zoomPng, "base64"));
    }

    const summary = frames
      .map(
        (f) =>
          `${f.tSec}s: 检出=${f.detected} 叠加像素=${f.drawnPixels} 最低可见度=${f.minVisibility.toFixed(2)}`,
      )
      .join("\n");
    console.warn(`\n叠加图已写入 ${OUT_DIR}\n${summary}\n`);

    // ── 自动断言的只有"叠加层不是空的" ──
    // 注意：**这里刻意不断言"画在关节上"**。那不是算术能判的，
    // 写一条会永远通过的断言等于自欺（见 AGENTS.md 工程纪律）。
    const detected = frames.filter((f) => f.detected);
    expect(
      detected.length,
      `全部 ${frames.length} 个采样帧都没检出人体 —— 视频或模型有问题`,
    ).toBeGreaterThan(0);

    for (const f of detected) {
      expect(
        f.drawnPixels,
        `${f.tSec}s 检出了人体，但产品 drawSkeleton 画出的叠加层是空的 ` +
          `（语义名与绘制代码脱节时会这样）`,
      ).toBeGreaterThan(0);
    }
  });
});
