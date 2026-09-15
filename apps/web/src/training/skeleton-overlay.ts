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

/** 手指骨段：每根手指从掌指关节到指尖的连线（用本项目的手部语义名）。 */
const HAND_FINGER_CHAINS: ReadonlyArray<ReadonlyArray<string>> = [
  ["thumb_mcp", "thumb_ip", "thumb_tip"],
  ["index_mcp", "index_pip", "index_dip", "index_tip"],
  ["middle_mcp", "middle_pip", "middle_dip", "middle_tip"],
  ["ring_mcp", "ring_pip", "ring_dip", "ring_tip"],
  ["pinky_mcp", "pinky_pip", "pinky_dip", "pinky_tip"],
];

/** 掌心轮廓：腕 → 食指根 → … → 小指根 → 回到腕。 */
const HAND_PALM_CHAIN = ["wrist", "index_mcp", "middle_mcp", "ring_mcp", "pinky_mcp", "wrist"];

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

  // 手部 21 点：只在持拍侧画，且只在手部模型可用时才有这些点。
  // 这是**测量**的呈现 —— 画的是检测到的指关节位置，不表示任何拍面结论。
  drawHand(ctx, map, toXY, handedness, width, options);
}

/**
 * 绘制持拍侧的手部关键点与骨段。
 *
 * 视觉纪律：手部点比姿态点密得多，用细线 + 小点，避免盖住真正要看的肩肘腕。
 * 手部点缺失时（手部模型未启用）什么都不画，不留残影。
 */
function drawHand(
  ctx: CanvasRenderingContext2D,
  map: Map<string, Keypoint2D>,
  toXY: (kp: Keypoint2D) => { x: number; y: number } | null,
  handedness: "left" | "right",
  width: number,
  options: DrawOptions,
): void {
  const p = (suffix: string) => {
    const kp = map.get(`${handedness}_hand_${suffix}`);
    return kp ? toXY(kp) : null;
  };

  const wrist = p("wrist");
  const indexMcp = p("index_mcp");
  const pinkyMcp = p("pinky_mcp");
  // 三个锚点缺任一就不画：半个手比不画更容易被误读为"手就是这样"
  if (!wrist || !indexMcp || !pinkyMcp) return;

  const reliable = (suffix: string) => {
    const kp = map.get(`${handedness}_hand_${suffix}`);
    return (kp?.score ?? 1) >= options.minScore;
  };

  ctx.lineWidth = Math.max(1.5, width / 500);

  // 掌心轮廓
  const palmPts = HAND_PALM_CHAIN.map((s) => p(s));
  if (palmPts.every((q): q is { x: number; y: number } => q != null)) {
    ctx.strokeStyle = "rgba(255,209,102,0.9)";
    ctx.beginPath();
    palmPts.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
    ctx.stroke();
  }

  // 五根手指
  for (const finger of HAND_FINGER_CHAINS) {
    const pts = finger.map((s) => p(s));
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!a || !b) continue;
      ctx.strokeStyle =
        reliable(finger[i]!) && reliable(finger[i + 1]!)
          ? "rgba(255,209,102,0.95)"
          : "rgba(210,153,34,0.5)";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // 指节点：小圆点，只画可见且有限坐标的
  ctx.fillStyle = "rgba(255,209,102,0.95)";
  for (const [, kp] of map) {
    if (!kp.name.startsWith(`${handedness}_hand_`)) continue;
    const q = toXY(kp);
    if (!q) continue;
    ctx.beginPath();
    ctx.arc(q.x, q.y, Math.max(1.5, width / 640), 0, Math.PI * 2);
    ctx.fill();
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
