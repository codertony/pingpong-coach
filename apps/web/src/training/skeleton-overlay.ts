/**
 * 骨架叠加绘制。
 *
 * 只绘制持拍侧有关的连线与关键点，避免视觉噪声掩盖真正要看的部分。
 */

import { HAND_LANDMARK_NAMES, type Keypoint2D } from "@pingpong/contracts";
import { HAND_LANDMARK_INDEX } from "@pingpong/motion-core";

/**
 * 手部 21 点的全部语义名（两侧共 42 个），用于把它们与姿态点区分开。
 *
 * 取契约里的名字而不是自己拼字符串：手部名字里**只有腕点**带 `_hand_` 中缀，
 * 手指叫 `left_thumb_cmc` 之类 —— 按中缀判断会漏掉 20/21 的点。
 */
const HAND_KEYPOINT_NAMES: ReadonlySet<string> = new Set<string>(HAND_LANDMARK_NAMES);

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

/**
 * 手部 21 点的语义名，按侧别切分。
 *
 * 直接用契约里的顺序（`HAND_LANDMARK_NAMES` 前 21 个是左手、后 21 个是右手），
 * **不再自己拼字符串**。这里踩过一个真实的坑（F-021）：原先按
 * `${侧}_hand_${后缀}` 拼名字，但契约里**只有腕点**带 `_hand_` 中缀
 * （`left_hand_wrist`），手指叫 `left_thumb_mcp` / `left_index_mcp` ——
 * 21 个点里有 20 个查不到，`drawHand` 的守卫于是直接 return，
 * **手部一次都没画出来过**，而"手部能力已接入"从外部看一切正常。
 */
const HAND_NAMES_BY_SIDE: Record<"left" | "right", readonly string[]> = {
  left: HAND_LANDMARK_NAMES.slice(0, 21),
  right: HAND_LANDMARK_NAMES.slice(21),
};

/**
 * 手指骨段，按 MediaPipe 的 21 点下标给出（顺序与契约一致）。
 *
 * 用下标而不是名字：下标不会拼错，名字会。
 */
const HAND_FINGER_CHAINS_IDX: ReadonlyArray<readonly number[]> = [
  [HAND_LANDMARK_INDEX.thumb_mcp, HAND_LANDMARK_INDEX.thumb_ip, HAND_LANDMARK_INDEX.thumb_tip],
  [
    HAND_LANDMARK_INDEX.index_mcp,
    HAND_LANDMARK_INDEX.index_pip,
    HAND_LANDMARK_INDEX.index_dip,
    HAND_LANDMARK_INDEX.index_tip,
  ],
  [
    HAND_LANDMARK_INDEX.middle_mcp,
    HAND_LANDMARK_INDEX.middle_pip,
    HAND_LANDMARK_INDEX.middle_dip,
    HAND_LANDMARK_INDEX.middle_tip,
  ],
  [
    HAND_LANDMARK_INDEX.ring_mcp,
    HAND_LANDMARK_INDEX.ring_pip,
    HAND_LANDMARK_INDEX.ring_dip,
    HAND_LANDMARK_INDEX.ring_tip,
  ],
  [
    HAND_LANDMARK_INDEX.pinky_mcp,
    HAND_LANDMARK_INDEX.pinky_pip,
    HAND_LANDMARK_INDEX.pinky_dip,
    HAND_LANDMARK_INDEX.pinky_tip,
  ],
];

/** 掌心轮廓：腕 → 食指根 → … → 小指根 → 回到腕。 */
const HAND_PALM_CHAIN_IDX: readonly number[] = [
  HAND_LANDMARK_INDEX.wrist,
  HAND_LANDMARK_INDEX.index_mcp,
  HAND_LANDMARK_INDEX.middle_mcp,
  HAND_LANDMARK_INDEX.ring_mcp,
  HAND_LANDMARK_INDEX.pinky_mcp,
  HAND_LANDMARK_INDEX.wrist,
];

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
    // 手部点**跳过**：它们由下面的 drawHand 用更细的点与线单独画。
    // 若也走这一圈，21 个手部点会按姿态点的尺寸画（持拍侧 7.5px 半径），
    // 而手在画面里只有约 90px 宽 —— 点比指间距还大，整只手糊成一团白，
    // 看不到任何手指细节（实测发现，F-021）。手部能力等于白接。
    if (HAND_KEYPOINT_NAMES.has(kp.name)) continue;
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
  drawHand(ctx, map, toXY, handedness, width);
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
): void {
  // 按**下标**取点：名字来自契约，不拼字符串（拼错会静默画不出来，见 F-021）
  const p = (idx: number) => {
    const name = HAND_NAMES_BY_SIDE[handedness][idx];
    const kp = name == null ? undefined : map.get(name);
    return kp === undefined ? null : toXY(kp);
  };

  const wrist = p(HAND_LANDMARK_INDEX.wrist);
  const indexMcp = p(HAND_LANDMARK_INDEX.index_mcp);
  const pinkyMcp = p(HAND_LANDMARK_INDEX.pinky_mcp);
  // 三个锚点缺任一就不画：半个手比不画更容易被误读为"手就是这样"
  if (!wrist || !indexMcp || !pinkyMcp) return;

  // 手部模型不提供逐点置信度（`score` 恒为 null），所以这里没有"可靠/不可靠"之分，
  // 一律按可见处理；把它当成"高置信度"是不诚实的。
  const color = "rgba(255,209,102,0.95)";

  ctx.lineWidth = Math.max(1.5, width / 500);

  // 掌心轮廓
  const palmPts = HAND_PALM_CHAIN_IDX.map((i) => p(i));
  if (palmPts.every((q): q is { x: number; y: number } => q != null)) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    palmPts.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
    ctx.stroke();
  }

  // 五根手指
  ctx.strokeStyle = color;
  for (const finger of HAND_FINGER_CHAINS_IDX) {
    const pts = finger.map((i) => p(i));
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // 指节点：小圆点，只画可见且有限坐标的
  ctx.fillStyle = color;
  for (const name of HAND_NAMES_BY_SIDE[handedness]) {
    const kp = map.get(name);
    if (!kp) continue;
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
