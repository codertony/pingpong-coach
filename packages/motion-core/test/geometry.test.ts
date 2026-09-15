import { describe, expect, it } from "vitest";
import {
  angleDeg,
  angleDegFromNormalized,
  coefficientOfVariation,
  distance,
  median,
  quantile,
  bodyScale,
} from "../src/geometry.js";
import { fromSourcePixel, isInsideFrame, mirrorHandedness, toSourcePixel } from "../src/coordinates.js";
import type { ImageTransform } from "@pingpong/contracts";

describe("geometry.angleDeg", () => {
  it("直角返回 90 度（像素空间，等比）", () => {
    // b 为顶点，两条边分别指向 -x 和 +y，夹角恰为 90 度
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    const c = { x: 10, y: 10 };
    expect(angleDeg(a, b, c)).toBeCloseTo(90, 6);
  });

  it("三点共线且同向时返回 180 度（完全伸直）", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 5, y: 0 };
    const c = { x: 10, y: 0 };
    expect(angleDeg(a, b, c)).toBeCloseTo(180, 6);
  });

  it("线段退化时返回 null，而不是 0", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    const c = { x: 1, y: 1 };
    expect(angleDeg(a, b, c)).toBeNull();
  });

  it("输入含非有限值时返回 null", () => {
    expect(angleDeg({ x: Number.NaN, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });

  it("对 3-4-5 直角三角形的非直角给出正确值", () => {
    // 顶点在原点，一边沿 x 轴长 4，另一边到 (4,3)，夹角 arctan(3/4) ≈ 36.8699 度
    const angle = angleDeg({ x: 4, y: 0 }, { x: 0, y: 0 }, { x: 4, y: 3 });
    expect(angle).toBeCloseTo(36.8699, 3);
  });
});

describe("geometry.angleDegFromNormalized（长宽比修正）", () => {
  /**
   * 在像素空间里构造真实的肘角，再转成归一化坐标。
   * 只有非轴向的角度才会被长宽比扭曲：
   * 由水平边与竖直边组成的角，两条边各沿一个轴被独立缩放，比值不变，因此不失真。
   */
  const IMG_W = 1280;
  const IMG_H = 720;
  const toNorm = (p: { x: number; y: number }) => ({
    x: p.x / IMG_W,
    y: p.y / IMG_H,
  });

  /** 顶点在画面中心，一边水平向右，另一边与水平方向成 armAngleDeg */
  function trueAnglePoints(armAngleDeg: number, armPx = 200) {
    const b = { x: 640, y: 360 };
    const a = { x: 640 + armPx, y: 360 };
    const rad = (armAngleDeg * Math.PI) / 180;
    const c = {
      x: 640 + armPx * Math.cos(rad),
      y: 360 + armPx * Math.sin(rad),
    };
    return { a, b, c };
  }

  it("真实 60 度角，直接用归一化坐标会算成约 72 度", () => {
    const { a, b, c } = trueAnglePoints(60);
    // 像素空间：确认构造正确
    expect(angleDeg(a, b, c)).toBeCloseTo(60, 6);
    // 归一化空间直接算：被歪成约 72.01 度
    expect(angleDeg(toNorm(a), toNorm(b), toNorm(c))).toBeCloseTo(72.008, 2);
    // 乘回原图宽高：恢复真实 60 度
    expect(
      angleDegFromNormalized(toNorm(a), toNorm(b), toNorm(c), IMG_W, IMG_H),
    ).toBeCloseTo(60, 6);
  });

  it("真实 45 度角在归一化坐标下会被算成约 60.6 度", () => {
    const { a, b, c } = trueAnglePoints(45);
    expect(angleDeg(toNorm(a), toNorm(b), toNorm(c))).toBeCloseTo(60.642, 2);
    expect(
      angleDegFromNormalized(toNorm(a), toNorm(b), toNorm(c), IMG_W, IMG_H),
    ).toBeCloseTo(45, 6);
  });

  it("真实 135 度角（肘部接近伸直）也会被扭曲", () => {
    const { a, b, c } = trueAnglePoints(135);
    const naive = angleDeg(toNorm(a), toNorm(b), toNorm(c))!;
    // 归一化直算偏离真实值超过 1 度，足以影响肘角结论
    expect(Math.abs(naive - 135)).toBeGreaterThan(1);
    expect(
      angleDegFromNormalized(toNorm(a), toNorm(b), toNorm(c), IMG_W, IMG_H),
    ).toBeCloseTo(135, 6);
  });

  it("轴向直角在归一化空间下同样保持 90 度（说明失真只影响非轴向角）", () => {
    const b = { x: 640, y: 360 };
    const a = { x: 840, y: 360 };
    const c = { x: 640, y: 560 };
    expect(angleDeg(toNorm(a), toNorm(b), toNorm(c))).toBeCloseTo(90, 6);
  });

  it("正方形画面下归一化与像素结果一致", () => {
    const { a, b, c } = trueAnglePoints(60);
    const square = (p: { x: number; y: number }) => ({ x: p.x / 720, y: p.y / 720 });
    expect(angleDeg(square(a), square(b), square(c))).toBeCloseTo(60, 6);
  });

  it("画面宽高非法时返回 null", () => {
    const { a, b, c } = trueAnglePoints(60);
    expect(angleDegFromNormalized(toNorm(a), toNorm(b), toNorm(c), 0, IMG_H)).toBeNull();
    expect(angleDegFromNormalized(toNorm(a), toNorm(b), toNorm(c), IMG_W, -1)).toBeNull();
  });
});

describe("geometry.misc", () => {
  it("distance 对缺失点返回 null", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(distance({ x: Number.POSITIVE_INFINITY, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });

  it("median 偶数个取中间两数平均", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });

  it("coefficientOfVariation 在均值接近 0 时返回 null", () => {
    expect(coefficientOfVariation([0, 0, 0])).toBeNull();
    expect(coefficientOfVariation([10, 10, 10])).toBeCloseTo(0, 10);
  });

  it("quantile 端点与插值正确", () => {
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
    expect(quantile([], 0.5)).toBeNull();
  });

  it("bodyScale 用肩髋中点距离", () => {
    const s = bodyScale({ x: 0, y: 0 }, { x: 0, y: 100 });
    expect(s).toBe(100);
    expect(bodyScale({ x: 0, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });
});

describe("coordinates", () => {
  const base: ImageTransform = {
    rotationDeg: 0,
    mirrored: false,
    cropX: 100,
    cropY: 50,
    cropWidth: 800,
    cropHeight: 600,
    sourceWidth: 1280,
    sourceHeight: 720,
  };

  it("无旋转无镜像时只做裁剪平移", () => {
    expect(toSourcePixel({ x: 10, y: 20 }, base)).toEqual({ x: 110, y: 70 });
  });

  it("镜像时绕裁剪区中线翻转", () => {
    const t = { ...base, mirrored: true };
    // 镜像后 x' = cropWidth - x = 800 - 10 = 790
    expect(toSourcePixel({ x: 10, y: 20 }, t)?.x).toBe(790 + 100);
  });

  it("fromSourcePixel 是 toSourcePixel 的逆运算", () => {
    const t: ImageTransform = { ...base, mirrored: true, rotationDeg: 30 };
    const original = { x: 123.5, y: 456.25 };
    const toSrc = toSourcePixel(original, t);
    expect(toSrc).not.toBeNull();
    const back = fromSourcePixel(toSrc!, t);
    expect(back!.x).toBeCloseTo(original.x, 6);
    expect(back!.y).toBeCloseTo(original.y, 6);
  });

  it("旋转 90 度后逆变换仍能还原", () => {
    const t: ImageTransform = { ...base, rotationDeg: 90 };
    const original = { x: 400, y: 300 };
    const round = fromSourcePixel(toSourcePixel(original, t)!, t);
    expect(round!.x).toBeCloseTo(original.x, 6);
    expect(round!.y).toBeCloseTo(original.y, 6);
  });

  it("isInsideFrame 支持边距，贴边视为不可靠", () => {
    expect(isInsideFrame({ x: 2, y: 100 }, 1280, 720, 4)).toBe(false);
    expect(isInsideFrame({ x: 10, y: 100 }, 1280, 720, 4)).toBe(true);
    expect(isInsideFrame({ x: 1280, y: 100 }, 1280, 720, 0)).toBe(true);
  });

  it("mirrorHandedness 只交换语义标签，且是自反的", () => {
    expect(mirrorHandedness("right")).toBe("left");
    expect(mirrorHandedness(mirrorHandedness("right"))).toBe("right");
  });
});
