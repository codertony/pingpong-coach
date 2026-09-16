#!/usr/bin/env node
/**
 * "有没有接上"审计。
 *
 * ══ 为什么需要它 ══
 *
 * 本项目反复出现的缺陷**不是**"某个函数算错了"，而是**某个函数根本没被调用**。
 * 测试断言的是函数行为 —— 一个零调用的函数，它的测试再完备也说明不了任何事。
 * 最近一轮审计抓出的全是这一类：
 *
 * - `computeElbowAngleAtForwardPeak` 定义了、测过了、**零调用** ——
 *   而它对应界面里**用户可选**的关注点（F-016 第一层）；
 * - mock 适配器忽略 `packet.focusId`，对任何关注点都讲返回准备区时间（F-016 第二层）；
 * - `CAMERA_VIEW_OPTIONS` 导出后零引用，而 App.tsx 把机位选项**硬编码**了一遍 ——
 *   两份列表可以漂移，当时恰好一致所以没人发现。
 *
 * ══ 两种模式，故意分开 ══
 *
 * `--strict`（CI 用）：断言**新增的孤儿导出必须被显式登记**。
 *   判据确定、不误报，所以可以拿来拦门禁。
 *
 * 不带参数（**报告模式**，退出码始终 0）：列出所有孤儿导出供人工过一遍。
 *   这类符号**可能是**忘了接，也可能是同文件内组合使用的正常出口 ——
 *   机器分不清，所以**不拿它拦门禁**，只提供线索。
 *
 * 这个分工是刻意的：一个会误报的门禁，最后一定会被人加一堆豁免绕过，等于没有。
 * 宁可让机器只跑得动的判据拦 CI，把分不清的交给报告 + 人工判断。
 *
 * 用法：
 *   node scripts/audit-wiring.mjs            # 人工用：孤儿导出报告
 *   node scripts/audit-wiring.mjs --strict   # CI 用：未登记的孤儿导出 → 失败
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/**
 * 豁免清单：明知当前没有产品代码调用、且**接受**这一点的运行时导出。
 *
 * key = 符号名，value = 理由。理由必须具体到"为什么它可以没人用" ——
 * 写"暂时无调用"不算理由。
 */
const ALLOWED_UNWIRED = {
  // ── 基础几何/统计工具：库 API 面的一部分。
  angleDeg: "基础几何工具（motion-core 内部与外部调用方共用）",
  angleDegFromNormalized: "长宽比修正入口（F-004 的显式 API）",
  distance: "基础几何工具",
  isUsablePoint: "基础几何工具",
  midpoint: "基础几何工具",
  mean: "基础统计工具",
  median: "基础统计工具",
  quantile: "基础统计工具",
  coefficientOfVariation: "基础统计工具",
  relativeToReference: "基础坐标工具",
  fromSourcePixel: "坐标变换工具（与 toSourcePixel 成对）",
  toSourcePixel: "坐标变换工具（与 fromSourcePixel 成对）",
  summarizeValues: "统计汇总工具，供 quality / features 组合",
  findKeypoint: "关键点查找工具，供外部调用方",
  pointOf: "关键点取值工具（quality / features 内部消费）",
  isInsideFrame: "画面范围检查工具",

  // ── 滤波器配置：config 是**数据**，由 filter 模块的类消费。
  NO_FILTER: "滤波器配置常量",
  emaConfig: "滤波器配置工厂",
  oneEuroConfig: "滤波器配置工厂（团队其它模块可复用）",
  ScalarFilter: "泛型标量滤波器；产品的姿态链路用 PointFilter",
  SpeedEstimator: "速度估计器；当前分段状态机内部自算速度",

  // ── 准备区标定阈值：具名常量，供调参与文档引用。
  DWELL_MIN_SAMPLES: "标定阈值常量",
  MAX_ADJACENT_GAP_MS: "标定阈值常量",
  MAX_LOCAL_SPEED_PX: "标定阈值常量",
  SLOW_FRACTION: "标定阈值常量",

  // ── 手部：契约、几何、左右分配都已就绪，但**产品链路受素材限制** ——
  //    现有素材挥拍时手被运动模糊糊掉（实测放大 3 倍仍检不出）。
  //    ⚠️ 不是永久豁免：素材问题解决后应当接进产品并删掉这几条。
  extractHandGeometry: "手部几何；受素材限制尚未接入（见 known-failures 手部一节）",
  FINGER_NAMES: "手指名常量；供 extractHandGeometry 的调用方遍历",
  HAND_LANDMARK_INDEX: "手部关键点索引常量；适配层用具名映射",

  // ── 镜像与持拍侧语义：提供给"镜像预览但保留真实左右标签"的调用方。
  mirrorHandedness: "持拍侧镜像语义工具（F-010 相关的显式 API）",
  racketSideKeypointNames: "持拍侧关键点名工具",

  // ── contracts 里的 zod schema：**全部是同文件内组合 + z.infer 类型来源**。
  //
  // 为什么会被判成孤儿：`keypoint2DSchema` 被 `poseFrameSchema` 引用、
  // `strokePhaseSchema` 被 `strokeEventSchema` 引用 —— 但它们都在**同一个文件**里，
  // 所以"名字只出现在定义文件"这条判据会命中它们。
  // 它们不是忘了接：schema 是分层的，底层 schema 天然只在本文件被上层组合；
  // 导出的目的是让使用方能 `z.infer<>` 出对应类型。
  //
  // 这一批是**已知误报**，逐条登记而不是改判据 —— 因为把判据放宽到能自动
  // 区分"同文件组合"与"真没人要"，需要 AST 分析，收益不抵复杂度。
  ALL_KEYPOINT_NAMES: "contracts 内部组合用；导出供使用时做键名枚举",
  keypoint2DSchema: "被同文件 poseFrameSchema 组合；导出供 z.infer 取类型",
  imageTransformSchema: "被同文件组合使用；导出供 z.infer 取类型",
  IDENTITY_TRANSFORM: "恒等变换常量，供外部做配置默认值",
  strokeAnchorSchema: "被同文件 strokeEventSchema 组合；导出供 z.infer 取类型",
  strokePhaseSchema: "被同文件组合使用；导出供 z.infer 取类型",
  segmentationConfigSchema: "供使用方构造分割配置并取类型",
  coordinateSpaceSchema: "被同文件组合使用；导出供 z.infer 取类型",
  featureUnitSchema: "被同文件组合使用；导出供 z.infer 取类型",
  evidenceKeyframeSchema: "被同文件组合使用；导出供 z.infer 取类型",
  feedbackStatusSchema: "被同文件 coachFeedbackSchema 组合；导出供 z.infer 取类型",
  healthResponseSchema: "供 API 客户端取响应类型",
  analyzeResponseSchema: "供 API 客户端取响应类型",
  apiErrorSchema: "供 API 客户端取错误类型",
  modelOutputSchema: "被同文件 validateModelOutput 使用，并导出供 z.infer 取 ModelOutput 类型",
};

/**
 * 要扫的包：每个包的 src 目录。
 *
 * **必须扫全部包** —— 只扫 motion-core 会漏掉 apps 里的孤儿导出
 * （`CAMERA_VIEW_OPTIONS` 就是这么被漏掉的：它在 apps/web 里零引用）。
 */
const AUDITED_PACKAGES = [
  "packages/motion-core/src",
  "packages/contracts/src",
  "apps/web/src",
  "apps/api/src",
];

const strict = process.argv.includes("--strict");

/**
 * 收集目录下 .ts 文件的**运行时**导出。
 *
 * 只看 `function` / `const` / `class` —— **不看 `interface` / `type`**。
 * 类型的"被使用"发生在编译期，用文本搜使用点没有意义
 * （`Point2D`、`HandGeometry` 这类永远搜不到），混进来只会淹没真信号。
 *
 * ⚠️ **必须递归**。这里踩过一个真实的坑：第一版用 `readdir(dir)` 只读**一层**，
 * 于是 packages 各包的 src（扁平）扫得到，而 `apps/web/src` 与 `apps/api/src`
 * 全是子目录 —— **一个文件都没扫到**。
 * 而脚本自己的注释写着"必须扫全部包，只扫 motion-core 会漏掉 apps 里的孤儿导出"，
 * 文档也这么说：**意图是对的，实现没有做到，两边谁都没发现**。
 * 直到往 `apps/web/src/training/` 里塞了一个没人用的导出、门禁居然放行，
 * 才暴露出来（见 known-failures F-023）。
 *
 * 这类"门禁看起来在守、实际没守"的问题比没有门禁更糟：
 * 它会让人以为这一块已经被覆盖了。
 */
async function collectExports(dir) {
  const out = new Map();
  async function walk(current, prefix) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(current, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist") continue;
        await walk(full, prefix ? `${prefix}/${e.name}` : e.name);
        continue;
      }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".d.ts")) continue;
      const src = await readFile(full, "utf8");
      const re = /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      for (const m of src.matchAll(re)) out.set(m[1], rel);
    }
  }
  await walk(dir, "");
  return out;
}

/** 递归收集源文件内容（带路径）。 */
async function collectSources(dirs) {
  const sources = new Map();
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist") continue;
        await walk(full);
      } else if (/\.(ts|tsx|mjs|json)$/.test(e.name)) {
        sources.set(full, await readFile(full, "utf8"));
      }
    }
  }
  for (const d of dirs) await walk(d);
  return sources;
}

/** 每个符号出现在几个文件里（只出现在自己文件里 = 1）。 */
async function fileCountsFor(symbols) {
  const sources = await collectSources([
    resolve(repoRoot, "packages"),
    resolve(repoRoot, "apps"),
    resolve(repoRoot, "knowledge"),
    resolve(repoRoot, "configs"),
    resolve(repoRoot, "scripts"),
  ]);
  const counts = new Map();
  for (const sym of symbols) {
    const re = new RegExp(`\\b${sym.replace(/\$/g, "\\$")}\\b`);
    let n = 0;
    for (const src of sources.values()) if (re.test(src)) n++;
    counts.set(sym, n);
  }
  return counts;
}

async function main() {
  const exportsMap = new Map();
  for (const rel of AUDITED_PACKAGES) {
    for (const [sym, file] of await collectExports(resolve(repoRoot, rel))) {
      exportsMap.set(sym, `${rel}/${file}`);
    }
  }

  const counts = await fileCountsFor([...exportsMap.keys()]);

  /*
   * 孤儿导出：名字只出现在**它自己的定义文件**里（别处一句话都没提）。
   *
   * 更"聪明"的判据（去产品代码里搜使用点）会大量误报 zod schema 这类
   * 通过 `z.infer<>` 与类型使用的符号 —— 误报多了，门禁就会被人加豁免绕过。
   * 所以这里只回答一个**确定**的问题：这个导出是不是只有它自己知道。
   */
  const orphans = [...exportsMap.entries()]
    .filter(([sym]) => (counts.get(sym) ?? 0) <= 1)
    .map(([sym, file]) => ({ sym, file }))
    .sort((a, b) => a.sym.localeCompare(b.sym));

  // ── 报告模式（默认）：只给线索，不拦门禁 ──
  if (!strict) {
    console.log(
      `扫了 ${exportsMap.size} 个运行时导出，其中 ${orphans.length} 个只在定义文件里出现。\n`,
    );
    if (orphans.length === 0) {
      console.log("✓ 没有孤儿导出。");
      return;
    }
    console.log("以下导出别处一句话都没提。**可能是**忘了接进产品，");
    console.log("也可能是同文件内组合使用的正常出口 —— 机器分不清，请人工过一遍：\n");
    for (const { sym, file } of orphans) console.log(`  ${sym.padEnd(34)} ${file}`);
    console.log("\n  要接的接上；要留的加进 ALLOWED_UNWIRED 并写明理由；不要的删掉。");
    return;
  }

  // ── 严格模式（CI）：断言**新增的孤儿导出必须被显式登记** ──
  //
  // 刻意**不**反查"清单里每条是否仍是孤儿"：孤儿判据（只在自己文件里出现）
  // 与清单的建立依据（产品代码零调用）**不是同一个度量**。
  // `mean` 就是"产品没用、别的模块在用"——它是豁免条目、却不是孤儿。
  // 拿孤儿去反查清单会把整张表判成过期，那种门禁只会被绕过。
  //
  // 但有一条**确定**的检查值得做：清单里的符号必须真的还存在。
  // 符号早被删掉、条目却留在表里，会让后来的人以为它仍被特别关照。
  const allExportNames = new Set(exportsMap.keys());
  const ghostEntries = Object.keys(ALLOWED_UNWIRED).filter((sym) => !allExportNames.has(sym));

  const unlisted = orphans.filter(({ sym }) => !(sym in ALLOWED_UNWIRED));

  if (unlisted.length === 0 && ghostEntries.length === 0) {
    console.log(`✓ 接线审计通过：${orphans.length} 个孤儿导出全部在豁免清单里写明了理由。`);
    return;
  }

  if (unlisted.length > 0) {
    console.error("✗ 以下孤儿导出不在豁免清单里：\n");
    for (const { sym, file } of unlisted) console.error(`    ${sym}  (${file})`);
    console.error(
      "\n  这不一定是要删 —— 但要**明确决定**：接进产品、删掉、或加进豁免清单并写明理由。\n" +
        "  「定义了、测过了、没人调用」是本项目反复出现的缺陷形状（见 known-failures F-016）。",
    );
  }

  if (ghostEntries.length > 0) {
    console.error("\n✗ 豁免清单里有已不存在的符号（早被删掉/改名了）：\n");
    for (const sym of ghostEntries) console.error(`    ${sym}`);
    console.error("\n  请把它们从 ALLOWED_UNWIRED 里删掉。");
  }

  process.exit(1);
}

main().catch((err) => {
  console.error(`audit-wiring 失败：${err.message}`);
  process.exit(1);
});
