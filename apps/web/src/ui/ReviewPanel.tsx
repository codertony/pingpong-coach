import { Fragment, useEffect, useRef, useState } from "react";
import type {
  CoachFeedback,
  EvidenceKeyframe,
  EvidencePacket,
  FeatureValue,
  StrokeEvent,
} from "@pingpong/contracts";
import { PHASE_EVENT_LABEL } from "@pingpong/contracts";
import type { ThresholdConfig } from "@pingpong/motion-core";
import type { ElbowTrace } from "../training/training-session.js";
import { ElbowCurve } from "./ElbowCurve.js";

export type UserRating = "helpful" | "inaccurate" | "unclear";

export interface ReviewItem {
  requestId: string;
  groupId: string;
  sessionId: string;
  focusId: string;
  packet: EvidencePacket;
  feedback: CoachFeedback | null;
  error: { code: string; message: string; details: string[] } | null;
  elapsedMs: number;
  deduplicated: boolean;
  userRating: UserRating | null;
  /**
   * 这一组是从哪来的。
   *
   * 为什么复查记录要记住它：**摄像头链路不录制视频**（只保留关键帧），
   * 所以"能不能回放"取决于这一组当时的来源，而不是当前选的是什么。
   * 不记的话，切一次来源就会给一组没有录像的数据配一个回放按钮。
   */
  sourceKind: "camera" | "video";
  /** 来源是视频时的文件名，用于确认"要回放的就是这一支" */
  videoFileName: string | null;
  /**
   * 本组的逐帧肘角曲线（`null` = 没取到，比如这一组没有任何一板）。
   *
   * 为什么挂在复查记录上而不是进证据包：它的读者是**这张图**，不是模型
   * （见 `TrainingSession.groupElbowTrace` 的说明）。
   */
  elbowTrace: ElbowTrace | null;
}

/** 可回放的那支视频（由上层交出；没有就是没有，不给替代品）。 */
export interface ReplaySource {
  url: string;
  fileName: string;
}

interface Props {
  reviews: ReviewItem[];
  onRate: (requestId: string, rating: UserRating) => void;
  onExport: () => void;
  thresholds: ThresholdConfig;
  replay: ReplaySource | null;
}

/**
 * 这一组能不能回放；不能的话，**为什么**。
 *
 * 三种"不能"必须分开说 —— 合成一句"不可用"会把三种完全不同的处境混成一个：
 * 1. 摄像头来的：**根本没有录像**（链路只保留关键帧，不做录制）；
 * 2. 视频来的，但那支文件已经不在了（刷新过、重新选过）；
 * 3. 视频来的、文件也在，但**不是这一组用的那一支** —— 这一种最危险：
 *    看起来能放，实际时间轴对不上，等于拿一段不相干的画面当这一板的证据。
 */
type ReplayStatus = { ok: true; source: ReplaySource } | { ok: false; reason: string };

function replayStatus(item: ReviewItem, replay: ReplaySource | null): ReplayStatus {
  if (item.sourceKind === "camera") {
    return {
      ok: false,
      reason:
        "这一组来自摄像头：本地链路不录制视频（只保留关键帧），所以没有画面可回放。" +
        "要看细节请用下面「关键帧」那一栏。",
    };
  }
  const name = item.videoFileName ?? "（文件名未知）";
  if (!replay) {
    return {
      ok: false,
      reason: `这一组来自视频「${name}」，但那支文件已不在本页（刷新过或重新选过）—— 重新导入同一支视频才能回放。`,
    };
  }
  if (item.videoFileName != null && replay.fileName !== item.videoFileName) {
    return {
      ok: false,
      reason:
        `这一组来自「${name}」，而当前加载的是「${replay.fileName}」—— ` +
        `时间轴对不上，放了也是不相干的画面，所以这里不给放。`,
    };
  }
  return { ok: true, source: replay };
}

/**
 * 角色 → 中文阶段名（跨板对照的行标题）。
 *
 * 为什么不直接用 `PHASE_EVENT_LABEL`：那张表是**事件类型** → 中文，这里的是
 * **关键帧角色**。产品里两者一一对应（backswing ↔ backswing_start、…，
 * 由 F-058 的选帧器保证：角色是从事件类型推出来的），但 `role` 还多一个 `other`
 * （没有对应事件），所以不是同一张表，不能直接替代。
 */
const ROLE_LABEL: Record<EvidenceKeyframe["role"], string> = {
  backswing: "引拍",
  forward: "前挥",
  return: "还原",
  ready: "回到准备位",
  other: "其他",
};

/** 行序按动作的时间顺序，而不是"哪一板先出现" */
const ROLE_ORDER = ["backswing", "forward", "return", "ready", "other"] as const;

/**
 * 把关键帧按阶段分组，只留下**至少两板**可对照的那些。
 *
 * 两条取舍：
 * - **一行里只有一张图就不叫对照** —— 那是上面那块平铺的关键帧表，不必重复；
 * - **同一板在同一行里只留一张**：拉锯的一板可能有两次「引拍开始」、因而有两张
 *   引拍的图，而这一栏是"一板一列"的对照，同一板占两列会让人以为是两板。
 */
function crossStrokeRowsOf(packet: EvidencePacket): Array<{
  role: EvidenceKeyframe["role"];
  items: EvidenceKeyframe[];
}> {
  const byRole = new Map<EvidenceKeyframe["role"], EvidenceKeyframe[]>();
  for (const k of packet.keyframes) {
    const list = byRole.get(k.role);
    if (list) list.push(k);
    else byRole.set(k.role, [k]);
  }
  return ROLE_ORDER.flatMap((role) => {
    const seenStroke = new Set<string>();
    const onePerStroke: EvidenceKeyframe[] = [];
    for (const k of byRole.get(role) ?? []) {
      if (seenStroke.has(k.strokeId)) continue;
      seenStroke.add(k.strokeId);
      onePerStroke.push(k);
    }
    return onePerStroke.length >= 2 ? [{ role, items: onePerStroke }] : [];
  });
}

/** 复查页：关键帧、数值时序、反馈依据、用户评价、样本导出。 */
export function ReviewPanel({ reviews, onRate, onExport, thresholds, replay }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = reviews.find((r) => r.requestId === selectedId) ?? reviews[0] ?? null;

  /*
   * 回放：整个面板**只有一个** <video>，每一板用按钮去驱动它。
   *
   * 为什么不是每板各放一个：一组四板就是四个 <video> 解同一支文件，
   * 解码开销白花，而且四个都停在不同的位置上，读的人分不清在看哪一个。
   *
   * 到板尾自动停：用 `timeupdate` 判断而不是 `setTimeout` ——
   * 播放速率、缓冲、后台标签页降频都会让定时估算跑偏，而 timeupdate 报的是
   * 解码器真实的当前时间。
   */
  const [playingId, setPlayingId] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopAtRef = useRef<number | null>(null);

  // 显式标注：不标的话三元里那个字面量会把 ok 拓宽成 boolean，
  // 下面的判别式联合就失效了（TS 只会在用的时候报"没有 source"）
  const status: ReplayStatus = selected
    ? replayStatus(selected, replay)
    : { ok: false, reason: "" };

  // 跨板对照的分组与"第 N 板"编号都来自这一份包，不在渲染里临时重算
  const crossStrokeRows = selected ? crossStrokeRowsOf(selected.packet) : [];
  const strokeIndexOf = (strokeId: string): number =>
    selected?.packet.strokes.findIndex((s) => s.strokeId === strokeId) ?? -1;

  // 换一条记录就停掉上一条的回放：留着会让"正在放"的标记指向另一组。
  // 只在**真的在放**的时候才调 pause()（用 stopAtRef 判断）——
  // 没在放也去调，jsdom 里会刷一屏 "Not implemented"，真实浏览器里也没意义。
  useEffect(() => {
    if (stopAtRef.current == null) return;
    videoRef.current?.pause();
    stopAtRef.current = null;
    setPlayingId(null);
  }, [selected?.requestId]);
  // 组件卸载时也要停，否则离开复查页后音频还在走
  useEffect(() => () => videoRef.current?.pause(), []);

  const playStroke = (s: StrokeEvent): void => {
    const video = videoRef.current;
    if (!video || !status.ok) return;
    // 源时间 == video.currentTime×1000（导入链路就是这么取的时间戳），
    // 所以这两个数字是可以直接对齐的，不需要任何映射
    video.currentTime = s.startMs / 1000;
    stopAtRef.current = s.endMs;
    setPlayingId(s.strokeId);
    // jsdom 里 `play()` 未实现、**返回 undefined**（真实浏览器返回 Promise），
    // 所以这里对返回值做可选链：两种环境都不会炸，也仍然吞掉真实的播放失败。
    const playback: Promise<void> | undefined = video.play();
    void playback?.catch(() => setPlayingId(null));
  };

  const onTimeUpdate = (): void => {
    const video = videoRef.current;
    const stopAt = stopAtRef.current;
    if (!video || stopAt == null) return;
    if (video.currentTime * 1000 >= stopAt) {
      video.pause();
      stopAtRef.current = null;
      setPlayingId(null);
    }
  };

  if (reviews.length === 0) {
    return (
      <div className="panel">
        <h2>复查</h2>
        <div className="muted small">
          还没有可复查的记录。完成一组有效挥拍后，这里会保存关键点时序、测量值、反馈依据与你的评价。
        </div>
      </div>
    );
  }

  return (
    <div className="grid two">
      <div>
        <div className="panel">
          <div className="row" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>本组记录</h2>
            <div style={{ marginLeft: "auto" }}>
              <button onClick={onExport}>导出样本</button>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>分组</th>
                <th>状态</th>
                <th>耗时</th>
                <th>评价</th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((r) => (
                <tr
                  key={r.requestId}
                  onClick={() => setSelectedId(r.requestId)}
                  style={{
                    cursor: "pointer",
                    background: selected?.requestId === r.requestId ? "var(--panel-2)" : undefined,
                  }}
                >
                  <td className="mono small">{r.groupId}</td>
                  <td>
                    {r.feedback ? (
                      <span
                        className={`badge ${
                          r.feedback.status === "target_met"
                            ? "ok"
                            : r.feedback.status === "suggest_adjustment"
                              ? "warn"
                              : r.feedback.status === "insufficient_evidence"
                                ? "danger"
                                : "muted"
                        }`}
                      >
                        {r.feedback.status}
                      </span>
                    ) : (
                      <span className="badge danger">{r.error?.code ?? "无结果"}</span>
                    )}
                  </td>
                  <td className="num small">{Math.round(r.elapsedMs)}ms</td>
                  <td className="small">{ratingLabel(r.userRating)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selected && (
          <>
            <div className="panel">
              <h2>反馈依据</h2>
              {selected.feedback ? (
                <>
                  <div className="small muted">
                    状态：{selected.feedback.status} · 模型：{selected.feedback.modelId}
                    {selected.feedback.mock && "（mock）"} · 服务端耗时：
                    {Math.round(selected.feedback.serverElapsedMs)}ms · 端到端：
                    {Math.round(selected.elapsedMs)}ms
                    {selected.deduplicated && " · 命中去重复用"}
                  </div>
                  <div className="spacer" />
                  <div>{selected.feedback.observation}</div>
                  {selected.feedback.keyPoints.length > 0 && (
                    <ul className="tight small" style={{ marginTop: 8 }}>
                      {selected.feedback.keyPoints.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  )}
                  {selected.feedback.cue && (
                    <div className="cue" style={{ color: "var(--accent)", marginTop: 8 }}>
                      提示：{selected.feedback.cue}
                    </div>
                  )}
                  <h3>证据引用</h3>
                  <div className="mono small">
                    {selected.feedback.evidenceRefs.join("、") || "（无）"}
                  </div>
                  {selected.feedback.limitations.length > 0 && (
                    <>
                      <h3>局限</h3>
                      <ul className="tight small">
                        {selected.feedback.limitations.map((l) => (
                          <li key={l}>{l}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              ) : (
                <div className="notice danger">
                  <strong>未取得模型结论</strong>
                  <div className="small mono">{selected.error?.code}</div>
                  <div className="small">{selected.error?.message}</div>
                  {selected.error && selected.error.details.length > 0 && (
                    <ul className="tight small">
                      {selected.error.details.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  )}
                  <div className="small muted" style={{ marginTop: 6 }}>
                    这不会阻塞本地训练：摄像头与本地分析持续运行，测量结果仍可复查。
                  </div>
                </div>
              )}
            </div>

            <div className="panel">
              <h2>测量值</h2>
              <FeatureTable features={selected.packet.features} thresholds={thresholds} />
            </div>
          </>
        )}
      </div>

      <div>
        {selected && (
          <>
            <div className="panel">
              <h2>本次挥拍</h2>
              <table>
                <thead>
                  <tr>
                    <th>挥拍</th>
                    <th>区间</th>
                    <th>锚点</th>
                    <th>完整</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.packet.strokes.map((s) => (
                    <tr key={s.strokeId}>
                      <td className="mono small">{s.strokeId.slice(0, 14)}</td>
                      <td className="num small">
                        {s.startMs}–{s.endMs ?? "?"}
                      </td>
                      <td className="num small">{s.anchor.timeMs}</td>
                      <td>
                        <span className={`badge ${s.complete ? "ok" : "warn"}`}>
                          {s.complete ? "完整" : "不完整"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="small muted" style={{ marginTop: 8 }}>
                锚点类型为<strong>腕部速度峰值</strong>，不是已确认的击球时刻。因此本页不使用
                “击球后恢复时间”这一说法。
              </div>
            </div>

            <div className="panel">
              <h2>关键帧</h2>
              {selected.packet.keyframes.length > 0 ? (
                <>
                  <div className="small muted" style={{ marginBottom: 8 }}>
                    每张图都<strong>锚在检出的阶段转变</strong>上（角色是状态机口径，
                    不是解剖学结论；本组没有触球事件）。「距事件」是它与那一刻的差： 0ms
                    表示就取在转变时刻，正数表示同一相位内偏后（腕速峰值帧就是这样）。
                  </div>
                  <div className="kf-grid">
                    {selected.packet.keyframes.map((k) => (
                      <div className="kf" key={k.id}>
                        <img src={`data:image/jpeg;base64,${k.jpegBase64}`} alt={k.id} />
                        <div className="meta">
                          {k.role} · {k.sourceTimeMs}ms · {k.width}×{k.height}
                        </div>
                        <div className="meta muted">
                          板 {k.strokeId} · 距事件{" "}
                          {k.eventTimeOffsetMs === 0
                            ? "0ms（转变时刻）"
                            : `+${k.eventTimeOffsetMs}ms`}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="small muted">
                  本组没有可展示的关键帧（可能编码失败或缓存已淘汰）。数值测量仍然有效。
                </div>
              )}
            </div>

            <div className="panel">
              <h2>同阶段 · 跨板对照</h2>
              <div className="small muted" style={{ marginBottom: 10 }}>
                把<strong>同一个阶段</strong>的图按板排成一行 —— 看的是"这几板彼此像不像"。 它是
                <strong>你自己这几板之间</strong>的对照，<strong>不是与标准的对照</strong>：
                系统里没有审核过的参考模板，所以这里既不说哪一板"对"， 也不说这几板"一致就算好"——
                <strong>稳定地做错也是一致的</strong>。
              </div>
              {crossStrokeRows.length === 0 ? (
                <div className="small muted">
                  本组每个阶段都只有一板有图（或一板都没有），凑不出可对照的第二板。
                </div>
              ) : (
                crossStrokeRows.map(({ role, items }) => (
                  <div className="stroke-block" key={role}>
                    <div className="row">
                      <strong>{ROLE_LABEL[role]}</strong>
                      <span className="small muted">这 {items.length} 板的同一阶段</span>
                    </div>
                    <div className="kf-grid">
                      {items.map((k) => (
                        <div className="kf" key={k.id}>
                          <img src={`data:image/jpeg;base64,${k.jpegBase64}`} alt={k.id} />
                          <div className="meta">第 {strokeIndexOf(k.strokeId) + 1} 板</div>
                          <div className="meta muted">
                            {k.sourceTimeMs}ms ·{" "}
                            {k.eventTimeOffsetMs === 0
                              ? "恰在转变时刻"
                              : `距事件 +${k.eventTimeOffsetMs}ms`}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="panel">
              <h2>肘角曲线（逐帧）</h2>
              <div className="small muted" style={{ marginBottom: 8 }}>
                标量答不了"什么时候屈、什么时候伸"，这条线答得了。数据是<strong>同一份</strong>
                逐帧几何 —— 与上面那些从它算出来的数同源，不是重新算一遍。
              </div>
              {selected.elbowTrace ? (
                <ElbowCurve trace={selected.elbowTrace} />
              ) : (
                <div className="small muted">
                  本组没有逐帧几何可画（这一组没有任何一板，或姿态一帧都没跟上）。
                </div>
              )}
            </div>

            <div className="panel">
              <h2>逐板数值与过程</h2>
              <div className="small muted" style={{ marginBottom: 10 }}>
                每一板<strong>各自</strong>的测量值与<strong>阶段转变时刻</strong>。时刻来自分段
                状态机的阶段转变（离开准备区／确认回身／重新进区／本板闭合），
                <strong>不是击球时刻</strong> —— 本版没有触球与随挥事件，也没有随挥末端。
              </div>

              {status.ok ? (
                <>
                  <video
                    ref={videoRef}
                    className="replay"
                    src={status.source.url}
                    controls
                    playsInline
                    muted
                    onTimeUpdate={onTimeUpdate}
                    onEnded={() => setPlayingId(null)}
                  />
                  <div className="small muted" style={{ marginBottom: 8 }}>
                    按「回放这一板」会跳到该板起点、到板尾自动停。画面上的时间是
                    <strong>源视频时间</strong>，与下面每板的时刻、以及关键帧上的
                    <span className="mono small">@Nms</span> 是同一把尺子。
                  </div>
                </>
              ) : (
                <div className="notice warn" style={{ marginBottom: 10 }}>
                  <strong>这一组没有可回放的画面</strong>
                  <div className="small">{status.reason}</div>
                </div>
              )}

              {selected.packet.strokes.map((s, i) => {
                const entry = selected.packet.perStrokeFeatures.find(
                  (e) => e.strokeId === s.strokeId,
                );
                return (
                  <div className="stroke-block" key={s.strokeId}>
                    <div className="row">
                      <strong>第 {i + 1} 板</strong>
                      <span className="mono small muted">{s.strokeId}</span>
                      <span className="num small">
                        {s.startMs}–{s.endMs ?? "未闭合"}ms
                      </span>
                      <span className={`badge ${s.complete ? "ok" : "warn"}`}>
                        {s.complete ? "完整" : "不完整"}
                      </span>
                      {status.ok && (
                        <button
                          className={playingId === s.strokeId ? "primary" : ""}
                          style={{ marginLeft: "auto" }}
                          onClick={() => playStroke(s)}
                          disabled={s.endMs == null}
                          title={
                            s.endMs == null
                              ? "这一板没有闭合时间，回放不知道停在哪"
                              : `跳到 ${s.startMs}ms 起放，到 ${s.endMs}ms 停`
                          }
                        >
                          {playingId === s.strokeId ? "正在回放…" : "回放这一板"}
                        </button>
                      )}
                    </div>
                    {s.phaseEvents.length > 0 ? (
                      <div className="phase-line">
                        {s.phaseEvents.map((e, j) => (
                          // 事件是**可重复的有序序列**（拉锯会走两遍引拍），
                          // 所以 key 必须带上下标，不能只用 eventType
                          <Fragment key={`${e.eventType}-${e.timeMs}-${j}`}>
                            {j > 0 && <span className="phase-arrow">→</span>}
                            <span className="phase-step">
                              <span>{PHASE_EVENT_LABEL[e.eventType]}</span>
                              <span className="num small muted">{e.timeMs}ms</span>
                            </span>
                          </Fragment>
                        ))}
                      </div>
                    ) : (
                      <div className="small muted">本板没有记录到阶段转变，只有首尾两端可用。</div>
                    )}
                    <FeatureTable
                      features={entry?.features ?? []}
                      thresholds={thresholds}
                      scope="stroke"
                    />
                  </div>
                );
              })}
            </div>

            <div className="panel">
              <h2>证据包的局限</h2>
              <div className="small muted" style={{ marginBottom: 8 }}>
                这一栏是<strong>发出去给模型的那几句原话</strong>（
                <span className="mono small">packet.limitations</span>）——
                模型只知道这里写了的事。图少了、某个阶段转变没配上画面、
                画质没到可判门槛，都应该在这里看得到，而不是只在后台日志里。
              </div>
              {selected.packet.limitations.length > 0 ? (
                <ul className="tight small">
                  {selected.packet.limitations.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              ) : (
                <div className="small muted">本包没有声明任何局限。</div>
              )}
            </div>

            <div className="panel">
              <h2>这条反馈有用吗？</h2>
              <div className="small muted" style={{ marginBottom: 8 }}>
                你的评价会和证据一起保存，用于后续判断提示是否真的有用。
              </div>
              <div className="row">
                {(
                  [
                    ["helpful", "有帮助"],
                    ["inaccurate", "不准确"],
                    ["unclear", "没看懂"],
                  ] as Array<[UserRating, string]>
                ).map(([value, label]) => (
                  <button
                    key={value}
                    className={selected.userRating === value ? "primary" : ""}
                    onClick={() => onRate(selected.requestId, value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ratingLabel(r: UserRating | null): string {
  if (r === "helpful") return "有帮助";
  if (r === "inaccurate") return "不准确";
  if (r === "unclear") return "没看懂";
  return "—";
}

function FeatureTable({
  features,
  thresholds,
  /**
   * 这张表是**组级**还是**逐板**的。
   *
   * 两个差别都由它推出来，不另开开关：① 空表时的措辞（"本组"还是"本板"）；
   * ② 表下那条"本组关注目标阈值"只在组级表里印一次 —— 逐板那张表下面
   * 各印一遍，读的人会以为每板各有一套阈值。
   */
  scope = "group",
}: {
  features: FeatureValue[];
  thresholds: ThresholdConfig;
  scope?: "group" | "stroke";
}) {
  const isGroup = scope === "group";
  if (features.length === 0) {
    return (
      <div className="small muted">{isGroup ? "本组没有可用测量值。" : "本板没有可用测量值。"}</div>
    );
  }

  return (
    <>
      <table>
        <thead>
          <tr>
            <th>特征</th>
            <th>值</th>
            <th>单位</th>
            <th>质量</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {features.map((f) => (
            <tr key={f.id}>
              <td className="mono small">{f.id}</td>
              <td className="num">
                {f.value == null ? (
                  <span className="badge danger">缺失</span>
                ) : (
                  Math.round(f.value * 100) / 100
                )}
              </td>
              <td className="small muted">{f.unit}</td>
              <td>
                <span
                  className={`badge ${
                    f.quality === "usable" ? "ok" : f.quality === "limited" ? "warn" : "danger"
                  }`}
                >
                  {f.quality}
                </span>
              </td>
              <td className="small muted">{f.reasonIfMissing ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {isGroup && (
        <div className="small muted" style={{ marginTop: 8 }}>
          缺失值一律显示为“缺失”并给出原因，<strong>不会用 0 填补</strong>。
          本组关注目标阈值：返回准备区时间 ≤ {thresholds.returnAfterWristPeakMaxMs}ms
          （训练约束，不代表整体动作正确）。
        </div>
      )}
    </>
  );
}
