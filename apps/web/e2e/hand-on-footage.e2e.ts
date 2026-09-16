/**
 * 真实视频上的**手部**检测与左右分配。
 *
 * 这份文件是为一个具体缺陷写的（F-020），它测的是产品路径上的**单位口径**：
 * `pose.worker.ts` 的 `projectHands` 把手部点与姿态腕部锚点一起交给
 * `assignHandsToSides` 比距离，但
 *   - 手部点来自 MediaPipe 原始输出 → **归一化坐标**（0..1）；
 *   - 腕部锚点经过 `toWrist` 乘过宽高 → **像素坐标**（0..1280）。
 * 两者不在同一空间，距离恒为数百像素，远超容差 `hypot(W,H)*0.15 ≈ 220`，
 * 于是**每一只手、每一帧都被丢弃**。
 *
 * 危险之处在于它是**静默**的：
 *   - `handDetected` 取自 `hands.length > 0`，仍然为 `true` —— 遥测说"检出了手"；
 *   - 手部 21 点在 keypoints 里被显式记为**缺失**，而那段代码的注释写着
 *     "显式记为缺失，而不是悄悄不产出" —— 看起来像有意为之；
 *   - 于是手指几何永远算不出、绘制永远不画，而没有任何一处报错。
 *
 * 这个文件用**同一帧的真实数据**做 A/B：
 *   ① 按产品现在的调用方式（归一化点 vs 像素锚点）→ 期望全部被丢弃；
 *   ② 把点换算成像素后再调用 → 期望能分配。
 * 两条同时记录，所以它既是缺陷证据，也是修复后的回归。
 *
 * ⚠️ 需要真实挥拍素材（`PPC_VERIFY_VIDEO`）。缺失时整体 skip。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const VIDEO = process.env.PPC_VERIFY_VIDEO ?? "";
const hasVideo = VIDEO !== "" && existsSync(VIDEO);

const OUT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  process.env.PPC_OVERLAY_OUT ?? "../.tmp-overlay",
);

/** 采样步长（秒）。比姿态那组密，因为要统计"多少帧能拿到手"。 */
const STEP_SEC = 0.25;
const LAST_SEC = 7.75;

/** 走真实 Worker 时探测的时刻。覆盖整段片子，含实测能检出 手 的 3s / 6.25s。 */
const WORKER_PROBE_TIMES = [1, 2, 3, 4, 5, 6, 6.25, 7];

test.describe("真实视频上的手部检出与左右分配", () => {
  test.skip(!hasVideo, "未提供 PPC_VERIFY_VIDEO（真实挥拍素材），跳过");

  test("检出率与分配率（含单位口径 A/B）", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/e2e/fixtures/fixture.html");
    await page.waitForFunction(() => Boolean(window.__fixture));

    const b64 = readFileSync(VIDEO).toString("base64");

    const report = await page.evaluate(
      async ({ videoB64, step, last }) => {
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

        const bundlePath = "/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs";
        const { FilesetResolver, PoseLandmarker, HandLandmarker } = (await import(
          /* @vite-ignore */ bundlePath
        )) as typeof import("@mediapipe/tasks-vision");
        const vision = await FilesetResolver.forVisionTasks(
          new URL("/wasm", document.baseURI).href,
        );
        const pose = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: new URL("/models/pose_landmarker_full.task", document.baseURI).href,
            delegate: "GPU",
          },
          runningMode: "IMAGE",
          numPoses: 1,
        });
        const hand = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: new URL("/models/hand_landmarker.task", document.baseURI).href,
            delegate: "GPU",
          },
          runningMode: "IMAGE",
          numHands: 2,
        });

        // 与 pose.worker.ts 完全同一个容差公式
        const TOL = Math.hypot(W, H) * 0.15;

        interface Row {
          tSec: number;
          poseDetected: boolean;
          handCount: number;
          /** 手部 21 点的包围盒对角线（像素）—— 用来描述手在画面里有多大 */
          handSpanPx: number;
          /** 产品现在的口径（归一化点 vs 像素锚点）能分配出几侧 */
          assignedAsIs: number;
          /** 把点换算成像素后再分配，能分配出几侧 */
          assignedIfPixels: number;
          /** 产品口径下被丢弃时的最小距离（像素）—— 超容差多少一目了然 */
          minRejectedDistPx: number;
        }
        const rows: Row[] = [];

        for (let t = step; t <= last; t += step) {
          video.currentTime = t;
          await new Promise<void>((r) => {
            video.onseeked = () => r();
          });

          const poseRes = pose.detect(video);
          const lm = poseRes.landmarks?.[0];
          const wr = (i: number) => {
            const p = lm?.[i];
            return p ? { x: p.x * W, y: p.y * H } : null;
          };
          // 产品就是这么算锚点的：乘过宽高，所以是**像素**
          const anchors = { left: wr(15), right: wr(16) };

          const handRes = hand.detect(video);
          const hands = handRes.landmarks ?? [];

          // 手在画面里多大：取第一只手的包围盒对角线（MediaPipe 输出是归一化的）
          let handSpanPx = 0;
          const h0 = hands[0];
          if (h0) {
            const xs = h0.map((p) => p.x * W);
            const ys = h0.map((p) => p.y * H);
            handSpanPx = Math.hypot(
              Math.max(...xs) - Math.min(...xs),
              Math.max(...ys) - Math.min(...ys),
            );
          }

          const asIs = window.__fixture.assignHandsToSides(hands, anchors, TOL);
          const asPixels = window.__fixture.assignHandsToSides(
            hands.map((h) => h.map((p) => ({ x: p.x * W, y: p.y * H }))),
            anchors,
            TOL,
          );

          rows.push({
            tSec: t,
            poseDetected: lm != null,
            handCount: hands.length,
            handSpanPx,
            assignedAsIs: Object.keys(asIs.assigned).length,
            assignedIfPixels: Object.keys(asPixels.assigned).length,
            minRejectedDistPx: asIs.rejected.length
              ? Math.min(...asIs.rejected.map((r) => r.distancePx))
              : Number.NaN,
          });
        }

        const withHands = rows.filter((r) => r.handCount > 0);
        const mean = (xs: number[]) =>
          xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;

        return {
          frames: rows.length,
          imageWidth: W,
          imageHeight: H,
          tolerancePx: TOL,
          framesWithHands: withHands.length,
          framesWithTwoHands: rows.filter((r) => r.handCount >= 2).length,
          meanHandSpanPx: mean(withHands.map((r) => r.handSpanPx)),
          framesAssignedAsIs: rows.filter((r) => r.assignedAsIs > 0).length,
          framesAssignedIfPixels: rows.filter((r) => r.assignedIfPixels > 0).length,
          minRejectedDistPx: withHands.length
            ? Math.min(...withHands.map((r) => r.minRejectedDistPx))
            : Number.NaN,
          meanRejectedDistPx: mean(withHands.map((r) => r.minRejectedDistPx)),
          rows,
        };
      },
      { videoB64: b64, step: STEP_SEC, last: LAST_SEC },
    );

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      resolve(OUT_DIR, "hand-assignment.json"),
      JSON.stringify(report, null, 2),
      "utf8",
    );

    console.warn(
      [
        "",
        `画面 ${report.imageWidth}×${report.imageHeight}，容差 ${report.tolerancePx.toFixed(0)}px`,
        `采样 ${report.frames} 帧，检出至少一只手 ${report.framesWithHands} 帧，` +
          `两只手 ${report.framesWithTwoHands} 帧`,
        `手的包围盒对角线均值 ${report.meanHandSpanPx.toFixed(0)}px`,
        `── 分配结果 ──`,
        `按产品现在的口径（归一化点 vs 像素锚点）成功分配：${report.framesAssignedAsIs} 帧`,
        `把点换算成像素后成功分配：${report.framesAssignedIfPixels} 帧`,
        `产品口径下被丢弃时的最小距离：${report.minRejectedDistPx.toFixed(0)}px` +
          `（均值 ${report.meanRejectedDistPx.toFixed(0)}px）`,
        "",
      ].join("\n"),
    );

    // 前置条件：这段素材里手部模型确实检出了手 —— 否则下面的断言没有意义
    expect(
      report.framesWithHands,
      "整段视频一帧都没检出手 —— 素材或手部模型有问题，先解决这个",
    ).toBeGreaterThan(0);

    // ── F-020 的回归断言 ──
    // 同一个空间（都换算成像素）时，分配必须能成功。
    // 这条断言不依赖"归一化 vs 像素"这个具体错法 ——
    // 将来若有人改了坐标口径，只要空间一致就仍然成立；
    // 而空间一旦不一致，它立刻变红。
    expect(
      report.framesAssignedIfPixels,
      "把同一份手部数据换算到与锚点同一空间后，仍然一帧都分配不出去 —— " +
        "说明问题不在单位口径，或容差/锚点另有问题",
    ).toBeGreaterThan(0);
  });

  /**
   * F-020 的端到端回归：走**真实 Worker**（不是单独调模型），
   * 断言检出手的帧里，手部 21 点必须是**有效坐标**而不是全缺失。
   *
   * 为什么必须是端到端：缺陷不在 `assignHandsToSides`（它是对的），
   * 而在调用方把归一化点和像素锚点混着传。单独调模型的测试永远碰不到那一行。
   */
  test("真实 Worker 路径：检出手的帧里，手部点必须有效", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/e2e/fixtures/fixture.html");
    await page.waitForFunction(() => Boolean(window.__fixture));

    const b64 = readFileSync(VIDEO).toString("base64");

    const out = await page.evaluate(
      async ({ videoB64, times }) => {
        type Res = {
          frameId: string;
          detected: boolean;
          handDetected: boolean;
          keypointSet: string;
          keypoints2D: Array<{
            name: string;
            xPx: number;
            yPx: number;
            score: number | null;
            visible: boolean | null;
          }>;
        };

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

        // 用**产品自己的资产配置**建引擎，而不是在这里另拼一份路径 ——
        // 另拼一份就把"配置对不对"从被测范围里挪走了。
        const engine = new window.__fixture.PoseEngine(window.__fixture.MODEL_ASSET);
        const status = await engine.init();

        const rows: Array<{
          tSec: number;
          detected: boolean;
          handDetected: boolean;
          keypointCount: number;
          handPointCount: number;
          finiteHandPoints: number;
          /** 把 Worker 吐出的关键点交给产品绘制层后的效果图（仅检出手的帧） */
          handPng?: string;
        }> = [];

        // 手部点 = 非姿态点。
        // 刻意**不**按名字里有没有 `_hand_` 来挑：21 个名字里只有腕点带这个中缀
        // （`left_hand_wrist`），手指叫 `left_thumb_cmc` 之类 —— 那样筛会只数到 2 个。
        const POSE_NAMES = new Set([
          "nose",
          "left_shoulder",
          "right_shoulder",
          "left_elbow",
          "right_elbow",
          "left_wrist",
          "right_wrist",
          "left_hip",
          "right_hip",
          "left_knee",
          "right_knee",
          "left_ankle",
          "right_ankle",
        ]);

        for (const t of times) {
          video.currentTime = t;
          await new Promise<void>((r) => {
            video.onseeked = () => r();
          });

          const frameId = `hand_e2e_${Math.round(t * 1000)}`;
          const bitmap = await createImageBitmap(video);

          const res = await new Promise<Res>((resolve) => {
            const off = engine.onResult((r) => {
              if (r.frameId !== frameId) return;
              off();
              resolve(r as unknown as Res);
            });
            engine.detect({
              frameId,
              sourceEpoch: 0,
              sourceTimeMs: Math.round(t * 1000),
              receivedAtMonoMs: performance.now(),
              bitmap,
            });
          });

          const handPts = res.keypoints2D.filter((k) => !POSE_NAMES.has(k.name));
          const finite = handPts.filter((k) => Number.isFinite(k.xPx) && Number.isFinite(k.yPx));

          // 检出手的帧：把 **Worker 真正吐出的这份 keypoints2D** 交给产品绘制层，
          // 存成放大图。这是"手指细节"这个功能的完整链路 ——
          // 模型 → 适配（命名/单位）→ 分配 → 绘制，任何一环脱节都会在这里露出来。
          let handPng: string | undefined;
          if (finite.length > 0) {
            const side = res.keypoints2D.some(
              (k) => k.name === "right_hand_wrist" && Number.isFinite(k.xPx),
            )
              ? "right"
              : "left";

            const overlay = document.createElement("canvas");
            overlay.width = video.videoWidth;
            overlay.height = video.videoHeight;
            window.__fixture.drawSkeleton(overlay, res.keypoints2D, side, {
              mirrored: false,
              minScore: 0.5,
            });

            const W2 = video.videoWidth;
            const H2 = video.videoHeight;
            const xs = finite.map((k) => k.xPx);
            const ys = finite.map((k) => k.yPx);
            const spanX = Math.max(...xs) - Math.min(...xs);
            const spanY = Math.max(...ys) - Math.min(...ys);
            const cx0 = Math.max(0, Math.min(...xs) - spanX * 0.6);
            const cy0 = Math.max(0, Math.min(...ys) - spanY * 0.6);
            const cw = Math.min(W2 - cx0, spanX * 2.2 || 1);
            const ch = Math.min(H2 - cy0, spanY * 2.2 || 1);
            const Z = Math.max(1, Math.min(4, H2 / ch, 900 / cw));
            const zw = Math.round(cw * Z);
            const zh = Math.round(ch * Z);

            const out = document.createElement("canvas");
            out.width = zw;
            out.height = zh;
            const octx = out.getContext("2d")!;
            octx.drawImage(video, cx0, cy0, cw, ch, 0, 0, zw, zh);
            octx.drawImage(overlay, cx0, cy0, cw, ch, 0, 0, zw, zh);
            handPng = out.toDataURL("image/png").split(",")[1]!;
          }

          rows.push({
            tSec: t,
            detected: res.detected,
            handDetected: res.handDetected,
            keypointCount: res.keypoints2D.length,
            handPointCount: handPts.length,
            finiteHandPoints: finite.length,
            ...(handPng ? { handPng } : {}),
          });
        }

        engine.dispose();
        return {
          status: {
            handModelAvailable: status.handModelAvailable,
            delegate: status.delegate,
            keypointSet: status.keypointSet,
          },
          rows,
        };
      },
      { videoB64: b64, times: WORKER_PROBE_TIMES },
    );

    mkdirSync(OUT_DIR, { recursive: true });
    for (const r of out.rows) {
      if (!r.handPng) continue;
      writeFileSync(
        resolve(OUT_DIR, `hand_${String(r.tSec).replace(".", "_")}s.png`),
        Buffer.from(r.handPng, "base64"),
      );
    }
    // JSON 里不放 base64：那会让这个文件大到没法看，而图片已经单独落盘了
    writeFileSync(
      resolve(OUT_DIR, "hand-worker-path.json"),
      JSON.stringify(
        {
          status: out.status,
          rows: out.rows.map(({ handPng, ...rest }) => ({ ...rest, hasImage: handPng != null })),
        },
        null,
        2,
      ),
      "utf8",
    );

    console.warn(
      [
        "",
        `引擎：手部模型可用=${out.status.handModelAvailable} 委托=${out.status.delegate} ` +
          `关键点集=${out.status.keypointSet}`,
        ...out.rows.map(
          (r) =>
            `${r.tSec}s: 姿态检出=${r.detected} 手检出=${r.handDetected} ` +
            `关键点=${r.keypointCount} 手部点=${r.handPointCount} 其中有效坐标=${r.finiteHandPoints}`,
        ),
        "",
      ].join("\n"),
    );

    expect(
      out.status.handModelAvailable,
      "手部模型未加载 —— 手部能力根本没启用，后面的断言无从谈起",
    ).toBe(true);

    // 关键点集必须如实反映"手部已接入"
    expect(out.status.keypointSet).toBe("blaze_33+hand_21");

    // 每侧 21 点、两侧共 42。分配不到的那一侧**显式记为缺失**，
    // 而不是干脆不产出 —— 否则下游无法区分"没有手"和"这个字段没实现"。
    for (const r of out.rows) {
      expect(r.handPointCount, `${r.tSec}s 手部点数量不是 42`).toBe(42);
    }

    const withHand = out.rows.filter((r) => r.handDetected);
    test.skip(
      withHand.length === 0,
      "采样的帧里手部模型一帧都没检出手，无法验证手部投影（需一段手部更清晰的素材）",
    );

    // 分配是**整只手**的：要么这只手 21 点全有，要么全缺。
    // 半个手比不画更容易被误读为"手就是这样"（绘制层也是这么取舍的）。
    for (const r of withHand) {
      expect(
        r.finiteHandPoints % 21,
        `${r.tSec}s 有效手部点 ${r.finiteHandPoints} 个，不是 21 的整数倍 —— ` + `分配出了半只手`,
      ).toBe(0);
    }

    expect(
      withHand.filter((r) => r.finiteHandPoints > 0).length,
      "检出了手，但手部 21 点全是缺失坐标 —— 这就是 F-020：" +
        "手部点与腕部锚点不在同一坐标空间，导致每一只手都被当作超出容差丢弃",
    ).toBeGreaterThan(0);
  });
});
