/**
 * 骨架叠加绘制。
 *
 * 只绘制持拍侧有关的连线与关键点，避免视觉噪声掩盖真正要看的部分。
 */

import type { Keypoint2D } from "@pingpong/contracts";

/** 用于绘制的骨段连线（统一语义名称对） */
const BONES: Array<[string, string]> = [
  ["left_shoulder", "right_shoulder"],
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"],
  ["left_hip", "right_hip"],
  ["left_hip", "left_knee"],
  ["right_hip", "right_knee"],
];

export interface DrawOptions {
  /** 镜像预览。只影响绘制，不改变坐标语义与左右标签 */
  mirrored: boolean;
  /** 低于此分数的点用虚线/浅色表示不可靠 */
  minScore: number;
}

export function drawSkeleton(
  canvas: HTMLCanvasElement,
  keypoints: Keypoint2D[],
  handedness: "left" | "right",
  options: DrawOptions = { mirrored: true, minScore: 0.5 },
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (keypoints.length === 0) return;

  const map = new Map(keypoints.map((k) => [k.name, k]));
  const toXY = (kp: Keypoint2D): { x: number; y: number } | null => {
    if (!Number.isFinite(kp.xPx) || !Number.isFinite(kp.yPx)) return null;
    if (kp.visible === false) return null;
    // 镜像只在绘制层处理
    const x = options.mirrored ? width - kp.xPx : kp.xPx;
    return { x, y: kp.yPx };
  };

  // 骨段
  ctx.lineWidth = Math.max(2, width / 320);
  for (const [a, b] of BONES) {
    const ka = map.get(a);
    const kb = map.get(b);
    if (!ka || !kb) continue;
    const pa = toXY(ka);
    const pb = toXY(kb);
    if (!pa || !pb) continue;

    const onRacketSide = a.startsWith(handedness) || b.startsWith(handedness);
    const reliable = (ka.score ?? 1) >= options.minScore && (kb.score ?? 1) >= options.minScore;

    ctx.strokeStyle = onRacketSide
      ? reliable
        ? "#4ea1ff"
        : "#d29922"
      : reliable
        ? "rgba(230,237,243,0.45)"
        : "rgba(210,153,34,0.45)";
    if (onRacketSide) ctx.lineWidth = Math.max(3, width / 240);
    else ctx.lineWidth = Math.max(1.5, width / 420);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.lineWidth = Math.max(2, width / 320);
  }

  // 关键点
  for (const kp of keypoints) {
    const p = toXY(kp);
    if (!p) continue;
    const onRacketSide = kp.name.startsWith(handedness);
    const reliable = (kp.score ?? 1) >= options.minScore;
    const r = onRacketSide ? Math.max(4, width / 170) : Math.max(2.5, width / 320);
    ctx.fillStyle = onRacketSide ? (reliable ? "#ffffff" : "#d29922") : "rgba(230,237,243,0.55)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 高亮持拍侧的肩肘腕
  const chain = [`${handedness}_shoulder`, `${handedness}_elbow`, `${handedness}_wrist`];
  const chainPoints = chain
    .map((n) => map.get(n))
    .map((kp) => (kp ? toXY(kp) : null))
    .filter((p): p is { x: number; y: number } => p != null);

  if (chainPoints.length === 3) {
    // 肘角弧线提示：只画识别到的角，不标注数值以免被误读为精确量
    const [s, e, w] = chainPoints as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ];
    const a1 = Math.atan2(s.y - e.y, s.x - e.x);
    const a2 = Math.atan2(w.y - e.y, w.x - e.x);
    ctx.strokeStyle = "rgba(78,161,255,0.85)";
    ctx.lineWidth = Math.max(2, width / 300);
    ctx.beginPath();
    ctx.arc(e.x, e.y, Math.max(18, width / 40), a1, a2, false);
    ctx.stroke();
  }
}

/** 把准备区画在画布上，让用户确认本组约束位置。 */
export function drawReadyZone(
  canvas: HTMLCanvasElement,
  zone: { xPx: number; yPx: number; radiusPx: number } | null,
  mirrored: boolean,
): void {
  if (!zone) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const x = mirrored ? canvas.width - zone.xPx : zone.xPx;
  ctx.strokeStyle = "rgba(63,185,80,0.9)";
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, zone.yPx, zone.radiusPx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // 标注中心：没有标注时，用户无法判断这个圆到底是"准备区"还是别的什么东西
  ctx.fillStyle = "rgba(63,185,80,0.9)";
  ctx.font = `${Math.max(11, Math.round(canvas.width / 90))}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("准备区", x, zone.yPx);
}
