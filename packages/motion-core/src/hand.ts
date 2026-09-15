/**
 * 手部几何（手指细节）。
 *
 * 为什么需要：姿态模型（BlazePose）每只手只有腕加三个粗点，看不到指节，
 * 因此无法回答"手指在做什么"。手部 21 点补上了这一段。
 *
 * ══ 红线 3：这里只做**测量**，不做**推断** ══
 *
 * 允许（下面实现的）：测量可见的二维指关节几何 —— 指节角度、手指张开程度、
 * 手指相对掌心的方向。这些都是"画面里能直接看到的量"。
 *
 * **禁止**（不实现，且不得以后续"优化"为名加进来）：
 * - **精确拍面姿态 / 拍面朝向** —— 拍面方向取决于握拍方式与三维旋转，
 *   单目二维骨架确定不了。红线 3 点名禁止。任何"用掌心朝向推拍面角度"的
 *   写法都违反这条，无论它看起来多合理。
 * - 握力、肌肉紧张、发力大小 —— 同样无法从二维关键点得到。
 *
 * 因此本模块所有输出都必须按"观测值"命名（如 `index_flexion_deg`），
 * 并在理由中标注是二维观测，**不得**命名成"拍面角度""握拍压力"这类结论性名称。
 *
 * 另一个纪律：手部模型是可选增强。没有手部点时，本模块一律返回 `null`，
 * 由调用方按"缺失 + 原因"处理，**不得**用 0 或默认姿态顶替。
 */

import type { Keypoint2D } from "@pingpong/contracts";
import { angleDeg, type Point2D } from "./geometry.js";

export type Handedness = "left" | "right";

/** 五个手指的语义名（不含拇指，拇指单独处理）。 */
export const FINGER_NAMES = ["index", "middle", "ring", "pinky"] as const;
export type FingerName = (typeof FINGER_NAMES)[number];

export interface HandGeometry {
  side: Handedness;
  /** 掌心参考点（腕、食指根、小指根的质心） */
  palmCenterPx: Point2D;
  /** 掌宽（食指根—小指根），作为手部尺度，用于把阈值与距离归一化 */
  palmWidthPx: number;
  /**
   * 每个手指的近端指间关节（PIP）屈曲角，度。
   * 180° = 完全伸直；越小越屈曲。
   *
   * 命名纪律：这是**二维观测角**，不是三维关节角，也不是"握拍力度"。
   */
  fingerFlexionDeg: Record<FingerName, number | null>;
  /**
   * 拇指张开度：拇指尖相对食指根的方向与掌轴（腕→中指根）的夹角，度。
   * 同样是二维观测值。
   */
  thumbSpreadDeg: number | null;
  /** 参与本次计算的可见手部点数，用于判断这份几何是否可信 */
  visiblePointCount: number;
  /** 缺失原因；几何可用时为 null */
  reasonIfMissing: string | null;
}

/** 手部点名称构造：`${side}_hand_${suffix}`。 */
function handName(side: Handedness, suffix: string): string {
  return `${side}_hand_${suffix}`;
}

function findPoint(kps: readonly Keypoint2D[], name: string): Point2D | null {
  const kp = kps.find((k) => k.name === name);
  if (!kp || kp.visible === false) return null;
  if (!Number.isFinite(kp.xPx) || !Number.isFinite(kp.yPx)) return null;
  return { x: kp.xPx, y: kp.yPx };
}

/**
 * 从关键点集合中提取手部几何。
 *
 * @returns 该侧手部几何；手部点缺失（手部模型未启用/该手未检测到/关键点不足）时
 *          返回带 `reasonIfMissing` 的结果，`fingerFlexionDeg` 各项为 null。
 *          **不返回 null** —— 让调用方总能拿到"缺什么、为什么缺"。
 */
export function extractHandGeometry(
  keypoints: readonly Keypoint2D[],
  side: Handedness,
): HandGeometry {
  const p = (suffix: string) => findPoint(keypoints, handName(side, suffix));

  const wrist = p("wrist");
  const indexMcp = p("index_mcp");
  const pinkyMcp = p("pinky_mcp");
  const middleMcp = p("middle_mcp");

  const missingBase: HandGeometry = {
    side,
    palmCenterPx: { x: Number.NaN, y: Number.NaN },
    palmWidthPx: Number.NaN,
    fingerFlexionDeg: { index: null, middle: null, ring: null, pinky: null },
    thumbSpreadDeg: null,
    visiblePointCount: 0,
    reasonIfMissing: "未检测到该侧手部关键点（手部模型未启用，或该手不在画面内）",
  };

  if (!wrist || !indexMcp || !pinkyMcp) return missingBase;

  const visiblePointCount = keypoints.filter(
    (k) => k.name.startsWith(`${side}_hand_`) && k.visible !== false && Number.isFinite(k.xPx),
  ).length;

  const palmCenterPx = {
    x: (wrist.x + indexMcp.x + pinkyMcp.x) / 3,
    y: (wrist.y + indexMcp.y + pinkyMcp.y) / 3,
  };
  const palmWidthPx = Math.hypot(pinkyMcp.x - indexMcp.x, pinkyMcp.y - indexMcp.y);

  if (!(palmWidthPx > 0)) {
    return { ...missingBase, visiblePointCount, reasonIfMissing: "掌宽为 0，手部关键点不可信" };
  }

  const fingerFlexionDeg: Record<FingerName, number | null> = {
    index: null,
    middle: null,
    ring: null,
    pinky: null,
  };
  for (const finger of FINGER_NAMES) {
    const mcp = p(`${finger}_mcp`);
    const pip = p(`${finger}_pip`);
    const tip = p(`${finger}_tip`);
    if (!mcp || !pip || !tip) continue;
    fingerFlexionDeg[finger] = angleDeg(mcp, pip, tip);
  }

  // 拇指张开度：以掌轴（腕 → 中指根）为参考方向，看拇指尖偏向哪边。
  // 中指根缺失时退化用食指根，仍不可得则记 null。
  let thumbSpreadDeg: number | null = null;
  const thumbTip = p("thumb_tip");
  const axisEnd = middleMcp ?? indexMcp;
  if (thumbTip && axisEnd) {
    thumbSpreadDeg = angleDeg(thumbTip, wrist, axisEnd);
  }

  return {
    side,
    palmCenterPx,
    palmWidthPx,
    fingerFlexionDeg,
    thumbSpreadDeg,
    visiblePointCount,
    reasonIfMissing: null,
  };
}
