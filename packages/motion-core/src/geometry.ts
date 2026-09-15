/**
 * 二维几何计算。
 *
 * 本模块只做纯计算，不依赖 DOM、React、MediaPipe、数据库或网络。
 * 所有函数对非法输入返回 null，由调用方决定如何降级 —— 绝不返回 0 冒充测量值。
 */

export interface Point2D {
  x: number;
  y: number;
}

/** 判断点是否可用于计算。缺失点保持缺失，不补零。 */
export function isUsablePoint(p: Point2D | null | undefined): p is Point2D {
  return p != null && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/**
 * 两点欧氏距离（同一坐标空间内）。
 * 像素距离不能标成厘米；需要真实尺度时必须先按本次标定归一化。
 */
export function distance(a: Point2D, b: Point2D): number | null {
  if (!isUsablePoint(a) || !isUsablePoint(b)) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 三点夹角，单位为度。b 为顶点（例如右肘）。
 * 返回 [0, 180]，180 表示完全伸直。
 *
 * 重要：输入的三个点必须已经在**同一真实空间**中。
 * 如果手头是归一化坐标（0–1），必须先分别乘原图宽高还原成像素，
 * 否则长宽比会把角度算歪。使用 `angleDegFromNormalized` 自动处理。
 */
export function angleDeg(a: Point2D, b: Point2D, c: Point2D): number | null {
  if (!isUsablePoint(a) || !isUsablePoint(b) || !isUsablePoint(c)) return null;

  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;

  const n1 = Math.hypot(v1x, v1y);
  const n2 = Math.hypot(v2x, v2y);
  // 退化：任一线段长度为 0 时角度无定义，返回 null 而不是 0。
  if (n1 === 0 || n2 === 0) return null;

  const cos = (v1x * v2x + v1y * v2y) / (n1 * n2);
  const clamped = Math.min(1, Math.max(-1, cos));
  return (Math.acos(clamped) * 180) / Math.PI;
}

/**
 * 用归一化坐标计算夹角，内部先乘原图宽高。
 *
 * 这是方案第 7 节明确要求的修正：直接用归一化 x/y 算角度会因长宽比失真。
 * 例：1280×720 画面、真实 90 度的角，直接用归一化坐标会算成约 60 度。
 */
export function angleDegFromNormalized(
  a: Point2D,
  b: Point2D,
  c: Point2D,
  imageWidth: number,
  imageHeight: number,
): number | null {
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null;
  if (!isUsablePoint(a) || !isUsablePoint(b) || !isUsablePoint(c)) return null;

  const scale = (p: Point2D): Point2D => ({
    x: p.x * imageWidth,
    y: p.y * imageHeight,
  });
  return angleDeg(scale(a), scale(b), scale(c));
}

/**
 * 体尺度：用于把像素测量归一化成"身体比例"，避免不同距离/画幅直接比像素。
 * 采用肩中点到髋中点的距离作为参考长度；比身长更稳定，且不受下肢出画影响。
 */
export function bodyScale(shoulderMid: Point2D, hipMid: Point2D): number | null {
  const d = distance(shoulderMid, hipMid);
  if (d == null || d <= 0) return null;
  return d;
}

export function midpoint(a: Point2D, b: Point2D): Point2D | null {
  if (!isUsablePoint(a) || !isUsablePoint(b)) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * 去掉整体平移后的相对位移。
 *
 * 用途：观察肘部相对躯干的移动趋势，而不是整个人在场上的移动。
 * 注意：两点移动场景下**不能**用它，那样会把场地位移本身全部消除。
 */
export function relativeToReference(point: Point2D, reference: Point2D): Point2D | null {
  if (!isUsablePoint(point) || !isUsablePoint(reference)) return null;
  return { x: point.x - reference.x, y: point.y - reference.y };
}

/** 一维数值的均值。空数组返回 null，不返回 0。 */
export function mean(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return null;
  return clean.reduce((s, v) => s + v, 0) / clean.length;
}

/** 中位数。对小样本比均值更能抵抗单次异常。 */
export function median(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  if (clean.length % 2 === 1) return clean[mid] ?? null;
  const lo = clean[mid - 1];
  const hi = clean[mid];
  if (lo == null || hi == null) return null;
  return (lo + hi) / 2;
}

/**
 * 变异系数（标准差 / 均值绝对值）。用于组内一致性。
 * 均值接近 0 时返回 null，因为此时 CV 没有解释意义。
 */
export function coefficientOfVariation(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return null;
  const m = mean(clean);
  if (m == null || Math.abs(m) < 1e-9) return null;
  const variance = clean.reduce((s, v) => s + (v - m) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(variance) / Math.abs(m);
}

/**
 * 分位数（线性插值）。空数组返回 null。
 */
export function quantile(values: number[], q: number): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  if (q <= 0) return clean[0] ?? null;
  if (q >= 1) return clean[clean.length - 1] ?? null;
  const pos = (clean.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loV = clean[lo];
  const hiV = clean[hi];
  if (loV == null || hiV == null) return null;
  if (lo === hi) return loV;
  return loV + (hiV - loV) * (pos - lo);
}
