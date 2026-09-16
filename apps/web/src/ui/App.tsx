import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CoachFeedback, EvidencePacket, HealthResponse } from "@pingpong/contracts";
import {
  DEFAULT_QUALITY_CONFIG,
  DEFAULT_THRESHOLDS,
  type LocalVerdict,
} from "@pingpong/motion-core";
import { PoseEngine, type EngineStatus } from "../vision/pose-engine.js";
import { FrameScheduler, SourceEpochTracker } from "../capture/frame-scheduler.js";
import {
  listCameras,
  listCamerasWithPermission,
  startCapture,
  type CaptureError,
  type CaptureHandle,
} from "../capture/capture-source.js";
import {
  TrainingSession,
  verdictToSpeech,
  type TrainingTelemetry,
} from "../training/training-session.js";
import { drawSkeleton, drawReadyZone } from "../training/skeleton-overlay.js";
import { createKeyframeCapturer } from "../evidence/keyframe-capture.js";
import { buildTrainingConfig } from "../training/session-config.js";
import { SpeechChannel, type SpeechStatus } from "../audio/speech-channel.js";
import { analyzeGroup, fetchHealth } from "../review/api-client.js";
import { ReviewPanel, type ReviewItem } from "./ReviewPanel.js";
import { MODEL_ASSET } from "../config/model-asset.js";
import { FOCUS_OPTIONS, STROKE_TYPE_OPTIONS, CAMERA_VIEW_OPTIONS } from "../config/presets.js";

type Tab = "setup" | "practice" | "review";

export function App() {
  const [tab, setTab] = useState<Tab>("setup");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [captureError, setCaptureError] = useState<CaptureError | null>(null);
  const [statusText, setStatusText] = useState("尚未开始");
  const [running, setRunning] = useState(false);
  const [speechEnabled, setSpeechEnabled] = useState(true);
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>("idle");
  const [telemetry, setTelemetry] = useState<TrainingTelemetry | null>(null);
  const [feedback, setFeedback] = useState<CoachFeedback | null>(null);
  const [localVerdict, setLocalVerdict] = useState<LocalVerdict | null>(null);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [strokeCount, setStrokeCount] = useState(0);

  // 用户配置
  const [handedness, setHandedness] = useState<"left" | "right">("right");
  const [focusId, setFocusId] = useState(FOCUS_OPTIONS[0]!.id);
  const [cameraView, setCameraView] = useState("front");
  const [strokesPerGroup, setStrokesPerGroup] = useState(3);
  const [sourceKind, setSourceKind] = useState<"camera" | "video">("camera");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  /**
   * 导入视频是否按自拍视角镜像显示。
   *
   * 为什么做成开关而不是写死：镜像只与**素材怎么拍的**有关，与来源无关 ——
   * 手机自拍录的片段需要镜像，别人从对面拍的则不需要，二者的播放质量完全一样，
   * 程序从像素上分辨不出来。写死任何一边都会把另一半用错，而且错了的表现是
   * "骨架与人物左右相反"，看上去像识别故障（见 docs/known-failures.md F-013）。
   *
   * 摄像头不走这个开关：自拍视角是它的固有性质，没有可选项。
   */
  const [mirrorVideo, setMirrorVideo] = useState(true);
  /** 显式选定的摄像头；null = 系统默认 */
  const [videoDeviceId, setVideoDeviceId] = useState<string | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PoseEngine | null>(null);
  const schedulerRef = useRef<FrameScheduler | null>(null);
  const sessionRef = useRef<TrainingSession | null>(null);
  const captureRef = useRef<CaptureHandle | null>(null);
  const speechRef = useRef<SpeechChannel | null>(null);
  const epochRef = useRef(new SourceEpochTracker());
  const sessionIdRef = useRef(`s_${Date.now()}`);
  /** 本次会话是否已自动标定过准备区（只做一次，之后交给用户控制） */
  const autoCalibratedRef = useRef(false);

  // 健康检查：让用户一开始就知道后端的模型模式
  useEffect(() => {
    void fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  // 语音通道
  useEffect(() => {
    const ch = new SpeechChannel();
    speechRef.current = ch;
    const off = ch.onStatusChange(setSpeechStatus);
    return () => {
      off();
      ch.dispose();
      speechRef.current = null;
    };
  }, []);

  useEffect(() => {
    speechRef.current?.setEnabled(speechEnabled);
  }, [speechEnabled]);

  /**
   * 枚举视频输入设备。
   *
   * 为什么要在界面里显示数量：摄像头打不开时，「浏览器一个设备都没枚举到」
   * 与「枚举到了但打不开」是两种完全不同的故障，前者要查系统隐私开关，
   * 后者才要查占用。没有这个数字时只能靠猜。见 docs/known-failures.md F-009。
   */
  const refreshCameras = useCallback(async (withPermission = false) => {
    setCameras(withPermission ? await listCamerasWithPermission() : await listCameras());
  }, []);

  useEffect(() => {
    void refreshCameras();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const onChange = () => void refreshCameras();
    md.addEventListener("devicechange", onChange);
    return () => md.removeEventListener("devicechange", onChange);
  }, [refreshCameras]);

  const engineReady = engineStatus?.ready === true;

  /**
   * 预览与叠加层是否镜像 —— **唯一的求值点**。
   *
   * F-010 与 F-013 是同一个坑的两半：视频的 class 与 `drawSkeleton` 的 `mirrored`
   * 必须取同一个值，任何一侧漏掉或算错，骨架就会与人物左右相反。
   * 之前这两处各写了一遍表达式（都写错了），所以现在只在这里算一次，
   * 下面所有用到的地方都引用它 —— **不要**再就地重算。
   */
  const mirrored = sourceKind === "camera" ? true : mirrorVideo;

  /** 初始化姿态引擎（不含摄像头）。 */
  const initEngine = useCallback(async () => {
    if (engineRef.current) return;
    setStatusText("正在加载姿态模型…");
    const engine = new PoseEngine(MODEL_ASSET);
    engineRef.current = engine;
    try {
      const status = await engine.init();
      setEngineStatus(status);
      setStatusText(
        status.downgraded
          ? `模型已就绪（GPU 委托不可用，已降级为 ${status.delegate}）`
          : `模型已就绪（委托 ${status.delegate}，初始化 ${status.initMs}ms）`,
      );
    } catch (err) {
      setStatusText(`模型加载失败：${(err as Error).message}`);
      engineRef.current = null;
    }
  }, []);

  /** 把当前持拍手腕位置设为准备区中心（手动覆盖自动标定）。 */
  const setReadyZoneToWrist = useCallback(() => {
    const session = sessionRef.current;
    if (!session || !session.setReadyZoneToCurrentWrist()) {
      setStatusText("尚未检测到持拍手腕，请确认持拍手臂完整入镜后再试");
      return;
    }
    setStatusText("已把当前腕部位置设为准备区（手动设定），请保持该位置，随后正常挥拍");
  }, []);

  /**
   * 自动标定准备区：取腕部**停留最久**的位置。
   * 比"按一下"更稳，因为一次训练里停在准备姿势的时间远多于挥拍中。
   */
  const calibrateReadyZone = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const used = session.calibrateReadyZoneFromDwell();
    setStatusText(
      used === 0
        ? "腕部样本不足（不到 20 帧），请先让持拍手在画面里停留一两秒"
        : `已按腕部停留位置标定准备区（用了 ${used} 帧），请正常挥拍`,
    );
  }, []);

  /**
   * 停止训练：关闭摄像头、终止 Worker、取消语音。
   *
   * `message` 让调用方能覆盖状态栏文案 —— 设备故障时"已停止"会掩盖真正的原因，
   * 而练习页唯一能看到的解释就是那一行状态栏。
   */
  const stop = useCallback((message = "已停止") => {
    captureRef.current?.stop();
    captureRef.current = null;
    schedulerRef.current?.drain();
    schedulerRef.current = null;
    engineRef.current?.dispose();
    engineRef.current = null;
    speechRef.current?.cancel();
    speechRef.current?.setContext(null);
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setRunning(false);
    setStatusText(message);
  }, []);

  useEffect(() => stop, [stop]);

  /** 开始训练。 */
  const start = useCallback(async () => {
    setCaptureError(null);
    setFeedback(null);
    setLocalVerdict(null);
    setStrokeCount(0);
    autoCalibratedRef.current = false;

    if (!engineRef.current) {
      await initEngine();
    }
    const engine = engineRef.current;
    if (!engine) return;
    if (sourceKind === "video" && !videoFile) {
      setStatusText("请先选择一个视频文件");
      return;
    }

    const session = new TrainingSession(
      buildTrainingConfig({
        sessionId: sessionIdRef.current,
        handedness,
        cameraView,
        focusId,
        strokesPerGroup,
      }),
      {
        onStatus: setStatusText,
        onStroke: () => setStrokeCount((n) => n + 1),
        onFeedback: (fb, verdict) => {
          if (fb) setFeedback(fb);
          if (verdict) setLocalVerdict(verdict);
          const speech = verdictToSpeech(verdict);
          if (speech) {
            speechRef.current?.speak({
              text: speech,
              sessionId: sessionIdRef.current,
              groupId: sessionRef.current?.groupId ?? "",
              focusId,
            });
          }
        },
        onGroupComplete: (packet) => {
          void handleGroup(packet);
        },
      },
    );
    sessionRef.current = session;
    speechRef.current?.setContext({
      sessionId: sessionIdRef.current,
      groupId: session.groupId,
      focusId,
    });

    // 引擎结果 → 会话
    const offResult = engine.onResult((result) => {
      sessionRef.current?.pushPoseResult(result);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = result.imageWidth;
        canvas.height = result.imageHeight;
        if (result.detected) {
          drawSkeleton(canvas, result.keypoints2D, handedness, {
            mirrored,
            // 与 TrainingSession 里"体尺度/准备区"同一个门槛（F-036）：
            // 同一个事实（这具身体看得清吗）只允许有一个定义。
            // 写死 0.5 会让两处各漂各的 —— 本项目已经栽过好几次。
            minScore: DEFAULT_QUALITY_CONFIG.minScore,
          });
        } else {
          canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
        }
        // 准备区始终可见，让用户确认本组约束位置（也方便排查"等待有效挥拍"）
        drawReadyZone(
          canvas,
          sessionRef.current?.readyZoneDisplay ?? null,
          sourceKind === "camera",
        );
      }
      const session = sessionRef.current;
      setTelemetry(session?.telemetry ?? null);

      // 自动标定准备区：默认位置是写死的，几乎不可能刚好落在你的准备姿势上，
      // 而准备区不对的表现就是"一直等待有效挥拍"。攒够腕部样本后自动标定一次，
      // 用户随时可以用「以当前腕部为准备区」手动覆盖。界面会如实标注是哪种。
      if (session && !autoCalibratedRef.current && session.telemetry.wristVisible) {
        const used = session.calibrateReadyZoneFromDwell();
        if (used > 0) {
          autoCalibratedRef.current = true;
          setStatusText(`已按腕部停留位置自动标定准备区（${used} 帧），请正常挥拍`);
        }
      }
    });

    const keyframeCapturer = createKeyframeCapturer();
    const scheduler = new FrameScheduler(async (frame) => {
      // ⚠️ 关键帧像素必须在下面那步**之前**取：`engine.detect` 会把位图的
      // 所有权转移给 Worker，转移之后主线程就再也拿不到像素了（F-028）。
      // 这里只做"放进缓存"，成组时再由 selectRepresentativeFrames 回溯挑选。
      // 编码是异步的，且**不阻塞** detect —— 采集与推理不能等它（红线 9）。
      keyframeCapturer.captureIfDue(sessionRef.current, frame);
      engine.detect({
        frameId: frame.frameId,
        sourceEpoch: frame.sourceEpoch,
        sourceTimeMs: frame.sourceTimeMs,
        receivedAtMonoMs: frame.receivedAtMonoMs,
        bitmap: frame.bitmap,
      });
    });
    schedulerRef.current = scheduler;

    const offReset = epochRef.current.onReset(() => {
      sessionRef.current?.resetSegmentation();
    });

    try {
      const handle = await startCapture({
        kind: sourceKind,
        deviceId: videoDeviceId ?? undefined,
        getEpoch: () => epochRef.current.current,
        onFrame: (frame) => scheduler.submit(frame),
        requestedFps: 60,
        videoFile: videoFile ?? undefined,
        /**
         * 摄像头中途断开：必须真的停下来，并如实说明。
         *
         * 不处理的后果（实测确认过）：轨道 `readyState` 变成 `ended`、
         * 画面停在最后一帧，而徽标照样显示"采集中"、状态栏照样说
         * "等待有效挥拍" —— 用户会一直干等一个不会再来的画面。
         *
         * 这里复用 stop() 走完整的收尾路径（关轨道、终止 Worker、取消语音），
         * 而不是只改一句文案 —— 半停状态比不停更容易误导。
         */
        onFault: (fault) => {
          setCaptureError({
            code: "camera_unavailable",
            message: fault.message,
            hint: fault.hint,
          });
          // 注意：不能用 stop() —— 它会把状态栏设成"已停止"，
          // 而摄像头断开时用户就在练习页，唯一能看到的解释就是这行状态栏。
          stop("摄像头已断开，采集已停止");
        },
      });
      captureRef.current = handle;
      // 授权成功后浏览器才返回设备名，这里补一次枚举把名称填上
      void refreshCameras();

      // 默认准备区：画面中心偏下
      const w = handle.video.videoWidth || 1280;
      const h = handle.video.videoHeight || 720;
      session.setReadyZone({ x: w / 2, y: h * 0.62 });

      setRunning(true);
      setTab("practice");
      setStatusText("已开始采集，等待有效挥拍");
    } catch (err) {
      const e = err as CaptureError;
      setCaptureError(e);
      setStatusText(e.message ?? "采集启动失败");
      offResult();
      offReset();
    }

    return () => {
      offResult();
      offReset();
    };
    // handleGroup 通过 ref 读取最新状态，这里不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    handedness,
    focusId,
    cameraView,
    strokesPerGroup,
    sourceKind,
    videoFile,
    videoDeviceId,
    // mirrored 由 sourceKind + mirrorVideo 推导，两个来源都要在依赖里 ——
    // 少了 mirrorVideo，改了开关不会重建结果回调，镜像仍按旧值绘制。
    mirrorVideo,
    refreshCameras,
    initEngine,
  ]);

  /**
   * 把采集流接到界面上的 <video>。
   *
   * 采集用的 video 元素是离屏创建的：点「开始训练」时界面还停在「拍摄检查」页，
   * 练习页的 <video> 尚未挂载，此时直接赋值会落空（元素为 null），
   * 于是切到练习页后只有一块黑屏。等元素真正挂载后再接一次。
   */
  useEffect(() => {
    const el = videoRef.current;
    const handle = captureRef.current;
    // 同一路采集不重复赋值：给导入视频重新赋 src 会让预览跳回开头
    if (
      !el ||
      !handle ||
      (el.srcObject === handle.video.srcObject && el.src === handle.video.src)
    ) {
      return;
    }
    el.srcObject = handle.video.srcObject;
    if (sourceKind === "video") el.src = handle.video.src;
    void el.play().catch(() => {
      /* 自动播放被拦截时用户可手动点击播放 */
    });
  }, [tab, running, sourceKind]);

  /** 一组完成后：发起一次模型分析，并把结果并入复查。 */
  const handleGroup = useCallback(async (packet: EvidencePacket) => {
    const groupAtStart = packet.groupId;
    setStatusText(`本组证据已就绪（${packet.strokes.length} 次挥拍），正在请求分析…`);
    const outcome = await analyzeGroup(packet);

    // 写入复查记录
    const item: ReviewItem = {
      requestId: packet.requestId,
      groupId: packet.groupId,
      sessionId: packet.sessionId,
      focusId: packet.focusId,
      packet,
      feedback: outcome.feedback,
      error: outcome.error,
      elapsedMs: outcome.elapsedMs,
      deduplicated: outcome.deduplicated,
      userRating: null,
    };
    setReviews((prev) => [item, ...prev].slice(0, 30));

    if (outcome.feedback) {
      setFeedback(outcome.feedback);
      // 只在仍是同一分组的上下文下播报
      if (outcome.feedback.cue) {
        const spoke = speechRef.current?.speak({
          text: outcome.feedback.cue,
          sessionId: packet.sessionId,
          groupId: packet.groupId,
          focusId: packet.focusId,
        });
        if (!spoke) {
          setStatusText("反馈已保存；语音未播报（上下文已切换或语音不可用）");
          return;
        }
      }
      setStatusText(`本组反馈已送达（${Math.round(outcome.elapsedMs)}ms）`);
    } else if (outcome.error) {
      // 模型失败不影响本地训练
      setStatusText(`模型侧未返回结论（${outcome.error.code}），本地训练继续，可查看复查页`);
    }

    // 更新语音上下文到下一组
    speechRef.current?.setContext({
      sessionId: packet.sessionId,
      groupId: groupAtStart,
      focusId: packet.focusId,
    });
  }, []);

  const rateReview = useCallback((requestId: string, rating: ReviewItem["userRating"]) => {
    setReviews((prev) =>
      prev.map((r) => (r.requestId === requestId ? { ...r, userRating: rating } : r)),
    );
  }, []);

  const exportSamples = useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      sessionId: sessionIdRef.current,
      modelMode: health?.modelMode ?? "unknown",
      ruleVersion: health?.ruleVersion ?? null,
      note: "真实视频与含个人信息的数据不入库；本导出仅含测量、反馈与用户评价。",
      reviews: reviews.map((r) => ({
        requestId: r.requestId,
        groupId: r.groupId,
        focusId: r.focusId,
        feedback: r.feedback,
        error: r.error,
        elapsedMs: r.elapsedMs,
        userRating: r.userRating,
        features: r.packet.features,
        strokes: r.packet.strokes.map((s) => ({
          strokeId: s.strokeId,
          startMs: s.startMs,
          endMs: s.endMs,
          anchor: s.anchor,
          complete: s.complete,
        })),
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pingpong-samples-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [reviews, health]);

  const modelMode = health?.modelMode ?? "unknown";

  return (
    <div className="app">
      <div className="topbar">
        <h1>PingPong Coach</h1>
        <span className={`badge ${modelMode === "mock" ? "warn" : "ok"}`}>
          {modelMode === "mock" ? "mock 模型模式" : modelMode === "live" ? "真实模型" : "后端未知"}
        </span>
        <span className="badge muted">P0–P1</span>
        {/* 用真正的 button 而不是带 onClick 的 div：
            div 不可聚焦、不能用键盘激活、屏幕阅读器也读不出"这是个可切换的东西"。
            role/aria-selected 让辅助技术知道这是一组选项卡以及当前选中哪个。 */}
        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "setup"}
            className={`tab ${tab === "setup" ? "active" : ""}`}
            onClick={() => setTab("setup")}
          >
            拍摄检查
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "practice"}
            className={`tab ${tab === "practice" ? "active" : ""}`}
            onClick={() => setTab("practice")}
          >
            练习
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "review"}
            className={`tab ${tab === "review" ? "active" : ""}`}
            onClick={() => setTab("review")}
          >
            复查 {reviews.length > 0 && `(${reviews.length})`}
          </button>
        </div>
      </div>

      {modelMode === "mock" && (
        <div className="notice warn">
          <strong>当前为 mock 模式</strong>：后端未配置真实模型密钥，反馈由本地规则与 mock
          输出生成。 界面上的耗时与结论<strong>不代表真实模型质量或延迟</strong>。配置{" "}
          <span className="mono">MODEL_API_KEY</span>、<span className="mono">MODEL_BASE_URL</span>
          、<span className="mono">MODEL_ID</span> 后重启后端即可切换。
        </div>
      )}

      {tab === "setup" && (
        <SetupView
          {...{
            health,
            engineStatus,
            captureError,
            statusText,
            running,
            handedness,
            setHandedness,
            focusId,
            setFocusId,
            cameraView,
            setCameraView,
            strokesPerGroup,
            setStrokesPerGroup,
            sourceKind,
            setSourceKind,
            setVideoFile,
            mirrorVideo,
            setMirrorVideo,
            cameras,
            videoDeviceId,
            setVideoDeviceId,
            onRefreshCameras: (withPermission?: boolean) => void refreshCameras(withPermission),
            onInitEngine: initEngine,
            onStart: () => void start(),
            engineReady,
          }}
        />
      )}

      {tab === "practice" && (
        <PracticeView
          {...{
            videoRef,
            canvasRef,
            running,
            statusText,
            telemetry,
            feedback,
            localVerdict,
            strokeCount,
            strokesPerGroup,
            speechEnabled,
            setSpeechEnabled,
            speechStatus,
            onStart: () => void start(),
            onStop: stop,
            handedness,
            mirrored,
            onSetReadyZoneToWrist: setReadyZoneToWrist,
            onCalibrateReadyZone: calibrateReadyZone,
          }}
        />
      )}

      {tab === "review" && (
        <ReviewPanel
          reviews={reviews}
          onRate={rateReview}
          onExport={exportSamples}
          thresholds={DEFAULT_THRESHOLDS}
        />
      )}
    </div>
  );
}

// ── 拍摄检查 ────────────────────────────────────────────────

interface SetupProps {
  health: HealthResponse | null;
  engineStatus: EngineStatus | null;
  captureError: CaptureError | null;
  statusText: string;
  running: boolean;
  handedness: "left" | "right";
  setHandedness: (v: "left" | "right") => void;
  focusId: string;
  setFocusId: (v: string) => void;
  cameraView: string;
  setCameraView: (v: string) => void;
  strokesPerGroup: number;
  setStrokesPerGroup: (v: number) => void;
  sourceKind: "camera" | "video";
  setSourceKind: (v: "camera" | "video") => void;
  setVideoFile: (f: File | null) => void;
  /** 导入视频是否按自拍视角镜像（见 F-013） */
  mirrorVideo: boolean;
  setMirrorVideo: (v: boolean) => void;
  cameras: MediaDeviceInfo[];
  videoDeviceId: string | null;
  setVideoDeviceId: (v: string | null) => void;
  onRefreshCameras: (withPermission?: boolean) => void;
  onInitEngine: () => Promise<void>;
  onStart: () => void;
  engineReady: boolean;
}

function SetupView(props: SetupProps) {
  // 只有拿到权限后浏览器才会给出 deviceId 与设备名；没有这些就无法按设备选择
  const selectableCameras = props.cameras.filter((c) => c.deviceId !== "");
  const hasVisibleLabels = props.cameras.length > 0 && props.cameras.every((c) => c.label === "");
  // 每个控件的稳定 id：label 必须通过 htmlFor 关联到控件，
  // 否则屏幕阅读器读不出这个输入是干什么的，自动化测试也定位不到。
  const uid = useId();

  return (
    <div className="grid two">
      <div>
        <div className="panel">
          <h2>1 · 本次训练设置</h2>
          <div className="row">
            <div className="field">
              <label htmlFor={`${uid}-stroke`}>动作</label>
              <select id={`${uid}-stroke`} disabled>
                {STROKE_TYPE_OPTIONS.map((o) => (
                  <option key={o.id}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${uid}-handedness`}>持拍手</label>
              <select
                id={`${uid}-handedness`}
                value={props.handedness}
                onChange={(e) => props.setHandedness(e.target.value as "left" | "right")}
              >
                <option value="right">右手持拍</option>
                <option value="left">左手持拍</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${uid}-view`}>机位</label>
              <select
                id={`${uid}-view`}
                value={props.cameraView}
                onChange={(e) => props.setCameraView(e.target.value)}
              >
                {/*
                  用常量渲染，**不要**把选项再手写一遍 ——
                  手写的那一份会与 presets 漂移，而漂移了没人会发现
                  （两边同时改的可能性远低于只改一边）。
                */}
                {CAMERA_VIEW_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="spacer" />
          <div className="row">
            <div className="field">
              <label htmlFor={`${uid}-focus`}>本组关注点（一次只看一个）</label>
              <select
                id={`${uid}-focus`}
                value={props.focusId}
                onChange={(e) => props.setFocusId(e.target.value)}
              >
                {FOCUS_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${uid}-pergroup`}>每组有效挥拍数</label>
              <select
                id={`${uid}-pergroup`}
                value={props.strokesPerGroup}
                onChange={(e) => props.setStrokesPerGroup(Number(e.target.value))}
              >
                <option value={1}>1 次</option>
                <option value={3}>3 次（默认）</option>
                <option value={5}>5 次</option>
              </select>
            </div>
          </div>
          {props.focusId !== "return_to_ready_zone" && (
            <div className="notice warn">
              首版仅对「回到本组准备区域」做了明确约束。其它关注点会把对应测量
              （如「肘角伸展模式」的<b>腕速峰值处肘角</b>）算出来并交给模型印证， 但
              <b>不做达标判断</b> —— 规则未审核时只输出观察。
            </div>
          )}
        </div>

        <div className="panel">
          <h2>2 · 视频源</h2>
          <div className="row">
            <div className="field">
              <label htmlFor={`${uid}-source`}>来源</label>
              <select
                id={`${uid}-source`}
                value={props.sourceKind}
                onChange={(e) => props.setSourceKind(e.target.value as "camera" | "video")}
              >
                <option value="camera">本机摄像头</option>
                <option value="video">导入视频</option>
              </select>
            </div>
            {props.sourceKind === "camera" && selectableCameras.length > 0 && (
              <div className="field">
                <label htmlFor={`${uid}-device`}>摄像头设备</label>
                <select
                  id={`${uid}-device`}
                  value={props.videoDeviceId ?? ""}
                  onChange={(e) =>
                    props.setVideoDeviceId(e.target.value === "" ? null : e.target.value)
                  }
                >
                  <option value="">系统默认</option>
                  {selectableCameras.map((c, i) => (
                    <option key={c.deviceId} value={c.deviceId}>
                      {c.label || `视频设备 ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {props.sourceKind === "video" && (
              <div className="field">
                <label htmlFor={`${uid}-file`}>视频文件</label>
                <input
                  id={`${uid}-file`}
                  type="file"
                  accept="video/*"
                  onChange={(e) => props.setVideoFile(e.target.files?.[0] ?? null)}
                />
              </div>
            )}
          </div>
          {props.sourceKind === "video" && (
            <div className="row" style={{ marginTop: 8 }}>
              <div className="field">
                <label htmlFor={`${uid}-mirror`}>预览镜像</label>
                <select
                  id={`${uid}-mirror`}
                  value={props.mirrorVideo ? "yes" : "no"}
                  onChange={(e) => props.setMirrorVideo(e.target.value === "yes")}
                >
                  <option value="yes">镜像（手机自拍录制）</option>
                  <option value="no">不镜像（他人从对面拍摄）</option>
                </select>
              </div>
            </div>
          )}
          {props.sourceKind === "video" && (
            <div className="small muted" style={{ marginTop: 6 }}>
              镜像只与<b>素材怎么拍的</b>有关，与文件本身无关 —— 程序从像素上分辨不出来。
              选错了的表现是<b>骨架与人物左右相反</b>（看起来像识别故障）。
              摄像头没有这个选项：自拍视角是它的固有性质。
            </div>
          )}
          {props.sourceKind === "camera" && (
            <>
              <div className="small muted">
                浏览器当前枚举到 <strong>{props.cameras.length}</strong> 个视频输入设备。
                {props.cameras.length === 0 &&
                  "一个都没有，说明浏览器拿不到系统摄像头 —— 这与画面设置无关。"}
                {hasVisibleLabels && "设备名为空是正常的：浏览器只在授予摄像头权限后才返回名称。"}
              </div>
              <div className="small muted mono">当前浏览器：{navigator.userAgent}</div>
              <div className="row">
                <button onClick={() => props.onRefreshCameras()}>重新枚举设备</button>
                <button onClick={() => props.onRefreshCameras(true)}>授权并刷新设备名</button>
              </div>
            </>
          )}
          {props.captureError && (
            <div className="notice danger">
              <strong>{props.captureError.message}</strong>
              <div className="small">{props.captureError.hint}</div>
              {props.captureError.detail && (
                <div className="small mono">原始错误：{props.captureError.detail}</div>
              )}
            </div>
          )}
          <div className="small muted">
            局域网用手机访问电脑服务需要可信 HTTPS；电脑本机 localhost 可直接使用摄像头。
          </div>
        </div>

        <div className="panel">
          <h2>3 · 画面检查</h2>
          <ul className="tight small">
            <li>持拍侧肩、肘、腕在画面内且不被遮挡</li>
            <li>机位固定，不要手持或移动</li>
            <li>光线足够，避免强烈逆光</li>
            <li>人与相机距离保持稳定，让身体在画面中占据合适比例</li>
          </ul>
          <div className="row">
            <button onClick={() => void props.onInitEngine()} disabled={props.engineReady}>
              {props.engineReady ? "模型已加载" : "加载姿态模型"}
            </button>
            <button className="primary" onClick={props.onStart} disabled={props.running}>
              开始训练
            </button>
          </div>
          <div className="spacer" />
          <div className="small">{props.statusText}</div>
        </div>
      </div>

      <div>
        <div className="panel">
          <h2>运行环境</h2>
          {props.health ? (
            <table>
              <tbody>
                <tr>
                  <td>后端</td>
                  <td>
                    <span className="badge ok">在线</span>
                  </td>
                </tr>
                <tr>
                  <td>模型模式</td>
                  <td>
                    <span className={`badge ${props.health.modelMode === "mock" ? "warn" : "ok"}`}>
                      {props.health.modelMode}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>模型 ID</td>
                  <td className="mono">{props.health.modelId}</td>
                </tr>
                <tr>
                  <td>规则版本</td>
                  <td className="mono">{props.health.ruleVersion}</td>
                </tr>
                <tr>
                  <td>知识版本</td>
                  <td className="mono">{props.health.knowledgeVersion}</td>
                </tr>
                <tr>
                  <td>Node</td>
                  <td className="mono">{props.health.nodeVersion}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <div className="notice warn">
              未能连接后端。本地骨架预览仍可用，但不会得到模型反馈。 启动后端：
              <span className="mono">pnpm dev:api</span>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>姿态引擎</h2>
          {props.engineStatus?.ready ? (
            <table>
              <tbody>
                <tr>
                  <td>委托方式</td>
                  <td>
                    <span className={`badge ${props.engineStatus.downgraded ? "warn" : "ok"}`}>
                      {props.engineStatus.delegate}
                      {props.engineStatus.downgraded ? "（已降级）" : ""}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>模型</td>
                  <td className="mono">{props.engineStatus.modelId}</td>
                </tr>
                <tr>
                  <td>关键点集</td>
                  <td className="mono">{props.engineStatus.keypointSet}</td>
                </tr>
                <tr>
                  <td>手部细节</td>
                  <td>
                    {props.engineStatus.handModelAvailable ? (
                      <span className="badge ok">可用（21 点/手）</span>
                    ) : (
                      <span className="badge warn">不可用</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <td>初始化耗时</td>
                  <td className="num">{props.engineStatus.initMs} ms</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <div className="small muted">
              尚未加载模型。模型与 WASM 通过本项目静态资源提供，请先运行{" "}
              <span className="mono">pnpm models:fetch</span>。
            </div>
          )}
        </div>

        <div className="panel">
          <h2>首版能力边界</h2>
          <ul className="tight small">
            <li>只处理定点正手攻球、单人、固定机位</li>
            <li>只测量可见的二维关节位置与角度</li>
            <li>
              手部 21 点<b>只用于测量</b>可见的指关节几何；<b>不</b>推断拍面朝向、握力或发力大小 ——
              单目二维确定不了这些
            </li>
            <li>不判断肌肉紧张、发力大小、足底承重、精确拍面</li>
            <li>锚点是腕部速度峰值，不是已确认的击球时刻</li>
            <li>持拍手臂被遮挡时会明确提示"暂无法判断"，不会编造结论</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// ── 练习 ────────────────────────────────────────────────────

interface PracticeProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  running: boolean;
  statusText: string;
  telemetry: TrainingTelemetry | null;
  feedback: CoachFeedback | null;
  localVerdict: LocalVerdict | null;
  strokeCount: number;
  strokesPerGroup: number;
  speechEnabled: boolean;
  setSpeechEnabled: (v: boolean) => void;
  speechStatus: SpeechStatus;
  onStart: () => void;
  /**
   * 停止训练。`message` 可选 —— 设备故障等场景需要覆盖状态栏文案。
   * 注意：绑到按钮上时必须包一层箭头函数，否则 React 会把 MouseEvent
   * 当成 message 传进来，状态栏会显示成 "[object Object]"。
   */
  onStop: (message?: string) => void;
  onSetReadyZoneToWrist: () => void;
  onCalibrateReadyZone: () => void;
  handedness: "left" | "right";
  /** 预览是否镜像。必须与 drawSkeleton 的 mirrored 取同一个值 */
  mirrored: boolean;
}

const PHASE_LABELS: Record<string, string> = {
  idle: "空闲（等待进入准备区）",
  ready: "准备区驻留",
  backswing: "引拍",
  forward: "向前挥拍",
  returning: "还原",
  aborted: "异常结束",
};

function PracticeView(props: PracticeProps) {
  const speechLabel = useMemo(() => {
    switch (props.speechStatus) {
      case "speaking":
        return "播报中";
      case "unsupported":
        return "浏览器不支持";
      case "unavailable":
        return "语音不可用";
      default:
        return "待命";
    }
  }, [props.speechStatus]);

  return (
    <div className="grid two">
      <div>
        <div className="panel">
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>实时画面</h2>
            <span className={`badge ${props.running ? "ok" : "muted"}`}>
              {props.running ? "采集中" : "已停止"}
            </span>
            <div style={{ marginLeft: "auto" }} className="row">
              {!props.running ? (
                <button className="primary" onClick={props.onStart}>
                  开始
                </button>
              ) : (
                <button className="danger" onClick={() => props.onStop()}>
                  停止
                </button>
              )}
            </div>
          </div>
          <div className="stage">
            <video
              ref={props.videoRef}
              className={props.mirrored ? "mirrored" : undefined}
              playsInline
              muted
            />
            <canvas ref={props.canvasRef} />
          </div>
          <div className="spacer" />
          <div className="small muted">{props.statusText}</div>
        </div>

        <div className="panel">
          <h2>本组进度</h2>
          <div className="metrics">
            <div className="metric">
              <div className="label">已记录有效挥拍</div>
              <div className="value">
                {props.strokeCount} / {props.strokesPerGroup}
              </div>
            </div>
            <div className="metric">
              {/* 口径要说清：这是**用户真正感受到的**那段延迟（收到帧 → 骨架可用），
                  包含排队与跨线程往返。只报"推理耗时"会系统性低估它。 */}
              <div className="label" title="收到帧 → 骨架结果可用，含排队与跨线程往返">
                端到端处理延迟 P95
              </div>
              <div className="value">
                {props.telemetry?.poseLatencyP95Ms != null
                  ? `${Math.round(props.telemetry.poseLatencyP95Ms)} ms`
                  : "—"}
              </div>
            </div>
            <div className="metric">
              <div
                className="label"
                title="仅 Worker 内推理；与上面的差值 = 排队 + 跨线程 + 序列化开销"
              >
                其中推理耗时 P95
              </div>
              <div className="value">
                {props.telemetry?.poseInferenceP95Ms != null
                  ? `${Math.round(props.telemetry.poseInferenceP95Ms)} ms`
                  : "—"}
              </div>
            </div>
            <div className="metric">
              <div className="label">实测处理频率</div>
              <div className="value">
                {props.telemetry?.actualFps != null
                  ? `${props.telemetry.actualFps.toFixed(1)} fps`
                  : "—"}
              </div>
            </div>
            <div className="metric">
              <div className="label">有效帧比例</div>
              <div className="value">
                {props.telemetry != null
                  ? `${(props.telemetry.usableRatio * 100).toFixed(0)}%`
                  : "—"}
              </div>
            </div>
          </div>
          {props.telemetry != null && props.telemetry.framesDropped > 0 && (
            <div className="small muted" style={{ marginTop: 8 }}>
              已有 {props.telemetry.framesDropped} 帧因处理繁忙被丢弃（已计入质量指标）。
            </div>
          )}
          <div className="small muted" style={{ marginTop: 8 }}>
            {props.telemetry?.segmentationPhase
              ? `分段：${PHASE_LABELS[props.telemetry.segmentationPhase] ?? props.telemetry.segmentationPhase}`
              : "分段：—"}
            {props.telemetry && !props.telemetry.hasBodyScale && " · 测不到体尺度（肩或髋未入镜）"}
            {props.telemetry && !props.telemetry.wristVisible && " · 未检测到持拍手腕"}
            {props.telemetry?.segmentationLastAbortReason
              ? ` · 上次中断：${props.telemetry.segmentationLastAbortReason}`
              : ""}
          </div>
          {props.telemetry?.wristToZoneRatio != null && (
            <div
              className="small"
              style={{
                marginTop: 6,
                color: props.telemetry.wristToZoneRatio <= 1 ? "#3fb950" : "#d29922",
              }}
            >
              腕部距准备区 {props.telemetry.wristToZoneRatio.toFixed(2)} 倍半径
              {props.telemetry.wristToZoneRatio <= 1
                ? "（已在区内，可开始挥拍）"
                : "（在区外——状态机不会开始一次挥拍）"}
              {props.telemetry.readyZoneRadiusPx != null &&
                ` · 准备区半径 ${Math.round(props.telemetry.readyZoneRadiusPx)}px`}
              {props.telemetry.bodyScalePx != null &&
                ` · 体尺度 ${Math.round(props.telemetry.bodyScalePx)}px`}
            </div>
          )}
          {props.running && (
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={props.onCalibrateReadyZone}>重标定准备区</button>
              <button onClick={props.onSetReadyZoneToWrist}>以当前腕部为准备区</button>
            </div>
          )}
          {props.telemetry?.readyZoneAutoCalibrated && (
            <div className="small muted" style={{ marginTop: 6 }}>
              准备区由程序按腕部停留位置自动标定，不是既定参考 ——
              若与你的准备姿势不符，点「以当前腕部为准备区」手动覆盖。
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="panel">
          <h2>语音</h2>
          <div className="row">
            <label className="row small" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={props.speechEnabled}
                onChange={(e) => props.setSpeechEnabled(e.target.checked)}
              />
              启用语音播报
            </label>
            <span className="badge muted">{speechLabel}</span>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            语音最多排队一条；暂停、结束或切换目标时会取消旧语音。旧分组的反馈不会被播报。
          </div>
        </div>

        <div className="panel">
          <h2>本组反馈</h2>
          {props.feedback ? (
            <FeedbackCard feedback={props.feedback} />
          ) : props.localVerdict ? (
            <LocalVerdictCard verdict={props.localVerdict} />
          ) : (
            <div className="small muted">
              等待有效挥拍。低质量或非练习动作不会凑进有效挥拍数量。
            </div>
          )}
        </div>

        <div className="panel">
          <h2>说明</h2>
          <ul className="tight small">
            <li>
              每组够了只会发起<strong>一次</strong>模型请求，不逐帧上传视频。
            </li>
            <li>模型请求在途时不会积压新请求；本地分析与提示不受影响。</li>
            <li>反馈绑定会话、分组与关注点，切换后旧响应不会被播报。</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function FeedbackCard({ feedback }: { feedback: CoachFeedback }) {
  const statusLabel: Record<CoachFeedback["status"], { text: string; cls: string }> = {
    target_met: { text: "本组约束达到", cls: "ok" },
    suggest_adjustment: { text: "建议调整", cls: "warn" },
    observation_only: { text: "仅观察", cls: "muted" },
    insufficient_evidence: { text: "证据不足", cls: "danger" },
  };
  const s = statusLabel[feedback.status];

  return (
    <div className="feedback">
      <div className="row" style={{ marginBottom: 8 }}>
        <span className={`badge ${s.cls}`}>{s.text}</span>
        {feedback.mock && <span className="badge warn">mock</span>}
        <span className="badge muted">{Math.round(feedback.serverElapsedMs)}ms 服务端</span>
      </div>
      <div className="obs">{feedback.observation}</div>
      {feedback.cue && <div className="cue">提示：{feedback.cue}</div>}
      <div className="small muted" style={{ marginTop: 8 }}>
        证据引用：{feedback.evidenceRefs.length > 0 ? feedback.evidenceRefs.join("、") : "无"}
      </div>
      {feedback.limitations.length > 0 && (
        <ul className="tight small muted" style={{ marginTop: 6 }}>
          {feedback.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {feedback.rejectedClaims.length > 0 && (
        <div className="small" style={{ color: "var(--warn)", marginTop: 6 }}>
          已拒绝的不可验证结论：{feedback.rejectedClaims.join("、")}
        </div>
      )}
    </div>
  );
}

function LocalVerdictCard({ verdict }: { verdict: LocalVerdict }) {
  const text =
    verdict.kind === "target_met"
      ? "本组约束达到"
      : verdict.kind === "suggest_adjustment"
        ? "建议调整"
        : verdict.kind === "observation_only"
          ? "仅观察"
          : "证据不足";
  const cls =
    verdict.kind === "target_met"
      ? "ok"
      : verdict.kind === "suggest_adjustment"
        ? "warn"
        : verdict.kind === "observation_only"
          ? "muted"
          : "danger";

  return (
    <div className="feedback">
      <div className="row" style={{ marginBottom: 8 }}>
        <span className={`badge ${cls}`}>{text}</span>
        <span className="badge muted">本地规则</span>
      </div>
      {verdict.kind === "insufficient_evidence" ? (
        <div className="obs">{verdict.reason}</div>
      ) : (
        <>
          {"observation" in verdict && <div className="obs">{verdict.observation}</div>}
          {"cue" in verdict && verdict.cue && <div className="cue">提示：{verdict.cue}</div>}
        </>
      )}
    </div>
  );
}

// 需要 useState 在 SetupView 内可用（该组件本身无状态，保留导入以满足 JSX 类型）
void useState;
