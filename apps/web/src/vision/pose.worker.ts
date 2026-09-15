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

import { FilesetResolver, HandLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import {
  HAND_LANDMARK_NAMES,
  KEYPOINT_NAMES,
  KEYPOINT_SET_POSE_AND_HAND,
  KEYPOINT_SET_POSE_ONLY,
  type Keypoint2D,
} from "@pingpong/contracts";
import { assignHandsToSides } from "@pingpong/motion-core";

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

/**
 * 手部 21 点在本项目里的语义名，按侧别切分。
 *
 * 命名带 `_hand_` 中缀，与姿态的 `left_wrist` / `right_wrist` 显式区分：
 * 二者是**同一个物理手腕**的两个独立观测，不能互相覆盖。
 * 顺序必须与 MediaPipe Hand Landmarker 的 21 点一致。
 */
const HAND_NAMES_BY_SIDE: Record<
  "left" | "right",
  readonly (typeof HAND_LANDMARK_NAMES)[number][]
> = {
  left: HAND_LANDMARK_NAMES.slice(0, 21),
  right: HAND_LANDMARK_NAMES.slice(21),
};

export interface WorkerInitMessage {
  type: "init";
  wasmBasePath: string;
  modelAssetPath: string;
  /** 手部模型资产；不给则只跑姿态（手指细节不可用） */
  handModelAssetPath?: string;
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
  /** 手部模型是否可用（不可用时不产出任何手部关键点） */
  handModelAvailable: boolean;
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
  /** 姿态点 + （可用时）手部点；缺失点保持缺失，不补零 */
  keypoints2D: Keypoint2D[];
  /** 该帧是否检测到人体 */
  detected: boolean;
  /** 该帧是否检测到手（手部模型不可用时恒为 false） */
  handDetected: boolean;
}

export interface WorkerErrorMessage {
  type: "error";
  code: string;
  message: string;
  frameId?: string;
}

export type WorkerResponse = WorkerReadyMessage | WorkerResultMessage | WorkerErrorMessage;

export const KEYPOINT_SET_NAME = KEYPOINT_SET_POSE_ONLY;

let landmarker: PoseLandmarker | null = null;
let handLandmarker: HandLandmarker | null = null;

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
  handErrorReported = false;
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

  // 手部模型是**可选增强**：它失败时姿态链路必须照常可用，
  // 只把手指细节标记为不可用。这里绝不因为手部模型失败而抛错。
  let handModelAvailable = false;
  if (msg.handModelAssetPath) {
    try {
      await loadWasmFactory(vision.wasmLoaderPath);
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: msg.handModelAssetPath, delegate: activeDelegate },
        runningMode: "VIDEO",
        // 两只手都检测：出拍侧由**姿态的腕部位置**来判定，
        // 不用 handedness 标签（见 motion-core 的 assignHandsToSides）。
        numHands: 2,
      });
      handModelAvailable = true;
    } catch (err) {
      handLandmarker = null;
      post({
        type: "error",
        code: "hand_model_unavailable",
        message: (err as Error).message,
      });
    }
  }

  return {
    type: "ready",
    delegate: activeDelegate,
    modelId: msg.modelId,
    keypointSet: handModelAvailable ? KEYPOINT_SET_POSE_AND_HAND : KEYPOINT_SET_POSE_ONLY,
    handModelAvailable,
    downgraded,
    initMs: Date.now() - started,
  };
}

/** 归一化坐标 → 原始画面像素；缺失点保持缺失（不补零）。 */
function toPixel(
  name: string,
  lm: { x: number; y: number; visibility?: number } | undefined,
  width: number,
  height: number,
): Keypoint2D {
  if (!lm) {
    return {
      name: name as Keypoint2D["name"],
      xPx: Number.NaN,
      yPx: Number.NaN,
      score: null,
      visible: false,
    };
  }
  return {
    name: name as Keypoint2D["name"],
    xPx: lm.x * width,
    yPx: lm.y * height,
    score: lm.visibility ?? null,
    visible: lm.visibility == null ? null : lm.visibility > 0,
  };
}

/**
 * 把手部检测结果分配到左右两侧（按姿态腕部锚点）。
 *
 * 具体判定逻辑在 motion-core 的 `assignHandsToSides` 里 —— 那是纯计算，
 * 放在那个包才能被单元测试直接覆盖；这里只做像素换算与逐个点的投影。
 */
function projectHands(
  hands: ReadonlyArray<ReadonlyArray<{ x: number; y: number; visibility?: number }>>,
  poseWrists: { left: { x: number; y: number } | null; right: { x: number; y: number } | null },
  width: number,
  height: number,
  anchorTolerancePx: number,
): Partial<Record<"left" | "right", Keypoint2D[]>> {
  const anchors = {
    left: poseWrists.left,
    right: poseWrists.right,
  };
  const { assigned } = assignHandsToSides(hands, anchors, anchorTolerancePx);

  const out: Partial<Record<"left" | "right", Keypoint2D[]>> = {};
  for (const side of ["left", "right"] as const) {
    const lm = assigned[side];
    if (!lm) continue;
    const names = HAND_NAMES_BY_SIDE[side];
    out[side] = lm.map((p, i) => toPixel(names[i]!, p, width, height));
  }
  return out;
}

/** 上一次交给 MediaPipe 的时间戳，用于保证严格递增。 */
let lastDetectTimestampMs = Number.NEGATIVE_INFINITY;

/** 手部检测错误只报一次，避免逐帧刷屏掩盖真正的问题。 */
let handErrorReported = false;

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
  const timestamp = monotonicDetectTimestamp(msg.sourceTimeMs);
  const result = landmarker.detectForVideo(msg.bitmap, timestamp);

  const landmarks = result.landmarks?.[0];
  const detected = landmarks != null && landmarks.length > 0;

  const width = msg.bitmap.width;
  const height = msg.bitmap.height;
  const keypoints2D: Keypoint2D[] = [];
  let poseWrists: {
    left: { x: number; y: number } | null;
    right: { x: number; y: number } | null;
  } = { left: null, right: null };

  if (detected) {
    for (const [indexStr, name] of Object.entries(BLAZE33_TO_SEMANTIC)) {
      const index = Number(indexStr);
      // 缺失点保持缺失（toPixel 负责），不补零
      keypoints2D.push(toPixel(name, landmarks[index], width, height));
    }
    const toWrist = (idx: number) => {
      const lm = landmarks[idx];
      return lm ? { x: lm.x * width, y: lm.y * height } : null;
    };
    poseWrists = { left: toWrist(15), right: toWrist(16) };
  }

  // 手部是可选增强：它失败时姿态结果照常返回，只是没有手指细节。
  let handDetected = false;
  if (handLandmarker) {
    try {
      // 与姿态共用同一个（已单调化的）时间戳：
      // 两个计算图各自维护自己的时间基线，但要求的递增性相同。
      const handResult = handLandmarker.detectForVideo(msg.bitmap, timestamp);
      const hands = handResult.landmarks ?? [];
      handDetected = hands.length > 0;
      const assigned = projectHands(
        hands,
        poseWrists,
        width,
        height,
        // 容差按画面对角线的 15%：太紧会因姿态/手部轻微不一致而全部丢弃，
        // 太松会把另一只手错配给持拍侧。宁可不给，也不给错的。
        Math.hypot(width, height) * 0.15,
      );
      for (const side of ["left", "right"] as const) {
        const pts = assigned[side];
        const names = HAND_NAMES_BY_SIDE[side];
        if (pts) {
          keypoints2D.push(...pts);
        } else {
          // 没有这只手 → 显式记为缺失，而不是悄悄不产出
          for (const name of names) keypoints2D.push(toPixel(name, undefined, width, height));
        }
      }
    } catch (err) {
      // 手部单帧失败不能影响姿态链路：如实报错，但结果照常返回。
      // 只报一次 —— 每帧都报会把控制台冲垮，反而不利于定位。
      if (!handErrorReported) {
        handErrorReported = true;
        post({ type: "error", code: "hand_detect_failed", message: (err as Error).message });
      }
    }
  }

  const inferenceMs = performance.now() - started;

  return {
    type: "result",
    frameId: msg.frameId,
    sourceEpoch: msg.sourceEpoch,
    sourceTimeMs: msg.sourceTimeMs,
    receivedAtMonoMs: msg.receivedAtMonoMs,
    inferredAtMonoMs: performance.now(),
    inferenceMs,
    imageWidth: width,
    imageHeight: height,
    keypoints2D,
    detected,
    handDetected,
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
