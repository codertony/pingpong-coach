import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CoachFeedback, EvidencePacket, HealthResponse } from "@pingpong/contracts";
import { DEFAULT_THRESHOLDS, type LocalVerdict } from "@pingpong/motion-core";
import { PoseEngine, type EngineStatus } from "../vision/pose-engine.js";
import { FrameScheduler, monotonicNow, SourceEpochTracker } from "../capture/frame-scheduler.js";
import { startCapture, type CaptureError, type CaptureHandle } from "../capture/capture-source.js";
import { TrainingSession, verdictToSpeech, type TrainingTelemetry } from "../training/training-session.js";
import { drawSkeleton } from "../training/skeleton-overlay.js";
import { SpeechChannel, type SpeechStatus } from "../audio/speech-channel.js";
import { analyzeGroup, fetchHealth } from "../review/api-client.js";
import { ReviewPanel, type ReviewItem } from "./ReviewPanel.js";
import { MODEL_ASSET } from "../config/model-asset.js";
import { FOCUS_OPTIONS, STROKE_TYPE_OPTIONS } from "../config/presets.js";

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

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PoseEngine | null>(null);
  const schedulerRef = useRef<FrameScheduler | null>(null);
  const sessionRef = useRef<TrainingSession | null>(null);
  const captureRef = useRef<CaptureHandle | null>(null);
  const speechRef = useRef<SpeechChannel | null>(null);
  const epochRef = useRef(new SourceEpochTracker());
  const sessionIdRef = useRef(`s_${Date.now()}`);

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

  const engineReady = engineStatus?.ready === true;

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

  /** 停止训练：关闭摄像头、终止 Worker、取消语音。 */
  const stop = useCallback(() => {
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
    setStatusText("已停止");
  }, []);

  useEffect(() => stop, [stop]);

  /** 开始训练。 */
  const start = useCallback(async () => {
    setCaptureError(null);
    setFeedback(null);
    setLocalVerdict(null);
    setStrokeCount(0);

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
      {
        sessionId: sessionIdRef.current,
        strokeType: "forehand_drive",
        handedness,
        cameraView,
        focusId,
        strokesPerGroup,
        segmentation: {
          strokeType: "forehand_drive",
          cameraView,
          handedness,
          readyZoneRadiusBodyScale: 0.3,
          readyStableMinMs: 120,
          backswingMinDisplacementBodyScale: 0.2,
          forwardMinSpeedBodyScalePerSec: 0.5,
          returnStableMinMs: 120,
          maxGapMs: 250,
          maxStrokeDurationMs: 3000,
        },
      },
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
      if (canvas && result.detected) {
        canvas.width = result.imageWidth;
        canvas.height = result.imageHeight;
        drawSkeleton(canvas, result.keypoints2D, handedness, {
          mirrored: sourceKind === "camera",
          minScore: 0.5,
        });
      }
      setTelemetry(sessionRef.current?.telemetry ?? null);
    });

    const scheduler = new FrameScheduler(async (frame) => {
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
        getEpoch: () => epochRef.current.current,
        onFrame: (frame) => scheduler.submit(frame),
        requestedFps: 60,
        videoFile: videoFile ?? undefined,
      });
      captureRef.current = handle;

      // 把采集视频挂到界面上
      if (videoRef.current) {
        videoRef.current.srcObject = handle.video.srcObject;
        if (sourceKind === "video") {
          videoRef.current.src = handle.video.src;
        }
        await videoRef.current.play().catch(() => {
          /* 自动播放被拦截时用户可手动点击播放 */
        });
      }

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
  }, [handedness, focusId, cameraView, strokesPerGroup, sourceKind, videoFile, initEngine]);

  /** 一组完成后：发起一次模型分析，并把结果并入复查。 */
  const handleGroup = useCallback(
    async (packet: EvidencePacket) => {
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
        setStatusText(
          `模型侧未返回结论（${outcome.error.code}），本地训练继续，可查看复查页`,
        );
      }

      // 更新语音上下文到下一组
      speechRef.current?.setContext({
        sessionId: packet.sessionId,
        groupId: groupAtStart,
        focusId: packet.focusId,
      });
    },
    [],
  );

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
        <div className="tabs">
          <div className={`tab ${tab === "setup" ? "active" : ""}`} onClick={() => setTab("setup")}>
            拍摄检查
          </div>
          <div className={`tab ${tab === "practice" ? "active" : ""}`} onClick={() => setTab("practice")}>
            练习
          </div>
          <div className={`tab ${tab === "review" ? "active" : ""}`} onClick={() => setTab("review")}>
            复查 {reviews.length > 0 && `(${reviews.length})`}
          </div>
        </div>
      </div>

      {modelMode === "mock" && (
        <div className="notice warn">
          <strong>当前为 mock 模式</strong>：后端未配置真实模型密钥，反馈由本地规则与 mock 输出生成。
          界面上的耗时与结论<strong>不代表真实模型质量或延迟</strong>。配置 <span className="mono">MODEL_API_KEY</span>、
          <span className="mono">MODEL_BASE_URL</span>、<span className="mono">MODEL_ID</span> 后重启后端即可切换。
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
  onInitEngine: () => Promise<void>;
  onStart: () => void;
  engineReady: boolean;
}

function SetupView(props: SetupProps) {
  return (
    <div className="grid two">
      <div>
        <div className="panel">
          <h2>1 · 本次训练设置</h2>
          <div className="row">
            <div className="field">
              <label>动作</label>
              <select disabled>
                {STROKE_TYPE_OPTIONS.map((o) => (
                  <option key={o.id}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>持拍手</label>
              <select
                value={props.handedness}
                onChange={(e) => props.setHandedness(e.target.value as "left" | "right")}
              >
                <option value="right">右手持拍</option>
                <option value="left">左手持拍</option>
              </select>
            </div>
            <div className="field">
              <label>机位</label>
              <select value={props.cameraView} onChange={(e) => props.setCameraView(e.target.value)}>
                <option value="front">正面</option>
                <option value="front_right_diagonal">右前斜</option>
                <option value="front_left_diagonal">左前斜</option>
                <option value="right_side">右侧</option>
                <option value="unknown">不确定</option>
              </select>
            </div>
          </div>
          <div className="spacer" />
          <div className="row">
            <div className="field">
              <label>本组关注点（一次只看一个）</label>
              <select value={props.focusId} onChange={(e) => props.setFocusId(e.target.value)}>
                {FOCUS_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>每组有效挥拍数</label>
              <select
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
              首版仅对「回到本组准备区域」做了明确约束。其它关注点当前只输出观察，不做达标判断。
            </div>
          )}
        </div>

        <div className="panel">
          <h2>2 · 视频源</h2>
          <div className="row">
            <div className="field">
              <label>来源</label>
              <select
                value={props.sourceKind}
                onChange={(e) => props.setSourceKind(e.target.value as "camera" | "video")}
              >
                <option value="camera">本机摄像头</option>
                <option value="video">导入视频</option>
              </select>
            </div>
            {props.sourceKind === "video" && (
              <div className="field">
                <label>视频文件</label>
                <input
                  type="file"
                  accept="video/*"
                  onChange={(e) => props.setVideoFile(e.target.files?.[0] ?? null)}
                />
              </div>
            )}
          </div>
          {props.captureError && (
            <div className="notice danger">
              <strong>{props.captureError.message}</strong>
              <div className="small">{props.captureError.hint}</div>
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
              未能连接后端。本地骨架预览仍可用，但不会得到模型反馈。
              启动后端：<span className="mono">pnpm dev:api</span>
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
  onStop: () => void;
  handedness: "left" | "right";
}

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
                <button className="danger" onClick={props.onStop}>
                  停止
                </button>
              )}
            </div>
          </div>
          <div className="stage">
            <video ref={props.videoRef} playsInline muted />
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
              <div className="label">姿态处理 P95</div>
              <div className="value">
                {props.telemetry?.poseProcessingP95Ms != null
                  ? `${Math.round(props.telemetry.poseProcessingP95Ms)} ms`
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
                {props.telemetry != null ? `${(props.telemetry.usableRatio * 100).toFixed(0)}%` : "—"}
              </div>
            </div>
          </div>
          {props.telemetry != null && props.telemetry.framesDropped > 0 && (
            <div className="small muted" style={{ marginTop: 8 }}>
              已有 {props.telemetry.framesDropped} 帧因处理繁忙被丢弃（已计入质量指标）。
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
            <li>每组够了只会发起<strong>一次</strong>模型请求，不逐帧上传视频。</li>
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
