/**
 * 界面预设与契约的**一一对应**检查。
 *
 * 守的是一个很难发现的形状：契约里定义了一个枚举值，界面却**没提供入口** ——
 * 用户永远选不到它，而代码那边可能还在算。
 *
 * F-018 就是这么发现的：`FOCUS_IDS` 有 `intra_group_consistency`，
 * 而 `FOCUS_OPTIONS` 没有它 —— 同时 `computeFeatures` **每次都算**
 * 那个特征。等于"算了没人看，想选也选不到"。
 *
 * 反方向（界面有、契约没有）同样要拦：那会让类型层放行一个不存在的值。
 *
 * 注意这里比的是**集合相等**，不是顺序 —— 顺序影响的是下拉框展示次序，
 * 那是产品决定，不该被测试钉死。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FOCUS_IDS } from "@pingpong/contracts";
import { CAMERA_VIEW_OPTIONS, FOCUS_OPTIONS, STROKE_TYPE_OPTIONS } from "../src/config/presets.js";

const repoRoot = resolve(__dirname, "../../..");

/** 从契约源码里抽一个字符串枚举（避免为了测试改契约的导出面）。 */
function contractEnum(name: string): string[] {
  const src = readFileSync(resolve(repoRoot, "packages/contracts/src/constants.ts"), "utf8");
  const i = src.indexOf(`${name} = [`);
  if (i < 0) return [];
  const open = src.indexOf("[", i);
  const close = src.indexOf("]", open);
  return [...src.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

function sortedIds(opts: ReadonlyArray<{ id: string }>): string[] {
  return opts.map((o) => o.id).sort();
}

describe("界面预设与契约枚举一一对应", () => {
  it("FOCUS_OPTIONS 与 FOCUS_IDS 集合相等（不漏、不多）", () => {
    const missing = [...FOCUS_IDS].filter((id) => !FOCUS_OPTIONS.some((o) => o.id === id));
    const extra = FOCUS_OPTIONS.filter((o) => !(FOCUS_IDS as readonly string[]).includes(o.id));

    // 契约里有、界面没提供 → 用户永远选不到（F-018）
    expect(missing, `这些关注点契约里有、界面没提供：${missing.join(", ")}`).toEqual([]);
    // 界面有、契约没有 → 类型层会放行一个不存在的值
    expect(
      extra.map((o) => o.id),
      "界面提供了契约里不存在的关注点",
    ).toEqual([]);
  });

  it("CAMERA_VIEW_OPTIONS 是 CAMERA_VIEWS 的子集（可以刻意少提供）", () => {
    const views = contractEnum("CAMERA_VIEWS");
    expect(views.length).toBeGreaterThan(0);

    const extra = CAMERA_VIEW_OPTIONS.filter((o) => !views.includes(o.id));
    expect(
      extra.map((o) => o.id),
      "界面提供了契约里不存在的机位",
    ).toEqual([]);

    // 允许少提供（例如不支持某机位），但**不允许为空** —— 空下拉框是坏交互
    expect(CAMERA_VIEW_OPTIONS.length).toBeGreaterThan(0);
  });

  it("STROKE_TYPE_OPTIONS 与契约的 strokeType 字面量一致", () => {
    const src = readFileSync(resolve(repoRoot, "packages/contracts/src/primitives.ts"), "utf8");
    const m = src.match(/strokeTypeSchema = z\.literal\("([^"]+)"\)/);
    expect(m, "契约里找不到 strokeTypeSchema 的字面量").not.toBeNull();
    expect(sortedIds(STROKE_TYPE_OPTIONS)).toEqual([m![1]]);
  });

  it("每个选项都有非空 label（下拉框不能出现空白项）", () => {
    for (const o of [...FOCUS_OPTIONS, ...STROKE_TYPE_OPTIONS, ...CAMERA_VIEW_OPTIONS]) {
      expect(o.label.length, `${o.id} 的 label 为空`).toBeGreaterThan(0);
    }
  });
});
