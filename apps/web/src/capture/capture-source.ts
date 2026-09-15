/**
 * 采集源：摄像头与导入视频。
 *
 * 约束：
 * - 先检查摄像头权限与可用性，失败时给出**具体原因**并允许导入视频。
 * - 记录摄像头请求帧率、实际回调频率与真实姿态处理频率，三者可能不同。
 * - 停止训练时必须关闭摄像头轨道并取消任务。
 * - 手机在局域网访问电脑服务需要可信 HTTPS；电脑本机 localhost 可用。
 */

import { monotonicNow, nextFrameId, type FrameEnvelope } from "./frame-scheduler.js";

export type CaptureKind = "camera" | "video";

export interface CaptureError {
  code: "camera_permission_denied" | "camera_unavailable" | "video_decode_failed";
  message: string;
  /** 面向用户的具体排查建议 */
  hint: string;
}

export interface CaptureOptions {
  kind: CaptureKind;
  /** sourceEpoch 提供者 */
  getEpoch: () => number;
  /** 每帧回调。注意：bitmap 所有权转移给回调方 */
  onFrame: (frame: FrameEnvelope) => void;
  /** 请求的摄像头帧率（import 视频忽略） */
  requestedFps?: number;
  videoFile?: File;
  facingMode?: "user" | "environment";
}

export interface CaptureHandle {
  stop: () => void;
  /** 实际请求到的约束（用于和实测频率对比） */
  actualFps: number | null;
  video: HTMLVideoElement;
}

function describeCameraError(err: unknown): CaptureError {
  const e = err as { name?: string; message?: string };
  const name = e.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      code: "camera_permission_denied",
      message: "摄像头权限被拒绝",
      hint:
        "浏览器地址栏的权限图标里允许摄像头；确认页面在 localhost 或 HTTPS 下打开。" +
        "局域网 IP + HTTP 无法使用摄像头。",
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return {
      code: "camera_unavailable",
      message: "未找到可用的摄像头设备",
      hint: "检查摄像头是否被其它程序占用，或改用导入视频。",
    };
  }
  if (name === "NotReadableError") {
    return {
      code: "camera_unavailable",
      message: "摄像头被其它程序占用或无法读取",
      hint: "关闭正在使用摄像头的会议软件后重试。",
    };
  }
  return {
    code: "camera_unavailable",
    message: e.message ?? "摄像头启动失败",
    hint: "可以改用导入视频继续验证链路。",
  };
}

/**
 * 启动采集。
 *
 * 摄像头用 requestVideoFrameCallback（若可用）获取媒体时间，
 * 退化到 requestAnimationFrame。导入视频始终使用媒体时间，
 * **不能**用播放耗时计算运动速度。
 */
export async function startCapture(options: CaptureOptions): Promise<CaptureHandle> {
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;

  let stream: MediaStream | null = null;
  let actualFps: number | null = null;

  if (options.kind === "camera") {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          frameRate: { ideal: options.requestedFps ?? 60 },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          ...(options.facingMode ? { facingMode: options.facingMode } : {}),
        },
        audio: false,
      });
    } catch (err) {
      throw describeCameraError(err);
    }
    const settings = stream.getVideoTracks()[0]?.getSettings();
    actualFps =
      settings?.frameRate != null && Number.isFinite(settings.frameRate)
        ? settings.frameRate
        : null;
    video.srcObject = stream;
  } else {
    if (!options.videoFile) {
      throw {
        code: "video_decode_failed",
        message: "未提供视频文件",
        hint: "请选择一个本地视频文件。",
      } satisfies CaptureError;
    }
    const url = URL.createObjectURL(options.videoFile);
    video.src = url;
    video.loop = true;
  }

  await new Promise<void>((resolve, reject) => {
    const onLoaded = () => resolve();
    const onError = () =>
      reject({
        code: "video_decode_failed",
        message: "视频加载或解码失败",
        hint: "确认文件是浏览器可解码的格式（建议 mp4/H.264）。",
      } satisfies CaptureError);
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });

  await video.play();

  let running = true;
  let callbackHandle: number | null = null;
  let rafHandle: number | null = null;
  let lastMediaTimeMs = -1;

  const hasVideoFrameCallback =
    typeof (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: unknown;
      }
    ).requestVideoFrameCallback === "function";

  const emit = (mediaTimeMs: number): void => {
    if (!running) return;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;

    // 同一媒体时间重复回调不重复处理
    const rounded = Math.round(mediaTimeMs);
    if (rounded === lastMediaTimeMs) return;
    lastMediaTimeMs = rounded;

    void createImageBitmap(video)
      .then((bitmap) => {
        if (!running) {
          bitmap.close();
          return;
        }
        const epoch = options.getEpoch();
        options.onFrame({
          frameId: nextFrameId(epoch, mediaTimeMs),
          sourceTimeMs: mediaTimeMs,
          receivedAtMonoMs: monotonicNow(),
          sourceEpoch: epoch,
          bitmap,
          width: bitmap.width,
          height: bitmap.height,
        });
      })
      .catch(() => {
        // 单帧取图失败不致命，跳过即可；统计由上层丢帧数体现
      });
  };

  if (hasVideoFrameCallback) {
    const step = (
      _now: number,
      metadata: { mediaTime: number; presentedFrames?: number },
    ): void => {
      emit(metadata.mediaTime * 1000);
      if (running) {
        callbackHandle = (
          video as HTMLVideoElement & {
            requestVideoFrameCallback: (
              cb: (now: number, meta: { mediaTime: number }) => void,
            ) => number;
          }
        ).requestVideoFrameCallback(step);
      }
    };
    callbackHandle = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback: (
          cb: (now: number, meta: { mediaTime: number }) => void,
        ) => number;
      }
    ).requestVideoFrameCallback(step);
  } else {
    const loop = (): void => {
      emit(video.currentTime * 1000);
      if (running) rafHandle = requestAnimationFrame(loop);
    };
    rafHandle = requestAnimationFrame(loop);
  }

  const stop = (): void => {
    running = false;
    if (callbackHandle != null) {
      (
        video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void }
      ).cancelVideoFrameCallback?.(callbackHandle);
    }
    if (rafHandle != null) cancelAnimationFrame(rafHandle);
    // 停止训练时关闭摄像头并释放轨道
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    video.pause();
    video.srcObject = null;
    if (options.kind === "video" && video.src.startsWith("blob:")) {
      URL.revokeObjectURL(video.src);
    }
    video.removeAttribute("src");
  };

  return { stop, actualFps, video };
}

/** 枚举可用摄像头，供拍摄检查页展示。 */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}
