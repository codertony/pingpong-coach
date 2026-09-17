import { useState } from "react";
import type { CoachFeedback, EvidencePacket, FeatureValue } from "@pingpong/contracts";
import type { ThresholdConfig } from "@pingpong/motion-core";

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
}

interface Props {
  reviews: ReviewItem[];
  onRate: (requestId: string, rating: UserRating) => void;
  onExport: () => void;
  thresholds: ThresholdConfig;
}

/** 复查页：关键帧、数值时序、反馈依据、用户评价、样本导出。 */
export function ReviewPanel({ reviews, onRate, onExport, thresholds }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = reviews.find((r) => r.requestId === selectedId) ?? reviews[0] ?? null;

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
}: {
  features: FeatureValue[];
  thresholds: ThresholdConfig;
}) {
  if (features.length === 0) {
    return <div className="small muted">本组没有可用测量值。</div>;
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
      <div className="small muted" style={{ marginTop: 8 }}>
        缺失值一律显示为“缺失”并给出原因，<strong>不会用 0 填补</strong>。
        本组关注目标阈值：返回准备区时间 ≤ {thresholds.returnAfterWristPeakMaxMs}ms
        （训练约束，不代表整体动作正确）。
      </div>
    </>
  );
}
