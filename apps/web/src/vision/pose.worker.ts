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

async function initLandmarker(msg: WorkerInitMessage): Promise<WorkerReadyMessage> {
  const started = Date.now();
  const vision = await FilesetResolver.forVisionTasks(msg.wasmBasePath);

  const create = (delegate: "GPU" | "CPU") =>
    PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: msg.modelAssetPath, delegate },
      runningMode: "VIDEO",
      numPoses: 1,
    });

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

function detect(msg: WorkerDetectMessage): WorkerResultMessage {
  if (!landmarker) {
    throw new Error("模型尚未初始化");
  }
  const started = performance.now();
  const result = landmarker.detectForVideo(msg.bitmap, msg.sourceTimeMs);
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
