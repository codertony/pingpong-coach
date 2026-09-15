/**
 * 姿态引擎客户端。
 *
 * 职责：拉起 Worker、加载模型资产、按帧请求推理、回报能力探测结果。
 * 模型与 WASM 通过本项目静态资源路径提供，避免每次训练依赖外部 CDN。
 */

import type { Keypoint2D } from "@pingpong/contracts";
import type { WorkerRequest, WorkerResponse } from "./pose.worker.js";

/** 模型资产清单。与 models/manifest.json 对应。 */
export interface ModelAsset {
  modelId: string;
  modelAssetPath: string;
  wasmBasePath: string;
  /** 期望委托 */
  preferredDelegate: "GPU" | "CPU";
}

export interface PoseResult {
  frameId: string;
  sourceEpoch: number;
  sourceTimeMs: number;
  receivedAtMonoMs: number;
  inferredAtMonoMs: number;
  /** 姿态处理耗时：收到帧 → 骨架结果可用 */
  inferenceMs: number;
  imageWidth: number;
  imageHeight: number;
  keypoints2D: Keypoint2D[];
  detected: boolean;
}

export interface EngineStatus {
  ready: boolean;
  delegate: "GPU" | "CPU" | null;
  downgraded: boolean;
  modelId: string | null;
  keypointSet: string | null;
  initMs: number | null;
  error: string | null;
}

type ResultListener = (r: PoseResult) => void;

export class PoseEngine {
  private worker: Worker | null = null;
  private status: EngineStatus = {
    ready: false,
    delegate: null,
    downgraded: false,
    modelId: null,
    keypointSet: null,
    initMs: null,
    error: null,
  };
  private listeners = new Set<ResultListener>();
  /** 已发出但未返回的 frameId，用于丢弃迟到结果 */
  private inFlight = new Set<string>();

  constructor(private readonly asset: ModelAsset) {}

  get currentStatus(): EngineStatus {
    return { ...this.status };
  }

  onResult(listener: ResultListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 初始化。返回实际生效的委托方式（可能已降级为 CPU）。 */
  async init(): Promise<EngineStatus> {
    this.worker = new Worker(new URL("./pose.worker.ts", import.meta.url), {
      type: "module",
    });

    return new Promise<EngineStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.status.error = "模型初始化超时";
        reject(new Error("模型初始化超时"));
      }, 60_000);

      this.worker!.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;

        if (msg.type === "ready") {
          clearTimeout(timer);
          this.status = {
            ready: true,
            delegate: msg.delegate,
            downgraded: msg.downgraded,
            modelId: msg.modelId,
            keypointSet: msg.keypointSet,
            initMs: msg.initMs,
            error: null,
          };
          resolve(this.currentStatus);
          return;
        }

        if (msg.type === "result") {
          if (!this.inFlight.delete(msg.frameId)) return; // 迟到结果直接丢弃
          const result: PoseResult = { ...msg };
          for (const l of this.listeners) l(result);
          return;
        }

        if (msg.type === "error") {
          // gpu_delegate_failed 是预期内的降级信号，不当作致命错误
          if (msg.code === "gpu_delegate_failed") return;
          this.status.error = msg.message;
          if (!this.status.ready) {
            clearTimeout(timer);
            reject(new Error(msg.message));
          }
        }
      };

      this.worker!.onerror = (err) => {
        clearTimeout(timer);
        this.status.error = err.message;
        reject(new Error(err.message));
      };

      const initMsg: WorkerInitMessageLike = {
        type: "init",
        wasmBasePath: this.asset.wasmBasePath,
        modelAssetPath: this.asset.modelAssetPath,
        modelId: this.asset.modelId,
        delegate: this.asset.preferredDelegate,
      };
      this.worker!.postMessage(initMsg satisfies WorkerRequest);
    });
  }

  /**
   * 提交一帧。
   *
   * 注意：传出的 ImageBitmap **所有权转移给 Worker**，
   * 调用方不得再使用，也不得重复 close。
   */
  detect(frame: {
    frameId: string;
    sourceEpoch: number;
    sourceTimeMs: number;
    receivedAtMonoMs: number;
    bitmap: ImageBitmap;
  }): void {
    if (!this.worker || !this.status.ready) {
      frame.bitmap.close();
      return;
    }
    this.inFlight.add(frame.frameId);
    const msg: WorkerRequest = { type: "detect", ...frame };
    this.worker.postMessage(msg, [frame.bitmap]);
  }

  /** 停止训练时必须调用：终止 Worker 并释放模型资源。 */
  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.inFlight.clear();
    this.listeners.clear();
    this.status = {
      ready: false,
      delegate: null,
      downgraded: false,
      modelId: null,
      keypointSet: null,
      initMs: null,
      error: null,
    };
  }
}

type WorkerInitMessageLike = {
  type: "init";
  wasmBasePath: string;
  modelAssetPath: string;
  modelId: string;
  delegate: "GPU" | "CPU";
};
