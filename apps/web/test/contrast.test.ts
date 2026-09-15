/**
 * 主题配色的对比度检查（roadmap A9 的后半部分）。
 *
 * 为什么值得有回归：配色是"改一个变量"就能悄悄跌破可读性的东西，
 * 而且不像布局错误那样一眼看得出来 —— 使用者只会觉得"看着累"。
 * 这里按 WCAG 2.1 的相对亮度公式算出关键色对的对比度并设门槛，
 * 改主题色导致不达标时会直接失败。
 *
 * 门槛采用 WCAG AA：
 * - 正文文字 ≥ 4.5:1
 * - 大号文字与非文字图形（边框、图标）≥ 3:1
 */

import { describe, expect, it } from "vitest";

/** sRGB 单通道 → 线性值（WCAG 2.1 定义）。 */
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 相对亮度。 */
function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** 两色对比度，1:1 到 21:1。 */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** 与 src/ui/styles.css 的 :root 保持一致。改那里就要同步这里。 */
const THEME = {
  bg: "#0f1216",
  panel: "#171c23",
  panel2: "#1e2530",
  /** 装饰性分隔线（面板外框、表格行线） */
  border: "#2a3340",
  /** 交互控件边框（input / select / button / tab） */
  borderControl: "#64728c",
  text: "#e6edf3",
  muted: "#93a1b1",
  accent: "#4ea1ff",
  ok: "#3fb950",
  warn: "#d29922",
  danger: "#f85149",
  /** tab.active 的前景色（深色字压在 accent 上） */
  onAccent: "#06121f",
} as const;

/** 正文文字门槛。 */
const AA_TEXT = 4.5;
/** 非文字图形（边框、分隔线）门槛。 */
const AA_NON_TEXT = 3;

describe("主题配色对比度（WCAG AA）", () => {
  it("正文与次要文字在各背景上都达到 4.5:1", () => {
    for (const bg of ["panel", "bg", "panel2"] as const) {
      expect(
        contrastRatio(THEME.text, THEME[bg]),
        `text 在 ${bg} 上不足 4.5:1`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
      expect(
        contrastRatio(THEME.muted, THEME[bg]),
        `muted 在 ${bg} 上不足 4.5:1`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("状态色（accent/ok/warn/danger）作为文字时达到 4.5:1", () => {
    // 徽标与测量值都用这些颜色直接当文字色，所以按正文门槛要求
    for (const c of ["accent", "ok", "warn", "danger"] as const) {
      expect(
        contrastRatio(THEME[c], THEME.panel),
        `${c} 在 panel 上不足 4.5:1`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("压在强调色上的文字达到 4.5:1（选中态 tab）", () => {
    expect(contrastRatio(THEME.onAccent, THEME.accent)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("交互组件的边框达到 3:1（WCAG 1.4.11 非文字对比度）", () => {
    // --border-control 用在 tab / select / input / button 的边框上 ——
    // 这些是**交互组件**，其边界必须可辨认，属 1.4.11 的适用范围。
    //
    // 这条是真实修过的缺陷：原先交互控件与装饰线共用 --border (#2a3340)，
    // 对控件自身背景只有 1.21:1，深色主题下很难看出输入框边界在哪。
    //
    // 注意比的是「边框 vs 它相邻的表面」，而不是页面背景 ——
    // 表单控件的背景是 --panel-2，跟 --bg 比会得出与用户实际观感无关的数字。
    const adjacentSurfaces = [
      ["panel-2（表单控件自身背景）", THEME.panel2],
      ["panel（tab 的背景）", THEME.panel],
    ] as const;
    for (const [label, bg] of adjacentSurfaces) {
      expect(
        contrastRatio(THEME.borderControl, bg),
        `控件边框在 ${label} 上不足 3:1`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it("装饰性分隔线不必满足 3:1，但必须与背景可区分", () => {
    // 顶栏下沿、面板外框、表格行线这类**装饰性**线条不属 1.4.11 适用范围
    // （它不表达状态、也不是控件边界）。这里只要求"不是完全看不见"，
    // 不套用 3:1 —— 用假门槛换来的达标感没有意义。
    expect(contrastRatio(THEME.border, THEME.bg)).toBeGreaterThan(1.2);
    // 同时确认它确实比控件边框弱，两者分工没有被写反
    expect(contrastRatio(THEME.border, THEME.panel2)).toBeLessThan(
      contrastRatio(THEME.borderControl, THEME.panel2),
    );
  });

  it("对比度公式自检：黑白为 21:1，同色为 1:1", () => {
    // 防止公式写错导致上面几条变成永远通过的空断言
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#4ea1ff", "#4ea1ff")).toBeCloseTo(1, 5);
  });
});
