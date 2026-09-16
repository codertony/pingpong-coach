/**
 * 用**真实产品链路**跑一段真实视频，导出分段结果供评估（B4 / `eval:replay`）。
 *
 * 为什么要走真实 `TrainingSession` 而不是在 Node 里重算一遍：
 * `StrokeSegmenter` 收的是**已滤波**的腕部位置、已算好的体尺度与质量 ——
 * 那些前处理在 `TrainingSession` 里。要在 Node 复现，就得把那段逻辑抄一份，
 * 而本项目反复出的问题正是"同一个事实两处各写各的"（F-017/F-018/F-019）。
 * 所以反过来：**在浏览器里用真会话跑**，只把结果导出。
 *
 * 准备区的自动标定也照 `App.tsx` 的条件镜像（腕部可见后标定一次）——
 * 这是产品真实的触发点，不镜像它量出来的就不是产品行为。
 *
 * 输入：`PPC_VERIFY_VIDEO`（真实素材）；输出目录：`PPC_EVAL_OUT`。
 * 输出里含**人的动作数据**，属于派生个人信息 → 默认落在 Git 之外的临时目录。
 *
 * ⚠️ 素材缺失时整体 skip（CI 上没有该文件），不伪装成通过。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import type { StrokeEvent } from "@pingpong/contracts";

const VIDEO = process.env.PPC_VERIFY_VIDEO ?? "";
const hasVideo = VIDEO !== "" && existsSync(VIDEO);

const OUT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  process.env.PPC_EVAL_OUT ?? "../.tmp-eval",
);

/** 源视频帧率（这支素材是 30fps）。逐帧喂，与产品在摄像头下的节奏一致。 */
const SOURCE_FPS = 30;

test.describe("真实视频 · 分段回放（供 eval:replay 使用）", () => {
  test.skip(!hasVideo, "未提供 PPC_VERIFY_VIDEO（真实挥拍素材），跳过");

  test("导出逐帧观测与检出的挥拍", async ({ page }) => {
    test.setTimeout(900_000);
    await page.goto("/e2e/fixtures/fixture.html");
    await page.waitForFunction(() => Boolean(window.__fixture));

    const b64 = readFileSync(VIDEO).toString("base64");

    const out = await page.evaluate(
      async ({ videoB64, fps }) => {
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
        const durationSec = video.duration;

        // 与 pose.worker.ts 的 BLAZE33_TO_SEMANTIC 同一张表
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

        // ── 真实会话，配置取自产品唯一的构造处 ──
        const detected: Array<Record<string, unknown>> = [];
        /** onStroke 只对**已闭合**的挥拍触发，但 endMs 的类型允许 null —— 老实计数 */
        let droppedIncomplete = 0;
        const statuses: string[] = [];
        const session = new window.__fixture.TrainingSession(
          window.__fixture.buildTrainingConfig({
            sessionId: "eval_replay_1",
            handedness: "right",
            cameraView: "front",
            focusId: "return_to_ready_zone",
            // 刻意设得很大：评估要看**连续回放下的每一次挥拍**，
            // 组边界是交互概念，不该在这里切断样本
            strokesPerGroup: 1_000_000,
          }),
          {
            onStatus: (t: string) => statuses.push(t),
            onStroke: (s: StrokeEvent) => {
              if (typeof s.startMs !== "number" || typeof s.endMs !== "number") {
                droppedIncomplete++;
                return;
              }
              detected.push({
                strokeId: s.strokeId,
                startMs: s.startMs,
                endMs: s.endMs,
                anchorType: s.anchor.type,
                anchorTimeMs: s.anchor.timeMs,
              });
            },
            onFeedback: () => {},
            onGroupComplete: () => {},
          },
        );

        // ── 逐帧：推理 → 喂会话 ──
        const timeline: Array<Record<string, unknown>> = [];
        let autoCalibrated = false;
        const stepMs = 1000 / fps;
        const totalFrames = Math.floor((durationSec * 1000) / stepMs);

        for (let i = 0; i < totalFrames; i++) {
          const tSec = (i * stepMs) / 1000;
          video.currentTime = tSec;
          await new Promise<void>((r) => {
            video.onseeked = () => r();
          });

          const res = lm.detect(video);
          const kp = res.landmarks?.[0];
          const detectedPose = kp != null;

          const keypoints2D = [];
          if (kp) {
            for (const [idx, name] of Object.entries(IDX_TO_NAME)) {
              const p = kp[Number(idx)];
              if (!p) continue;
              keypoints2D.push({
                name,
                xPx: p.x * W,
                yPx: p.y * H,
                score: p.visibility ?? null,
                visible: (p.visibility ?? 1) > 0,
              });
            }
          }

          const sourceTimeMs = Math.round(i * stepMs);
          session.pushPoseResult({
            frameId: `eval_${i}`,
            sourceEpoch: 0,
            sourceTimeMs,
            receivedAtMonoMs: sourceTimeMs,
            inferredAtMonoMs: sourceTimeMs,
            inferenceMs: 0,
            imageWidth: W,
            imageHeight: H,
            keypoints2D,
            detected: detectedPose,
            handDetected: false,
            keypointSet: "blaze_33",
          });

          // 镜像 App.tsx 的自动标定触发条件
          if (!autoCalibrated && session.telemetry.wristVisible) {
            const used = session.calibrateReadyZoneFromDwell();
            if (used > 0) autoCalibrated = true;
          }

          const wrist = keypoints2D.find((k) => k.name === "right_wrist");
          const zone = session.readyZoneDisplay;
          timeline.push({
            tMs: sourceTimeMs,
            poseDetected: detectedPose,
            wristX: wrist ? wrist.xPx : null,
            wristY: wrist ? wrist.yPx : null,
            wristScore: wrist ? wrist.score : null,
            phase: session.telemetry.segmentationPhase,
            readyZoneAutoCalibrated: session.telemetry.readyZoneAutoCalibrated,
            // 把当时生效的准备区**逐帧记下来**：腕部距离是相对它算的，
            // 不记就没法在离线复算（见 scripts/threshold-diagnostic.ts）
            zoneXPx: zone ? zone.xPx : null,
            zoneYPx: zone ? zone.yPx : null,
            zoneRadiusPx: zone ? zone.radiusPx : null,
            // 体尺度也逐帧记：离线算"距离 ÷ 体尺度"时要它。
            // 不记的话只能从半径反推，而反推依赖"半径是按当前配置算的"这个前提 ——
            // 配置一改，反推就错（见 F-032）。
            bodyScalePx: session.telemetry.bodyScalePx,
          });
        }

        const telemetry = session.telemetry;
        session.dispose();

        return {
          video: {
            width: W,
            height: H,
            durationSec,
            fps,
            frames: totalFrames,
          },
          autoCalibrated,
          detectedStrokes: detected,
          droppedIncompleteStrokes: droppedIncomplete,
          lastStatuses: statuses.slice(-8),
          telemetryAtEnd: {
            framesProcessed: telemetry.framesProcessed,
            wristVisible: telemetry.wristVisible,
            bodyScalePx: telemetry.bodyScalePx,
            segmentationPhase: telemetry.segmentationPhase,
            segmentationSkippedFrames: telemetry.segmentationSkippedFrames,
            segmentationLastAbortReason: telemetry.segmentationLastAbortReason,
          },
          timeline,
        };
      },
      { videoB64: b64, fps: SOURCE_FPS },
    );

    mkdirSync(OUT_DIR, { recursive: true });
    const { timeline, ...summary } = out;
    writeFileSync(
      resolve(OUT_DIR, "segmentation-observed.json"),
      JSON.stringify(summary, null, 2),
      "utf8",
    );
    writeFileSync(
      resolve(OUT_DIR, "pose-timeline.json"),
      JSON.stringify(timeline, null, 2),
      "utf8",
    );

    console.warn(
      [
        "",
        `视频 ${out.video.width}×${out.video.height}，${out.video.durationSec.toFixed(2)}s，` +
          `逐帧喂入 ${out.video.frames} 帧（${out.video.fps}fps）`,
        `准备区自动标定 = ${out.autoCalibrated}`,
        `检出挥拍 **${out.detectedStrokes.length}** 次：`,
        ...out.detectedStrokes.map(
          (s) => `   ${s.startMs} ~ ${s.endMs} ms（锚点 ${s.anchorTimeMs}）`,
        ),
        `结束时遥测：${JSON.stringify(out.telemetryAtEnd)}`,
        `逐帧观测写到 pose-timeline.json（${timeline.length} 行）`,
        "",
      ].join("\n"),
    );

    // 前置条件：这段素材应当检得出人体，否则后面的指标没有意义
    const posed = timeline.filter((f) => f.poseDetected).length;
    expect(posed, "整段视频一帧都没检出人体 —— 素材或模型有问题").toBeGreaterThan(
      out.video.frames * 0.5,
    );
    // 真问题在于"检不出挥拍"：视频里明确有挥拍，检出 0 次就是失败
    expect(
      out.detectedStrokes.length,
      "逐帧跑完整段真实素材，一次挥拍都没检出 —— 分段链路在真实数据上不工作",
    ).toBeGreaterThan(0);
  });

  /**
   * 把整段素材压成一张**联系表**（contact sheet），用于人工标注真实挥拍窗口。
   *
   * 为什么必须单独出一张图：要算 precision/recall 就得有**独立于算法**的真值。
   * 用腕部轨迹去标"哪些是挥拍"是拿算法自己的信号当真值，那是循环论证。
   * 只有把帧摆出来看一眼，标注才独立。
   */
  test("导出联系表（供人工标注真值）", async ({ page }) => {
    test.setTimeout(600_000);
    await page.goto("/e2e/fixtures/fixture.html");
    await page.waitForFunction(() => Boolean(window.__fixture));

    const b64 = readFileSync(VIDEO).toString("base64");

    const png = await page.evaluate(
      async ({ videoB64, everySec, cols }) => {
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

        const CW = 320;
        const CH = Math.round((video.videoHeight / video.videoWidth) * CW);
        const times: number[] = [];
        for (let t = 0; t < video.duration; t += everySec) times.push(t);
        const rows = Math.ceil(times.length / cols);

        const canvas = document.createElement("canvas");
        canvas.width = CW * cols;
        canvas.height = CH * rows;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        for (let i = 0; i < times.length; i++) {
          video.currentTime = times[i]!;
          await new Promise<void>((r) => {
            video.onseeked = () => r();
          });
          const cx = (i % cols) * CW;
          const cy = Math.floor(i / cols) * CH;
          ctx.drawImage(video, cx, cy, CW, CH);
          // 时间戳烧进画面：没有它就没法把看到的动作对回毫秒
          ctx.font = "bold 15px monospace";
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          const label = `${times[i]!.toFixed(2)}s`;
          ctx.fillStyle = "rgba(0,0,0,0.75)";
          ctx.fillRect(cx + 4, cy + 4, ctx.measureText(label).width + 8, 20);
          ctx.fillStyle = "#ffd166";
          ctx.fillText(label, cx + 8, cy + 6);
        }
        return canvas.toDataURL("image/png").split(",")[1]!;
      },
      { videoB64: b64, everySec: 0.25, cols: 6 },
    );

    mkdirSync(OUT_DIR, { recursive: true });
    const file = resolve(OUT_DIR, "contact-sheet.png");
    writeFileSync(file, Buffer.from(png, "base64"));
    console.warn(`\n联系表已写入 ${file}\n`);
    expect(png.length).toBeGreaterThan(0);
  });
});
