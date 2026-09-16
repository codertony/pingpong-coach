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
  /**
   * 原始错误摘要（`Name: message`），原样展示给用户。
   *
   * 存在的理由：三种完全不同的故障（枚举不到设备 / 打不开设备 / 参数不满足）
   * 曾经共用一句"检查摄像头是否被其它程序占用"，排查时把人引向了错误的方向。
   * 归类和翻译留在 message/hint，原始事实必须能被看到。
   */
  detail?: string;
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
  /** 显式指定的摄像头设备；不给则用系统默认 */
  deviceId?: string;
  facingMode?: "user" | "environment";
  /** 运行期故障（目前只有摄像头中途断开）。不提供时故障不会被上报。 */
  onFault?: CaptureFaultHandler;
}

export interface CaptureHandle {
  stop: () => void;
  /** 实际请求到的约束（用于和实测频率对比） */
  actualFps: number | null;
  video: HTMLVideoElement;
}

/**
 * 采集源的运行期故障回调。
 *
 * 目前只有一种：**媒体轨道中途结束**（摄像头被拔掉、被别的程序抢占、
 * 设备休眠）。这不是"启动失败"——启动是成功的，失败发生在中途，
 * 所以 `startCapture` 的 catch 拦不到它。
 *
 * 为什么必须上报：轨道结束后视频停在最后一帧、`readyState` 变成 `ended`，
 * 但界面**没有任何变化** —— 徽标照样显示"采集中"、状态栏照样说"等待有效挥拍"。
 * 用户会一直干等一个永远不会再来的画面。实测确认过这个行为。
 */
export type CaptureFaultHandler = (fault: {
  code: "camera_disconnected";
  message: string;
  hint: string;
}) => void;

/** 原始错误摘要。不做归类和翻译 —— 那是 message/hint 的事。 */
function rawDetail(err: unknown): string {
  const e = err as { name?: string; message?: string };
  const name = e.name ? String(e.name) : "";
  const message = e.message ? String(e.message) : "";
  if (name && message) return `${name}: ${message}`;
  if (name) return name;
  if (message) return message;
  return String(err);
}

export function describeCameraError(err: unknown): CaptureError {
  const e = err as { name?: string; message?: string; constraint?: string };
  const name = e.name ?? "";
  const detail = rawDetail(err);

  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      code: "camera_permission_denied",
      message: "摄像头权限被拒绝",
      hint:
        "浏览器地址栏的权限图标里允许摄像头；确认页面在 localhost 或 HTTPS 下打开。" +
        "局域网 IP + HTTP 无法使用摄像头。",
      detail,
    };
  }
  if (name === "NotFoundError") {
    return {
      code: "camera_unavailable",
      message: "浏览器没有枚举到任何摄像头",
      hint:
        "这是「一个摄像头都看不到」，与「被其它程序占用」是两回事（后者会提示占用）。" +
        "确认页面是在桌面版 Chrome / Edge 里打开的 —— App 内置浏览器与网页视图" +
        "（微信、钉钉、IDE 预览面板等）常常不暴露摄像头。" +
        "如果确实是桌面浏览器，再检查 Windows「隐私和安全性 → 相机」的总开关与" +
        "「让桌面应用访问你的相机」、以及设备管理器里摄像头是否被禁用。",
      detail,
    };
  }
  if (name === "OverconstrainedError") {
    return {
      code: "camera_unavailable",
      message: `摄像头无法满足请求的画面参数${e.constraint ? `：${e.constraint}` : ""}`,
      hint: "在「视频源」里换一个摄像头设备后重试，或改用导入视频。",
      detail,
    };
  }
  if (name === "NotReadableError") {
    return {
      code: "camera_unavailable",
      message: "摄像头被其它程序占用或无法读取",
      hint: "关闭正在使用摄像头的会议软件后重试。",
      detail,
    };
  }
  if (name === "AbortError" || name === "TimeoutError") {
    // 实测（2026-09-16，本机真实摄像头）就是这么失败的：
    // 设备**能枚举出来**，但 `getUserMedia` 抛 `AbortError: Timeout starting video source`。
    // 它与 NotFoundError（一个都枚举不到）、NotReadableError（立刻被判占用）都不同，
    // 描述的是"设备在、但一直没画面"，所以必须单独给指引 ——
    // 否则会落到兜底文案里，只吐一句英文原文，用户无从下手。
    return {
      code: "camera_unavailable",
      message: "摄像头已找到，但一直没有画面（启动超时）",
      hint:
        "设备在列表里能看到，却取不到流。常见原因：" +
        "① 被其它程序独占（会议、直播、XR 头显配套软件等）；" +
        "② Windows「隐私和安全性 → 相机」里禁止了桌面应用访问；" +
        "③ USB 供电不足或接触不良 —— 换个 USB 口重新插一次；" +
        "④ 那是虚拟摄像头（例如 XR 头显注册的设备），本身不产生画面。" +
        "在「视频源」里逐个换设备试；实在不行改用导入视频。",
      detail,
    };
  }
  return {
    code: "camera_unavailable",
    message: e.message ?? "摄像头启动失败",
    hint: "可以改用导入视频继续验证链路。",
    detail,
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
          // 显式选设备时才用 exact —— 设备被拔掉时它会给出一条
          // 可辨认的 OverconstrainedError，而不是静默换一个摄像头
          ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
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

  /*
   * 摄像头中途不可用的检测。**两条路都要**，实测确认缺一不可：
   *
   * 1. 事件 `ended` / `mute` —— 设备被拔掉 / 被抢占 / 休眠时浏览器通常派发；
   * 2. 周期性存活探测 —— 因为**事件并不可靠**：实测 `track.stop()` 会让
   *    `readyState` 立刻变成 `ended`，却**不派发任何事件**。真正拔设备时
   *    浏览器是否派发取决于实现，光靠事件会漏。
   *
   * 不检测的后果（实测确认过）：画面停在最后一帧，而徽标照样显示"采集中"、
   * 状态栏照样说"等待有效挥拍" —— 用户一直干等一个不会再来的画面。
   *
   * 停止训练时我们**自己**会 stop 轨道，那也会让 readyState 变 ended。
   * 用 `running` 区分"用户主动停"与"设备自己掉"。
   */
  let faultReported = false;
  const reportFault = () => {
    if (!running || faultReported) return;
    faultReported = true;
    options.onFault?.({
      code: "camera_disconnected",
      message: "摄像头已断开",
      hint:
        "画面停在最后一帧、采集已经停止。检查设备是否被拔掉或被其它程序占用，" +
        "然后重新开始训练。",
    });
  };

  const tracks = stream?.getVideoTracks() ?? [];
  for (const track of tracks) {
    track.addEventListener("ended", reportFault);
    track.addEventListener("mute", reportFault);
  }

  // 存活探测：每 500ms 检查一次轨道是否还活着。开销可忽略（读一个枚举值）。
  const livenessTimer = window.setInterval(() => {
    if (!running) return;
    for (const track of tracks) {
      if (track.readyState === "ended") {
        reportFault();
        return;
      }
    }
  }, 500);

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
    window.clearInterval(livenessTimer);
    // 停止训练时关闭摄像头并释放轨道。
    // 先摘掉监听器：停止本身也会让轨道 ended，不摘就会把自己的停止上报成"设备断开"。
    for (const track of tracks) {
      track.removeEventListener("ended", reportFault);
      track.removeEventListener("mute", reportFault);
    }
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

/**
 * 先取一次权限再枚举。
 *
 * 浏览器在授予摄像头权限**之前**不会返回设备名，`deviceId` 也是空的 ——
 * 既认不出是哪个摄像头，也没法用它来选设备。这里用一次最小开销的
 * getUserMedia 换取权限，随后立刻释放轨道。
 *
 * 拿不到权限时不抛错，照常返回当前能看到的列表：调用方要展示的是
 * 「枚举到几个」，权限失败本身由后续的 startCapture 给出具体原因。
 */
export async function listCamerasWithPermission(): Promise<MediaDeviceInfo[]> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    for (const track of stream.getTracks()) track.stop();
  } catch {
    // 故意吞掉：枚举结果本身仍有用，失败原因由 startCapture 统一报告
  }
  return listCameras();
}
