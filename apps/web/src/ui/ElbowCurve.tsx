/**
 * 本组的**逐帧肘角曲线**（复查页）。
 *
 * ## 为什么要有它
 *
 * 逐板与组级的数都是**标量**（"本组肘角范围 62°"），回答不了"什么时候屈、什么时候伸"——
 * 而那是时间形状。评审 §1.6 的第一行（"小臂有没有明显屈伸"）要的正是这条曲线。
 *
 * ## 两条不许越的线（都体现在画法里）
 *
 * 1. **缺测画成断口，不插值、不补零**（红线 1）。缺有两种来路，两种都要断：
 *    - 那一帧测到了人、但持拍臂的肘角算不出来（`elbowAngleDeg === null`，遮挡）；
 *    - 那一帧**根本没检出人**（样本里干脆没有这一帧）。
 *    第二种只能靠**时间间隔**判出来 —— 所以下面有个 `GAP_BREAK_FACTOR`：
 *    相邻样本的时间差超过中位采样间隔的若干倍，就断开，而不是拉一条长直线过去。
 *    拉直线看起来"很完整"，而它恰好掩盖了最该被看见的东西。
 * 2. **竖线是阶段转变，不是击球**（红线 2）。文案里一律说「转变」。
 *
 * 曲线上标出的东西都来自同一份数据（`ElbowTrace`）：样本、事件、各板区间，
 * 没有一处在这里重新算 —— 复查页要做的是**把已有的事实画出来**，
 * 不是再造一套口径。
 */

import { PHASE_EVENT_LABEL } from "@pingpong/contracts";
import { median } from "@pingpong/motion-core";
import type { ElbowTrace } from "../training/training-session.js";

/**
 * 采样断口的判定倍数：相邻样本的时间差 > **中位采样间隔** × 这个倍数，就断开。
 *
 * 为什么用中位间隔而不是写死毫秒：帧率是可变的（30 / 60fps，实时链路还会丢旧帧）。
 * 写死一个毫秒数在 60fps 下会把正常采样判成断口，在 30fps 丢帧时又会把真断口连起来。
 * 倍数取 3：正常的抖动（个别帧慢一点）不触发，成片的缺失才触发。
 */
const GAP_BREAK_FACTOR = 3;

const W = 640;
const H = 150;
const PAD = { left: 44, right: 12, top: 14, bottom: 24 };

interface Point {
  tMs: number;
  angle: number;
}

/**
 * 把样本切成若干**连续段**：遇到缺测或时间断口就切开。
 *
 * 单独一个点也算一段（它是真实测到的一个值，画成点而不是丢掉）。
 */
function toSegments(trace: ElbowTrace): Point[][] {
  const deltas: number[] = [];
  for (let i = 1; i < trace.samples.length; i++) {
    deltas.push(trace.samples[i]!.tMs - trace.samples[i - 1]!.tMs);
  }
  const step = median(deltas);
  const breakAbove = step != null && step > 0 ? step * GAP_BREAK_FACTOR : null;

  const segments: Point[][] = [];
  let current: Point[] = [];
  for (let i = 0; i < trace.samples.length; i++) {
    const s = trace.samples[i]!;
    const prev = trace.samples[i - 1];
    const timeJump = prev != null && breakAbove != null && s.tMs - prev.tMs > breakAbove;
    if (s.elbowAngleDeg == null || timeJump) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push({ tMs: s.tMs, angle: s.elbowAngleDeg });
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export function ElbowCurve({ trace }: { trace: ElbowTrace }) {
  const segments = toSegments(trace);
  const measured = trace.samples.filter((s) => s.elbowAngleDeg != null).length;
  const total = trace.samples.length;

  if (measured < 2 || segments.every((seg) => seg.length === 0)) {
    return (
      <div className="small muted">
        本组只有 {measured} 帧测到肘角（共 {total} 帧），画不出曲线 —— 缺测<strong>不插值</strong>
        ，所以这里不会用一条直线或一个平均数把它填上。
      </div>
    );
  }

  const angles = trace.samples.map((s) => s.elbowAngleDeg).filter((a): a is number => a != null);
  const rawMin = Math.min(...angles);
  const rawMax = Math.max(...angles);
  // 上下各留一点余量，免得曲线贴着边框；同时夹在 [0,180] 里（那是肘角的物理范围）
  const pad = Math.max(2, (rawMax - rawMin) * 0.1);
  const yMin = Math.max(0, Math.floor(rawMin - pad));
  const yMax = Math.min(180, Math.ceil(rawMax + pad));
  const [t0, t1] = trace.intervalMs;
  const span = Math.max(1, t1 - t0);

  const x = (tMs: number): number => PAD.left + ((tMs - t0) / span) * (W - PAD.left - PAD.right);
  const y = (angle: number): number => {
    const ratio = (angle - yMin) / Math.max(1, yMax - yMin);
    return PAD.top + (1 - ratio) * (H - PAD.top - PAD.bottom);
  };

  const gapCount = segments.length - 1;

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`本组逐帧肘角曲线，${measured} 帧有值、共 ${total} 帧`}
        style={{ display: "block" }}
      >
        {/* 横轴与纵轴的框 */}
        <line
          x1={PAD.left}
          y1={H - PAD.bottom}
          x2={W - PAD.right}
          y2={H - PAD.bottom}
          stroke="var(--border)"
        />
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} stroke="var(--border)" />

        {/* 各板区间：贴着顶边的一条带，标明"这一板从哪到哪" */}
        {trace.strokeSpans.map((s, i) => {
          const end = s.endMs ?? s.startMs;
          return (
            <rect
              key={s.strokeId}
              x={x(s.startMs)}
              y={2}
              width={Math.max(1, x(end) - x(s.startMs))}
              height={6}
              fill={i % 2 === 0 ? "var(--muted)" : "var(--accent)"}
              opacity={0.5}
            >
              <title>{`第 ${i + 1} 板 ${s.startMs}–${s.endMs ?? "未闭合"}ms`}</title>
            </rect>
          );
        })}

        {/* 阶段转变：竖虚线。**不是击球时刻**（红线 2） */}
        {trace.events.map((e, i) => (
          <line
            key={`${e.strokeId}-${e.eventType}-${e.timeMs}-${i}`}
            x1={x(e.timeMs)}
            y1={PAD.top}
            x2={x(e.timeMs)}
            y2={H - PAD.bottom}
            stroke="var(--muted)"
            strokeDasharray="3 3"
            opacity={0.7}
          >
            <title>{`${PHASE_EVENT_LABEL[e.eventType]} @${e.timeMs}ms`}</title>
          </line>
        ))}

        {/* 曲线：一段一条折线。**单点段**画成点 —— 那是一个真实测到的值 */}
        {segments.map((seg, i) =>
          seg.length >= 2 ? (
            <polyline
              key={i}
              className="elbow-segment"
              points={seg.map((p) => `${x(p.tMs)},${y(p.angle)}`).join(" ")}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={2}
            />
          ) : (
            <circle
              key={i}
              className="elbow-segment"
              cx={x(seg[0]!.tMs)}
              cy={y(seg[0]!.angle)}
              r={2.5}
              fill="var(--accent)"
            />
          ),
        )}

        {/* 纵轴刻度：上下限，用户才知道这条线在什么范围里动 */}
        <text x={PAD.left - 6} y={PAD.top + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
          {yMax}°
        </text>
        <text
          x={PAD.left - 6}
          y={H - PAD.bottom}
          textAnchor="end"
          fontSize={11}
          fill="var(--muted)"
        >
          {yMin}°
        </text>
        {/* 横轴刻度：组区间两端（源时间） */}
        <text x={PAD.left} y={H - 10} fontSize={11} fill="var(--muted)">
          {t0}ms
        </text>
        <text x={W - PAD.right} y={H - 10} textAnchor="end" fontSize={11} fill="var(--muted)">
          {t1}ms
        </text>
      </svg>
      <div className="small muted" style={{ marginTop: 6 }}>
        纵轴是<strong>肘角</strong>（180° 为伸直），横轴是源时间。曲线断成 {segments.length} 段
        {gapCount > 0 && `（${gapCount} 处断口）`}
        —— 断口就是"那一段没测到"（遮挡或身体出画），
        <strong>不插值、不补零</strong>。竖虚线是<strong>阶段转变</strong>
        （引拍／前挥／还原开始、本板闭合）， 顶边色带是每一板，都不是击球时刻。共 {measured}/{total}{" "}
        帧测到肘角。
      </div>
    </div>
  );
}
