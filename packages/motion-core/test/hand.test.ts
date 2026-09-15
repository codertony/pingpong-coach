/**
 * 手部几何测试。
 *
 * 这组测试守两件事：
 *
 * 1. **红线 3**：只测可见的二维指关节几何，不推断拍面姿态/握力。
 *    这一点无法用断言直接表达，所以用「输出里不存在拍面类字段」来钉住形状，
 *    并在下面的 `toHandKeypoints` 里显式检查命名纪律。
 * 2. **缺失就是缺失**：手部模型未启用或该手不在画面时，几何各项必须是
 *    `null` 加原因，**不得**用 0 或"默认伸直姿态"顶替 —— 0 度是合法的屈曲角，
 *    与"没测到"必须可区分。
 */

import { describe, expect, it } from "vitest";
import type { Keypoint2D } from "@pingpong/contracts";
import { FINGER_NAMES, extractHandGeometry } from "../src/hand.js";

const HAND_SUFFIXES = [
  "wrist",
  "thumb_cmc",
  "thumb_mcp",
  "thumb_ip",
  "thumb_tip",
  "index_mcp",
  "index_pip",
  "index_dip",
  "index_tip",
  "middle_mcp",
  "middle_pip",
  "middle_dip",
  "middle_tip",
  "ring_mcp",
  "ring_pip",
  "ring_dip",
  "ring_tip",
  "pinky_mcp",
  "pinky_pip",
  "pinky_dip",
  "pinky_tip",
] as const;

function kp(name: string, x: number, y: number, visible = true): Keypoint2D {
  return { name, xPx: x, yPx: y, score: 0.9, visible } as Keypoint2D;
}

/**
 * 构造一只手指全伸直的右手。
 *
 * 几何：腕在 (0, 100)，四指沿 +y 方向伸出（MCP → PIP → TIP 共线），
 * 所以每个 PIP 处的夹角都应是 180°。共线是刻意的 —— 这样"伸直"有唯一解释。
 */
function straightRightHand(): Keypoint2D[] {
  const pts: Keypoint2D[] = [];
  const fingerX: Record<string, number> = { index: 20, middle: 30, ring: 40, pinky: 50 };
  pts.push(kp("right_hand_wrist", 0, 100));
  for (const finger of FINGER_NAMES) {
    const x = fingerX[finger]!;
    pts.push(kp(`right_hand_${finger}_mcp`, x, 40));
    pts.push(kp(`right_hand_${finger}_pip`, x, 20));
    // 共线的 dip/tip：直线上的点不影响角度，但它们是真实存在的关键点
    pts.push(kp(`right_hand_${finger}_dip`, x, 10));
    pts.push(kp(`right_hand_${finger}_tip`, x, 0));
  }
  // 拇指：与掌轴张开（不共线），张开度应明显大于 0
  pts.push(kp("right_hand_thumb_cmc", -10, 80));
  pts.push(kp("right_hand_thumb_mcp", -20, 60));
  pts.push(kp("right_hand_thumb_ip", -25, 45));
  pts.push(kp("right_hand_thumb_tip", -30, 30));
  return pts;
}

describe("extractHandGeometry — 缺失处理", () => {
  it("完全没有手部点时，各项为 null 并给出原因（不用 0 顶替）", () => {
    const g = extractHandGeometry([kp("right_wrist", 100, 100)], "right");
    expect(g.reasonIfMissing).not.toBeNull();
    expect(g.visiblePointCount).toBe(0);
    // 关键：0 度是合法的屈曲角，不能被用来表示"没测到"
    for (const f of FINGER_NAMES) {
      expect(g.fingerFlexionDeg[f]).toBeNull();
    }
    expect(g.thumbSpreadDeg).toBeNull();
  });

  it("缺少掌心锚点（食指根/小指根）时判为缺失，不硬算", () => {
    const partial = [
      kp("right_hand_wrist", 0, 100),
      kp("right_hand_index_pip", 20, 20),
      // 缺 index_mcp 与 pinky_mcp
    ];
    const g = extractHandGeometry(partial, "right");
    expect(g.reasonIfMissing).not.toBeNull();
  });

  it("不可见的点按缺失处理，不参与计算", () => {
    const pts = straightRightHand().map((k) =>
      k.name === "right_hand_pinky_mcp" ? { ...k, visible: false } : k,
    );
    const g = extractHandGeometry(pts, "right");
    // 掌宽锚点不可见 → 整只手判为缺失，而不是拿它当 (0,0) 算
    expect(g.reasonIfMissing).not.toBeNull();
  });

  it("掌宽为 0（关键点退化重合）时判为缺缺失，不产生除零结果", () => {
    const pts = straightRightHand().map((k) => {
      if (k.name === "right_hand_index_mcp" || k.name === "right_hand_pinky_mcp") {
        return { ...k, xPx: 30, yPx: 40 };
      }
      return k;
    });
    const g = extractHandGeometry(pts, "right");
    expect(g.reasonIfMissing).not.toBeNull();
    expect(g.fingerFlexionDeg.index).toBeNull();
  });
});

describe("extractHandGeometry — 手指几何测量", () => {
  it("手指伸直时 PIP 夹角约为 180°", () => {
    const g = extractHandGeometry(straightRightHand(), "right");
    expect(g.reasonIfMissing).toBeNull();
    for (const f of FINGER_NAMES) {
      expect(g.fingerFlexionDeg[f]).not.toBeNull();
      expect(g.fingerFlexionDeg[f]!).toBeGreaterThan(179);
      expect(g.fingerFlexionDeg[f]!).toBeLessThanOrEqual(180);
    }
  });

  it("手指弯曲时 PIP 夹角显著小于伸直（方向正确）", () => {
    const bent = straightRightHand().map((k) => {
      // 把食指指尖折向掌心，形成明显夹角
      if (k.name === "right_hand_index_tip") return { ...k, xPx: 60, yPx: 20 };
      return k;
    });
    const g = extractHandGeometry(bent, "right");
    const index = g.fingerFlexionDeg.index!;
    expect(index).toBeLessThan(150);
    // 其他手指没被动过，仍应接近伸直 —— 证明不是整体偏移
    expect(g.fingerFlexionDeg.middle!).toBeGreaterThan(179);
  });

  it("掌宽按食指根—小指根算，且作为手部尺度可用", () => {
    const g = extractHandGeometry(straightRightHand(), "right");
    // 食指根 x=20、小指根 x=50，同 y=40 → 掌宽应为 30
    expect(g.palmWidthPx).toBeCloseTo(30, 5);
    expect(g.palmCenterPx.x).toBeCloseTo((0 + 20 + 50) / 3, 5);
    expect(g.palmCenterPx.y).toBeCloseTo((100 + 40 + 40) / 3, 5);
  });

  it("只统计本侧手部点，不会把另一只手的点算进来", () => {
    const both = [
      ...straightRightHand(),
      ...straightRightHand().map((k) => ({ ...k, name: k.name.replace("right_", "left_") })),
    ];
    const g = extractHandGeometry(both, "right");
    expect(g.visiblePointCount).toBe(HAND_SUFFIXES.length);
  });
});

describe("输出形状不得包含拍面类结论（红线 3）", () => {
  it("几何对象里没有任何拍面/握力字段", () => {
    const g = extractHandGeometry(straightRightHand(), "right");
    const keys = Object.keys(g);
    const forbidden = /racket|paddle|blade|face|grip|pressure|force|orient|normal/i;
    for (const k of keys) {
      expect(k).not.toMatch(forbidden);
    }
    // 同时确认字段名都是"观测值"口径
    expect(keys).toContain("fingerFlexionDeg");
    expect(keys).toContain("thumbSpreadDeg");
  });
});
