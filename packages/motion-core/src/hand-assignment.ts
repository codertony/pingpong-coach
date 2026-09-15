/**
 * 手部检测结果的左右分配。
 *
 * 为什么不直接用 MediaPipe 的 `handedness` 标签：那个标签的语义依赖
 * "输入是否为镜像自拍图"这一前提。本项目的输入可能是原始摄像头画面，
 * 也可能是导入视频（自拍或他人拍摄），前提不成立。
 *
 * 所以改用**姿态模型的腕部位置作为锚点**：离姿态 `left_wrist` 更近的那只手
 * 就是左手。这样还能保证手部点与姿态点指向**同一个物理手**，
 * 下游（如"持拍手的手指几何"）不会把两只手张冠李戴。
 *
 * 纪律：超出容差的手**不分配** —— 宁可不给，也不给错的。
 * 因为一个错配的手部点会让下游算出完全错误的指关节角度，
 * 而"缺失"至少是诚实且可被调用方识别的。
 */

export interface HandPoint2D {
  x: number;
  y: number;
}

/** 一侧手部关键点的索引（MediaPipe Hand Landmarker 的 21 点顺序）。 */
export const HAND_LANDMARK_INDEX = {
  wrist: 0,
  thumb_cmc: 1,
  thumb_mcp: 2,
  thumb_ip: 3,
  thumb_tip: 4,
  index_mcp: 5,
  index_pip: 6,
  index_dip: 7,
  index_tip: 8,
  middle_mcp: 9,
  middle_pip: 10,
  middle_dip: 11,
  middle_tip: 12,
  ring_mcp: 13,
  ring_pip: 14,
  ring_dip: 15,
  ring_tip: 16,
  pinky_mcp: 17,
  pinky_pip: 18,
  pinky_dip: 19,
  pinky_tip: 20,
} as const;

export type HandSide = "left" | "right";

export interface HandWristAnchors {
  left: HandPoint2D | null;
  right: HandPoint2D | null;
}

export interface HandAssignment<T> {
  /** 侧别 → 该手的 21 个点（顺序与 MediaPipe 一致） */
  assigned: Partial<Record<HandSide, T[]>>;
  /**
   * 未被分配的手（超出容差或已被同侧占用），附距离 —— 丢弃原因必须可查，
   * 否则"手没显示出来"会变成一个无法定位的问题。
   */
  rejected: Array<{ distancePx: number; nearestSide: HandSide | null }>;
}

/**
 * 把检测到的若干只手分配到左右两侧。
 *
 * @param hands 每只手的 21 个点（归一化或像素均可，只要与 anchors 同一空间）
 * @param anchors 姿态模型的左右腕位置（与 hands 同一空间）
 * @param tolerancePx 手部腕点与姿态腕点的最大允许距离；超出则不分配
 */
export function assignHandsToSides<T extends HandPoint2D>(
  hands: ReadonlyArray<ReadonlyArray<T>>,
  anchors: HandWristAnchors,
  tolerancePx: number,
): HandAssignment<T> {
  const assigned: Partial<Record<HandSide, T[]>> = {};
  const rejected: Array<{ distancePx: number; nearestSide: HandSide | null }> = [];
  const taken = new Set<HandSide>();

  const candidates = hands
    .map((lm) => {
      const w = lm[0];
      if (!w) return null;
      const dLeft = anchors.left
        ? Math.hypot(w.x - anchors.left.x, w.y - anchors.left.y)
        : Number.POSITIVE_INFINITY;
      const dRight = anchors.right
        ? Math.hypot(w.x - anchors.right.x, w.y - anchors.right.y)
        : Number.POSITIVE_INFINITY;
      const nearestSide: HandSide | null = !Number.isFinite(Math.min(dLeft, dRight))
        ? null
        : dLeft <= dRight
          ? "left"
          : "right";
      return { lm, nearestSide, distancePx: Math.min(dLeft, dRight) };
    })
    .filter(
      (c): c is { lm: ReadonlyArray<T>; nearestSide: HandSide | null; distancePx: number } =>
        c != null,
    )
    // 先处理离锚点最近的手，避免两只手都被判给同一侧
    .sort((a, b) => a.distancePx - b.distancePx);

  for (const c of candidates) {
    const ok =
      c.nearestSide != null && Number.isFinite(c.distancePx) && c.distancePx <= tolerancePx;
    if (!ok || taken.has(c.nearestSide!)) {
      rejected.push({ distancePx: c.distancePx, nearestSide: c.nearestSide });
      continue;
    }
    // 逐个复制点：只复制数组本身（浅拷贝）会让返回值与输入共享点对象，
    // 调用方改动一个坐标就会悄悄改到上游数据。
    assigned[c.nearestSide!] = c.lm.map((p) => ({ ...p }));
    taken.add(c.nearestSide!);
  }

  return { assigned, rejected };
}
