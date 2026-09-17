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
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import type { EvidencePacket, StrokeEvent } from "@pingpong/contracts";
import { boundaryToleranceMs } from "@pingpong/motion-core";

const VIDEO = process.env.PPC_VERIFY_VIDEO ?? "";
const hasVideo = VIDEO !== "" && existsSync(VIDEO);

const OUT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  process.env.PPC_EVAL_OUT ?? "../.tmp-eval",
);

/** 源视频帧率（这支素材是 30fps）。逐帧喂，与产品在摄像头下的节奏一致。 */
const SOURCE_FPS = 30;

/** 预期单板时长：联系表分辨率的自检基准（见下）。 */
const EXPECTED_STROKE_MS = Number(process.env.PPC_EXPECTED_STROKE_MS ?? 800);

/**
 * 联系表格子宽度：**由验收判据推出来**，不是一个魔数。
 *
 * 判据是 IoU ≥ 0.5 ⇒ 两端各偏不超过单板时长的 25%（见 motion-core 的
 * `boundaryToleranceMs`）。格子取**容差的一半**，这样相邻两格必然跨住真实边界；
 * 上限 250ms（再粗就标不准），下限 50ms（别把表撑到没边）。
 *
 * 之前写死 250ms ⇒ **默认导出的表不满足它自己的自检**（800ms 单板需 ±200ms）。
 * 一个默认产物过不了自己自检的工具，等于把问题留给用户去发现。
 */
const DERIVED_STEP_MS = Math.min(
  250,
  Math.max(50, Math.floor(boundaryToleranceMs(EXPECTED_STROKE_MS) / 2)),
);
/** 实际使用的格子宽度（可被环境变量覆盖）。 */
const SHEET_STEP_MS = Number(process.env.PPC_CONTACT_SHEET_STEP_MS ?? DERIVED_STEP_MS);

/**
 * 把一串时刻渲染成网格图：每格一个源帧，**时间戳烧在画面里**。
 *
 * 抽出来是因为"导出联系表"与"导出分块联系表"必须用**同一套画法**：
 * 两处各写一遍的话，一处改了时间戳格式、另一处没改，而下游的
 * 「引用格子」校验靠的是 `frame-index.json` 与**画面里那行文字**对得上 ——
 * 对不上就会把**正确的人工标注**判成编造（标注协议 §2 的判废条件之一）。
 */
async function renderSheet(
  page: Page,
  videoB64: string,
  timesSec: number[],
  cols: number,
): Promise<string> {
  return page.evaluate(
    async ({ videoB64: b64, times, cols: c }) => {
      const bin = atob(b64);
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
      const rows = Math.ceil(times.length / c);
      const canvas = document.createElement("canvas");
      canvas.width = CW * c;
      canvas.height = CH * rows;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < times.length; i++) {
        video.currentTime = times[i]!;
        await new Promise<void>((r) => {
          video.onseeked = () => r();
        });
        const cx = (i % c) * CW;
        const cy = Math.floor(i / c) * CH;
        ctx.drawImage(video, cx, cy, CW, CH);
        // 时间戳烧进画面。**两位小数**——`frame-index.json` 里必须是同一个字符串，
        // 否则标注者照着画面写下来的引用会被机器判成"不存在的格子"。
        const label = `${times[i]!.toFixed(2)}s`;
        ctx.font = "bold 15px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(0,0,0,0.75)";
        ctx.fillRect(cx + 4, cy + 4, ctx.measureText(label).width + 8, 20);
        ctx.fillStyle = "#ffd166";
        ctx.fillText(label, cx + 8, cy + 6);
      }
      return canvas.toDataURL("image/png").split(",")[1]!;
    },
    { videoB64, times: timesSec, cols },
  );
}

/** 只问视频的基本信息（时长与尺寸）——"导出图片"这类用例只需要时间轴。 */
async function probeVideo(
  page: Page,
  videoB64: string,
): Promise<{ durationSec: number; width: number; height: number }> {
  return page.evaluate(async (b64: string) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const video = document.createElement("video");
    video.muted = true;
    video.src = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    await new Promise<void>((r, j) => {
      video.onloadeddata = () => r();
      video.onerror = () => j(new Error("视频加载失败"));
    });
    return {
      durationSec: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    };
  }, videoB64);
}

/**
 * 一张表里每个格子 → 源时间（毫秒）。行列为 0 基，与画面里的排布一致。
 *
 * ⚠️ **入参是整数毫秒，不是秒**。第一版用秒并靠 `t += 0.1` 累加，
 * 于是会出现 `5.999999…` 这种值 —— 它 `toFixed(3)` 后变成 6000，
 * 于**同一格被排进了相邻两块表**（一块把它当结尾、下一块把它当开头）。
 * 是下面那条"首尾相接"的自检把它抓出来的。
 * 换成整数毫秒累加之后，这种误差根本不会产生。
 */
function cellsOf(
  timesMs: number[],
  cols: number,
): Array<{ row: number; col: number; sourceTimeMs: number }> {
  return timesMs.map((ms, i) => ({
    row: Math.floor(i / cols),
    col: i % cols,
    sourceTimeMs: ms,
  }));
}

/** 整数毫秒的等间隔时刻：`[fromMs, toMs)`，步长 `stepMs`。 */
function everyMs(fromMs: number, toMs: number, stepMs: number): number[] {
  const out: number[] = [];
  for (let ms = fromMs; ms < toMs; ms += stepMs) out.push(ms);
  return out;
}

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
        /** 成组后拿到的证据包（评估里只成一次组，见下面的 finishGroup） */
        const packets: Array<Record<string, unknown>> = [];
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
                // 阶段事件（R4）：导出给 `eval:replay` 做**事件定位**评估用。
                // 与分段指标是两件独立的事 —— 一板可能被完整找到而阶段时刻全错。
                phaseEvents: s.phaseEvents,
                // 证据帧 id：关键帧只允许从这里挑（契约 refine 强制）。
                // 不导出它，「关键帧与证据帧对齐」这条自己就没法自查。
                evidenceFrameIds: s.evidenceFrameIds,
              });
            },
            onFeedback: () => {},
            onGroupComplete: (p: EvidencePacket) => {
              packets.push({
                keyframes: p.keyframes.map((k) => ({
                  id: k.id,
                  frameId: k.frameId,
                  sourceTimeMs: k.sourceTimeMs,
                  role: k.role,
                  strokeId: k.strokeId,
                  eventTimeOffsetMs: k.eventTimeOffsetMs,
                })),
                limitations: p.limitations,
              });
            },
          },
        );

        // ── 逐帧：推理 → 喂会话 ──
        const timeline: Array<Record<string, unknown>> = [];
        let autoCalibrated = false;
        const stepMs = 1000 / fps;
        const totalFrames = Math.floor((durationSec * 1000) / stepMs);
        // 抽帧节奏取自**产品常量**，不在这里另写一个 3 —— 两边一旦不同，
        // 量出来的「有几个转变没配上图」就不是线上的那个数
        const everyNFrames = window.__fixture.KEYFRAME_CAPTURE_EVERY_N_FRAMES;

        for (let i = 0; i < totalFrames; i++) {
          const tSec = (i * stepMs) / 1000;
          video.currentTime = tSec;
          await new Promise<void>((r) => {
            video.onseeked = () => r();
          });

          const res = lm.detect(video);
          const kp = res.landmarks?.[0];
          const detectedPose = kp != null;

          const keypoints2D: Array<{
            name: string;
            xPx: number;
            yPx: number;
            score: number | null;
            visible: boolean;
          }> = [];
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
          const frameId = `eval_${i}`;
          /*
           * 按**生产节奏**（每 3 帧一张）往缓存里放一张图。
           *
           * 字节是**占位符**，不是真的 JPEG：这一步量的是「选帧器挑了哪些帧」，
           * 而选帧只看**帧 id 与时间戳**，与图像内容无关。这些包也**不发往模型**
           * （本用例从头到尾不调模型），占位字节不会外流。
           *
           * 为什么不用真实的 `createKeyframeCapturer`：它是 fire-and-forget、
           * **没有 flush**（编码失败只影响那一帧），而评估要在循环结束后**立刻**成组 ——
           * 真编码会和成组抢时间，测出间歇性的「一张图都没有」。
           */
          if (i % everyNFrames === 0) {
            session.addFramePixels(frameId, sourceTimeMs, new Uint8Array([1, 2, 3, 4]), W, H);
          }
          session.pushPoseResult({
            frameId,
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
            // 躯干四点的**最低置信度** —— 决定 F-036 能不能修的那个量。
            // 体尺度是拿肩中点与髋中点算的，而这条路径**不看置信度**
            // （`findPoint` 只挡 `visible === false`）；绘制层却要求 ≥0.5。
            // 记下它，就能用真实素材回答"给体尺度套 0.5 门槛会掉多少帧"。
            torsoMinScore: (() => {
              const names = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"];
              const scores = names.map((n) => keypoints2D.find((k) => k.name === n)?.score ?? null);
              return scores.some((s) => s == null) ? null : Math.min(...(scores as number[]));
            })(),
          });
        }

        /*
         * 素材喂完 → **成组**，把证据包取出来。
         *
         * `emitGroup` 是异步的，而这里没有可 await 的句柄，所以按期等一小会儿
         * （给 promise 链让出事件循环），再断言包一定到了 —— 用固定 sleep 假装
         * 一定到，会变成间歇性失败。
         */
        session.finishGroup("评估回放结束（素材播完）");
        for (let i = 0; i < 50 && packets.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 10));
        }

        const telemetry = session.telemetry;
        session.dispose();

        const group = packets[0] ?? { keyframes: [], limitations: [] };

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
          keyframes: group.keyframes,
          limitations: group.limitations,
          /** 成组了没有 —— 没成组时上面的 keyframes 一定是空的，不能当成"没有图" */
          groupEmitted: packets.length > 0,
          telemetryAtEnd: {
            framesProcessed: telemetry.framesProcessed,
            wristVisible: telemetry.wristVisible,
            bodyScalePx: telemetry.bodyScalePx,
            segmentationPhase: telemetry.segmentationPhase,
            segmentationSkippedFrames: telemetry.segmentationSkippedFrames,
            segmentationLastAbortReason: telemetry.segmentationLastAbortReason,
            keyframesMissing: telemetry.keyframesMissing,
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

    /*
     * ── 关键帧到底挑到了哪几帧（R4 的实测）──
     *
     * 这一段要回答的是：**「图锚在检出的阶段转变上」这句话是不是真的**。
     * 不是"看起来对不对"，而是把每张图到它锚定事件的偏移量出来。
     *
     * 边界（必须写清楚，否则这个数字会被读成它没有的含义）：
     * - 它**只**说明图落在事件时刻上；事件本身准不准要**人工标注的真值**才谈得上
     *   （评审 §12.7：工程正确性与识别质量分栏报告）。
     * - 这里的图像字节是占位符（见上面 addFramePixels 处的说明），
     *   所以它**不**证明图像链路、只证明选帧链路。
     */
    interface KfRecord {
      id: string;
      frameId: string;
      sourceTimeMs: number;
      role: string;
      strokeId: string;
      eventTimeOffsetMs: number;
    }
    const kfs = (out.keyframes ?? []) as KfRecord[];
    const strokes = out.detectedStrokes as Array<{
      strokeId: string;
      evidenceFrameIds: string[];
      phaseEvents: Array<{ eventType: string; timeMs: number }>;
    }>;

    expect(out.groupEmitted, "素材喂完却没有成组 —— 关键帧测量无从谈起").toBe(true);
    expect(kfs.length, "一板都没挑出图 —— 选帧链路在真实素材上没有产出").toBeGreaterThan(0);

    const byStroke = new Map(strokes.map((s) => [s.strokeId, s]));
    const atEvent = kfs.filter((k) => k.eventTimeOffsetMs === 0).length;
    const inPhase = kfs.filter((k) => k.eventTimeOffsetMs > 0).length;
    for (const k of kfs) {
      const owner = byStroke.get(k.strokeId);
      expect(owner, `关键帧 ${k.id} 声明了一个不存在的板 ${k.strokeId}`).toBeDefined();
      // 契约 refine 强制的两条：属于自己那一板、且是该板的证据帧
      expect(
        owner!.evidenceFrameIds,
        `关键帧 ${k.id} 的帧不属于它声明的板 —— 借了别的板的图`,
      ).toContain(k.frameId);
      // 候选只从事件窗内取，所以偏移不可能为负
      expect(
        k.eventTimeOffsetMs,
        `关键帧 ${k.id} 的偏移是负的（${k.eventTimeOffsetMs}）—— 挑到了锚定事件之前的帧`,
      ).toBeGreaterThanOrEqual(0);
    }

    const offsets = kfs.filter((k) => k.eventTimeOffsetMs > 0).map((k) => k.eventTimeOffsetMs);
    const maxOffset = offsets.length > 0 ? Math.max(...offsets) : 0;
    const kfLimitations = (out.limitations as string[]).filter((l) => l.includes("关键帧锚在"));
    const missLines = (out.limitations as string[]).filter((l) => l.includes("没有可用画面"));

    console.warn(
      [
        "",
        `关键帧：${kfs.length} 张（板数 ${new Set(kfs.map((k) => k.strokeId)).size}）`,
        `  恰在转变时刻（偏移 0ms）：${atEvent} 张`,
        // 不写"其余都是峰值帧"：偏移 > 0 里有**两种**来路（峰值帧 / 退让），
        // 而包里只有偏移、看不出是哪一种 —— 分不出就说分不出
        `  同一相位内偏后（偏移 > 0ms）：${inPhase} 张，最大 ${maxOffset}ms`,
        `    ↑ 含「相位内的腕速峰值帧」与「转变那一刻没采到图、退到窗内最近一张」，`,
        `      两种的**含义不同**；分开的数字由发端的 limitations 给出（见下）`,
        `  按角色：${JSON.stringify(
          kfs.reduce<Record<string, number>>((acc, k) => {
            acc[k.role] = (acc[k.role] ?? 0) + 1;
            return acc;
          }, {}),
        )}`,
        ...(kfLimitations.length > 0 ? [`  发端自述：${kfLimitations.join(" / ")}`] : []),
        `  没配上图的阶段转变：${missLines.length > 0 ? missLines.join(" / ") : "无"}`,
        `  （图像字节是占位符：这一段证明的是**选帧**落在事件上，不是图像链路）`,
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

    // 概览表：整段素材，格子宽度由判据推出（见文件顶部 DERIVED_STEP_MS）
    const meta = await probeVideo(page, b64);
    const overviewMs = everyMs(0, Math.round(meta.durationSec * 1000), SHEET_STEP_MS);
    const png = await renderSheet(
      page,
      b64,
      overviewMs.map((ms) => ms / 1000),
      6,
    );

    mkdirSync(OUT_DIR, { recursive: true });
    const file = resolve(OUT_DIR, "contact-sheet.png");
    writeFileSync(file, Buffer.from(png, "base64"));
    console.warn(`\n联系表已写入 ${file}\n`);

    /*
     * **自检：这张表够不够细？**
     *
     * 验收判据是 IoU ≥ 0.5，换算成毫秒就是"两端各偏不超过该次挥拍时长的 25%"
     * （见 motion-core 的 boundaryToleranceMs）。所以**联系表的格子必须比这个容差更细**，
     * 否则标注者再仔细也标不到精度 —— 表本身就是瓶颈。
     *
     * ⚠️ **不能拿"已检出的挥拍时长"当基准**：连续对拉时检测会**合并**相邻几板
     * （F-022），合并后的时长**长于**真实单板 ⇒ 用它算出来的容差偏松，
     * 会得出"够用"的错误结论。所以基准取**预期单板时长**
     * （`PPC_EXPECTED_STROKE_MS`，默认 800ms），并把几个常见时长的容差一并打出来。
     */
    const stepMs = SHEET_STEP_MS;
    const expectedMs = EXPECTED_STROKE_MS;
    const observedFile = resolve(OUT_DIR, "segmentation-observed.json");
    const detectedDurations: number[] = [];
    if (existsSync(observedFile)) {
      const observed = JSON.parse(readFileSync(observedFile, "utf8")) as {
        detectedStrokes?: Array<{ startMs: number; endMs: number }>;
      };
      for (const s of observed.detectedStrokes ?? []) {
        if (s.endMs - s.startMs > 0) detectedDurations.push(s.endMs - s.startMs);
      }
    }

    console.warn(`\n标注精度自检（联系表格子 ${stepMs}ms）：`);
    console.warn("  预期单板时长 → 两端各需标在 ±X 内（IoU ≥ 0.5 的几何要求）");
    for (const d of [2200, 1500, 1000, 800, 600]) {
      const need = Math.round(boundaryToleranceMs(d));
      console.warn(
        `    ${String(d).padStart(4)}ms → ±${String(need).padStart(3)}ms${d === expectedMs ? "   ← 自检基准" : ""}`,
      );
    }
    if (detectedDurations.length > 0) {
      console.warn(
        `  本次检出的挥拍时长：${detectedDurations.map((d) => `${d}ms`).join("、")}` +
          `（连续对拉时会被合并，故**长于**真实单板 —— 别拿它当基准）`,
      );
    }
    if (stepMs > boundaryToleranceMs(expectedMs)) {
      console.warn(
        `\n⚠️ 这张表**不够细**：格子 ${stepMs}ms 粗于 ${expectedMs}ms 单板所需的 ±${Math.round(boundaryToleranceMs(expectedMs))}ms。\n` +
          `   直接用它会**系统性低报**识别质量 —— 标不准不是标注者的问题。\n` +
          `   要么调小 PPC_CONTACT_SHEET_STEP_MS 重新导出（如 100），要么直接对着视频标。\n`,
      );
    } else {
      console.warn(`\n✓ 格子细于自检基准所需容差，可以照此标注。\n`);
    }
    expect(png.length).toBeGreaterThan(0);
  });

  /**
   * 导出**分块联系表**与 `frame-index.json`（供外部标注 agent 引用格子）。
   *
   * ## 为什么必须分块
   *
   * 整段压成一张表时，相邻两格之间差几十秒 —— 标注者根本读不出"这一板从哪一格开始"。
   * 分块之后每块只覆盖一小段，格子密到能读边界（格子宽度仍由判据推出，见文件顶部）。
   *
   * ## 为什么必须给 `frame-index.json`
   *
   * 它让"引用格子"这件事**可机器校验**：标注里写的 `strip_02@1.70s` 会被逐个比对
   * 是否存在（标注协议 §2 把"引用不存在的格子"列为判废条件）。
   * 所以格子里的时间戳文字与索引里的 `sourceTimeMs` **必须同源** ——
   * 两者都由这里同一份 `times` 生成，就是为了不给它们走样的机会。
   *
   * ## sheetId 与文件名分开
   *
   * `sheetId` 是**逻辑名**（协议与标注里引用它），文件叫什么由这里决定并记进索引 ——
   * 概览那张沿用了既有文件名 `contact-sheet.png`，不必为了对齐协议去改名。
   */
  test("导出分块联系表与帧索引（供外部标注 agent）", async ({ page }) => {
    test.setTimeout(900_000);
    await page.goto("/e2e/fixtures/fixture.html");
    await page.waitForFunction(() => Boolean(window.__fixture));

    const b64 = readFileSync(VIDEO).toString("base64");
    const meta = await probeVideo(page, b64);

    const cols = 6;
    const stripSeconds = Number(process.env.PPC_STRIP_SECONDS ?? 2);
    if (!(stripSeconds > 0)) throw new Error("PPC_STRIP_SECONDS 必须是正数");

    interface SheetRecord {
      sheetId: string;
      file: string;
      cols: number;
      cells: Array<{ row: number; col: number; sourceTimeMs: number }>;
    }
    const sheets: SheetRecord[] = [];

    // 概览：由上一个用例渲染，这里只登记它的格子（同一套公式，不重画一遍）
    const overviewMs = everyMs(0, Math.round(meta.durationSec * 1000), SHEET_STEP_MS);
    const overviewFile = resolve(OUT_DIR, "contact-sheet.png");
    if (!existsSync(overviewFile)) {
      throw new Error("contact-sheet.png 不存在 —— 概览由上一个用例渲染，顺序不能反");
    }
    sheets.push({
      sheetId: "overview",
      file: "contact-sheet.png",
      cols,
      cells: cellsOf(overviewMs, cols),
    });

    // 分块表
    mkdirSync(resolve(OUT_DIR, "strips"), { recursive: true });
    const totalMs = Math.round(meta.durationSec * 1000);
    const stripMs = Math.round(stripSeconds * 1000);
    let index = 0;
    for (let fromMs = 0; fromMs < totalMs; fromMs += stripMs) {
      index++;
      const sheetId = `strip_${String(index).padStart(2, "0")}`;
      const timesMs = everyMs(fromMs, Math.min(fromMs + stripMs, totalMs), SHEET_STEP_MS);
      if (timesMs.length === 0) continue;
      const png = await renderSheet(
        page,
        b64,
        timesMs.map((ms) => ms / 1000),
        cols,
      );
      const file = `strips/${sheetId}.png`;
      writeFileSync(resolve(OUT_DIR, file), Buffer.from(png, "base64"));
      sheets.push({ sheetId, file, cols, cells: cellsOf(timesMs, cols) });
    }

    const frameIndex = {
      note:
        "每格 → 源时间。格子里的时间戳文字（两位小数）与本索引同源；" +
        "标注里引用格子时请写成 `<sheetId>@<格子上的时间戳>`，例如 strip_02@1.70s。",
      source: {
        file: basename(VIDEO),
        sha256: createHash("sha256").update(readFileSync(VIDEO)).digest("hex"),
        durationSec: Number(meta.durationSec.toFixed(3)),
        width: meta.width,
        height: meta.height,
        sourceFps: SOURCE_FPS,
      },
      cellStepMs: SHEET_STEP_MS,
      cols,
      sheets,
    };
    writeFileSync(
      resolve(OUT_DIR, "frame-index.json"),
      JSON.stringify(frameIndex, null, 2),
      "utf8",
    );

    // ── 自检：分块**首尾相接且覆盖全程**，不留缝也不重叠 ──
    // 有缝就意味着有一段素材没有任何格子可引用 —— 那段的动作**标不出来**。
    const strips = sheets.filter((s) => s.sheetId !== "overview");
    expect(strips.length, "一张分块表都没导出").toBeGreaterThan(0);
    for (let i = 1; i < strips.length; i++) {
      const prev = strips[i - 1]!.cells;
      const cur = strips[i]!.cells;
      const prevLast = prev[prev.length - 1]!.sourceTimeMs;
      expect(
        cur[0]!.sourceTimeMs,
        `${strips[i]!.sheetId} 的起点与上一块不相接（中间那段素材没有格子可引用）`,
      ).toBe(prevLast + SHEET_STEP_MS);
    }
    const lastCell = strips[strips.length - 1]!.cells.slice(-1)[0]!;
    expect(lastCell.sourceTimeMs, "最后一块没覆盖到素材结尾").toBeGreaterThan(
      Math.round(meta.durationSec * 1000) - SHEET_STEP_MS - 1,
    );

    const totalCells = sheets.reduce((n, s) => n + s.cells.length, 0);
    console.warn(
      [
        "",
        `分块联系表已导出：${strips.length} 块（每块 ${stripSeconds}s）+ 概览 1 张`,
        `共 ${totalCells} 格，格子宽度 ${SHEET_STEP_MS}ms，列数 ${cols}`,
        `索引：${resolve(OUT_DIR, "frame-index.json")}`,
        `目录：${resolve(OUT_DIR, "strips")}`,
        "",
      ].join("\n"),
    );
  });
});
