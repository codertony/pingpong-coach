/**
 * 姿态推理 Worker。
 *
 * 必须在 Worker 中运行的原因（方案第 5 节）：
 * MediaPipe Web 文档指出检测调用是**同步执行**的，会阻塞调用线程。
 * 放在主线程会卡住界面与摄像头回调。
 *
 * 同时：GPU 委托能否在目标浏览器的 Worker 中稳定运行需要能力探测，
 * 并提供 CPU 降级。
 */

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { KEYPOINT_NAMES, type Keypoint2D } from "@pingpong/contracts";

/** MediaPipe Pose Landmarker 的 33 点索引 → 本项目统一语义名称 */
const BLAZE33_TO_SEMANTIC: Record<number, (typeof KEYPOINT_NAMES)[number]> = {
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

export interface WorkerInitMessage {
  type: "init";
  wasmBasePath: string;
  modelAssetPath: string;
  modelId: string;
  /** 期望的委托方式；实际使用哪种会在 ready 消息中回报 */
  delegate: "GPU" | "CPU";
}

export interface WorkerDetectMessage {
  type: "detect";
  frameId: string;
  sourceEpoch: number;
  sourceTimeMs: number;
  receivedAtMonoMs: number;
  bitmap: ImageBitmap;
}

export type WorkerRequest = WorkerInitMessage | WorkerDetectMessage;

export interface WorkerReadyMessage {
  type: "ready";
  /** 实际生效的委托，可能与请求不同（GPU 失败时已降级） */
  delegate: "GPU" | "CPU";
  modelId: string;
  keypointSet: string;
  /** 是否发生了降级 */
  downgraded: boolean;
  initMs: number;
}

export interface WorkerResultMessage {
  type: "result";
  frameId: string;
  sourceEpoch: number;
  sourceTimeMs: number;
  receivedAtMonoMs: number;
  /** 推理完成时间（单调时钟），用于计算姿态处理耗时 */
  inferredAtMonoMs: number;
  inferenceMs: number;
  imageWidth: number;
  imageHeight: number;
  keypoints2D: Keypoint2D[];
  /** 该帧是否检测到人体 */
  detected: boolean;
}

export interface WorkerErrorMessage {
  type: "error";
  code: string;
  message: string;
  frameId?: string;
}

export type WorkerResponse = WorkerReadyMessage | WorkerResultMessage | WorkerErrorMessage;

export const KEYPOINT_SET_NAME = "blaze_33";

let landmarker: PoseLandmarker | null = null;

/**
 * MediaPipe 的 WASM 加载器（`vision_wasm_internal.js`）是 UMD 经典脚本：
 * 它靠顶层 `var ModuleFactory` 落在**全局作用域**，才能把工厂函数交给调用方。
 * MediaPipe 自己只会用 `<script>`（主线程）或 `importScripts`（经典 Worker）执行它。
 *
 * 本项目为了不阻塞界面跑在**模块 Worker** 里，两条路都不可用：
 * `importScripts` 调用即抛 TypeError，MediaPipe 于是退回动态 `import()`，
 * 而 ESM 的 `var` 留在模块作用域，全局上永远拿不到 `ModuleFactory`。
 *
 * 更麻烦的是 ESM 模块只求值一次：GPU 创建失败降级到 CPU 时会再次
 * `createFromOptions`，即使第一次侥幸挂上了全局，第二次也不会重新执行。
 *
 * 所以每次实例化之前自己取源码，按经典脚本语义在全局作用域执行一遍。
 */
type WasmHost = typeof globalThis & { ModuleFactory?: (options?: unknown) => Promise<unknown> };

async function loadWasmFactory(loaderUrl: string): Promise<void> {
  const host = globalThis as WasmHost;
  if (host.ModuleFactory) return;

  const res = await fetch(loaderUrl);
  if (!res.ok) {
    throw new Error(`无法获取 WASM 加载器（HTTP ${res.status}）：${loaderUrl}`);
  }
  const source = await res.text();
  // 间接 eval 在全局作用域执行，`var ModuleFactory` 因而成为全局属性。
  // 这是模块 Worker 里获得经典脚本语义的唯一途径，不能用动态 import 代替。
  (0, eval)(source);

  if (!host.ModuleFactory) {
    throw new Error("WASM 加载器执行后仍未提供 ModuleFactory");
  }
}

async function initLandmarker(msg: WorkerInitMessage): Promise<WorkerReadyMessage> {
  const started = Date.now();
  // 每次重新初始化都从"无历史"开始，避免沿用上一个实例的时间戳基线
  lastDetectTimestampMs = Number.NEGATIVE_INFINITY;
  const vision = await FilesetResolver.forVisionTasks(msg.wasmBasePath);

  const create = async (delegate: "GPU" | "CPU") => {
    await loadWasmFactory(vision.wasmLoaderPath);
    return PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: msg.modelAssetPath, delegate },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  };

  let activeDelegate: "GPU" | "CPU" = msg.delegate;
  let downgraded = false;

  try {
    landmarker = await create(msg.delegate);
  } catch (err) {
    if (msg.delegate !== "GPU") throw err;
    // GPU 委托在 Worker 里初始化失败 → 明确降级到 CPU，并如实回报
    post({ type: "error", code: "gpu_delegate_failed", message: (err as Error).message });
    landmarker = await create("CPU");
    activeDelegate = "CPU";
    downgraded = true;
  }

  return {
    type: "ready",
    delegate: activeDelegate,
    modelId: msg.modelId,
    keypointSet: KEYPOINT_SET_NAME,
    downgraded,
    initMs: Date.now() - started,
  };
}

/** 上一次交给 MediaPipe 的时间戳，用于保证严格递增。 */
let lastDetectTimestampMs = Number.NEGATIVE_INFINITY;

/**
 * 把媒体时间单调化后再交给 MediaPipe。
 *
 * 为什么必须做：`detectForVideo` 的 timestamp 必须**严格递增**，否则
 * 计算图直接报 `Packet timestamp mismatch`，且**之后每一帧都会继续失败**
 * —— 整条推理静默死掉，界面只是不再更新骨架。
 *
 * 触发场景很常见：导入视频循环播放时媒体时间会从结尾跳回 0；
 * seek 重播同理。用户看到的现象就是"视频里明明有挥拍，却一直等待有效挥拍"。
 *
 * 只改传给引擎的时间戳，**不改**投影到 PoseFrame 的 sourceTimeMs ——
 * 那是源视频的真实媒体时间，改了就破坏了它作为速度基准的含义。
 */
function monotonicDetectTimestamp(mediaTimeMs: number): number {
  const candidate = Math.max(0, mediaTimeMs);
  // 回绕或 seek 会让时间倒退，这里抬到"上一个 + 1ms"，
  // 保证严格递增且不产生过大的跳跃。
  lastDetectTimestampMs = candidate > lastDetectTimestampMs ? candidate : lastDetectTimestampMs + 1;
  return lastDetectTimestampMs;
}

function detect(msg: WorkerDetectMessage): WorkerResultMessage {
  if (!landmarker) {
    throw new Error("模型尚未初始化");
  }
  const started = performance.now();
  const result = landmarker.detectForVideo(msg.bitmap, monotonicDetectTimestamp(msg.sourceTimeMs));
  const inferenceMs = performance.now() - started;

  const landmarks = result.landmarks?.[0];
  const detected = landmarks != null && landmarks.length > 0;

  const keypoints2D: Keypoint2D[] = [];
  if (detected) {
    for (const [indexStr, name] of Object.entries(BLAZE33_TO_SEMANTIC)) {
      const index = Number(indexStr);
      const lm = landmarks[index];
      if (!lm) {
        // 缺失点保持缺失
        keypoints2D.push({ name, xPx: Number.NaN, yPx: Number.NaN, score: null, visible: false });
        continue;
      }
      // MediaPipe 输出归一化坐标 → 还原为原始画面像素。
      // 用归一化 x/y 计算角度会因长宽比失真，所以这里必须先还原。
      keypoints2D.push({
        name,
        xPx: lm.x * msg.bitmap.width,
        yPx: lm.y * msg.bitmap.height,
        score: lm.visibility ?? null,
        visible: lm.visibility == null ? null : lm.visibility > 0,
      });
    }
  }

  return {
    type: "result",
    frameId: msg.frameId,
    sourceEpoch: msg.sourceEpoch,
    sourceTimeMs: msg.sourceTimeMs,
    receivedAtMonoMs: msg.receivedAtMonoMs,
    inferredAtMonoMs: performance.now(),
    inferenceMs,
    imageWidth: msg.bitmap.width,
    imageHeight: msg.bitmap.height,
    keypoints2D,
    detected,
  };
}

function post(msg: WorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === "init") {
      post(await initLandmarker(msg));
      return;
    }
    if (msg.type === "detect") {
      const result = detect(msg);
      // Worker 侧也要释放，防止在途位图堆积
      msg.bitmap.close();
      post(result);
    }
  } catch (err) {
    const e = err as Error;
    post({
      type: "error",
      code: "worker_error",
      message: e.message,
      ...(msg.type === "detect" ? { frameId: msg.frameId } : {}),
    });
  }
};
