#!/usr/bin/env node
/**
 * "有没有接上"审计。
 *
 * 为什么需要它：本项目反复出现的缺陷**不是**"某个函数算错了"，而是
 * **某个函数根本没被调用**。测试断言的是函数行为 —— 一个零调用的函数，
 * 它的测试全绿也说明不了任何事。这类问题在两位审计里各抓出一个真缺陷：
 *
 * - 正向：`computeElbowAngleAtForwardPeak` 定义了、测过了、**零调用** ——
 *   而它对应界面里**用户可选**的关注点「肘角伸展模式」（F-016 第一层）；
 * - 反向：mock 适配器忽略 `packet.focusId`，对任何关注点都讲返回准备区时间
 *   （F-016 第二层）。
 *
 * 这个脚本固化**正向**那一半：公开导出必须有人用，或者**显式登记为豁免**。
 *
 * 纪律：豁免清单必须写**理由**。清单不是"让检查通过"的开关 ——
 * 它是"我们明知这些符号当前无人调用，并且接受这一点"的书面记录。
 * 新增豁免要在 review 里能回答"为什么它可以没人用"。
 *
 * 用法：
 *   node scripts/audit-wiring.mjs          # 检查
 *   node scripts/audit-wiring.mjs --list   # 只列出当前零调用的符号
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/**
 * 豁免清单：明知当前无产品代码调用、且**接受**这一点的运行时导出。
 *
 * key = 符号名，value = 理由。理由必须具体到"为什么它可以没人用" ——
 * 写"暂时无调用"不算理由。
 */
const ALLOWED_UNWIRED = {
  // ── 基础几何/统计工具：库 API 面的一部分。
  //    「没有任何外部调用方」对基础工具是正常状态，不是缺陷。
  angleDeg: "基础几何工具（motion-core 内部与外部调用方共用）",
  angleDegFromNormalized: "长宽比修正入口（F-004 的显式 API，供外部复用）",
  distance: "基础几何工具",
  isUsablePoint: "基础几何工具",
  midpoint: "基础几何工具",
  mean: "基础统计工具",
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
  ScalarFilter: "泛型标量滤波器；产品的姿态链路用 PointFilter",
  SpeedEstimator: "速度估计器；当前分段状态机内部自算速度",

  // ── 准备区标定阈值：具名常量，供调参与文档引用。
  DWELL_MIN_SAMPLES: "标定阈值常量",
  MAX_ADJACENT_GAP_MS: "标定阈值常量",
  MAX_LOCAL_SPEED_PX: "标定阈值常量",
  SLOW_FRACTION: "标定阈值常量",

  // ── 手部：契约、几何、左右分配都已就绪，但**产品链路受素材限制** ——
  //    现有素材挥拍时手被运动模糊糊掉（实测放大 3 倍仍检不出）。
  //    保留是因为能力本身要留下，等有可用素材即可接上。
  //    ⚠️ 这不是"永远豁免"：素材问题解决后应当接进产品并删掉这几条。
  extractHandGeometry: "手部几何；受素材限制尚未接入（见 known-failures 手部一节）",
  FINGER_NAMES: "手指名常量；供 extractHandGeometry 的调用方遍历",
  HAND_LANDMARK_INDEX: "手部关键点索引常量；适配层用具名映射，无需索引表",

  // ── 镜像与持拍侧语义：提供给"镜像预览但保留真实左右标签"的调用方。
  mirrorHandedness: "持拍侧镜像语义工具（F-010 相关的显式 API）",
  racketSideKeypointNames: "持拍侧关键点名工具",
};

const args = new Set(process.argv.slice(2));

/**
 * 收集一个目录下所有 .ts 文件的**运行时**导出符号名。
 *
 * 只看 `function` / `const` / `class` —— **不看 `interface` / `type`**。
 * 类型的"被使用"发生在编译期，用文本搜调用点没有意义
 * （`Point2D`、`HandGeometry` 这类永远搜不到"调用"），
 * 混进来只会把真信号淹掉。
 */
async function collectExports(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
  const out = new Map(); // symbol -> 定义所在文件
  for (const file of files) {
    const src = await readFile(join(dir, file), "utf8");
    const re = /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;
    for (const m of src.matchAll(re)) out.set(m[1], file);
  }
  return out;
}

/** 递归收集一组目录下的所有 .ts/.tsx 文件内容。 */
async function collectSources(dirs) {
  const sources = [];
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
        sources.push(await readFile(full, "utf8"));
      }
    }
  }
  for (const d of dirs) await walk(d);
  return sources;
}

async function main() {
  const motionCoreSrc = resolve(repoRoot, "packages/motion-core/src");
  const exportsMap = await collectExports(motionCoreSrc);

  // 只看产品代码与知识/配置：测试里出现不算"接上了"
  const consumers = await collectSources([
    resolve(repoRoot, "apps/api/src"),
    resolve(repoRoot, "apps/web/src"),
    resolve(repoRoot, "knowledge"),
    resolve(repoRoot, "configs"),
  ]);
  const haystack = consumers.join("\n");

  const unwired = [];
  for (const [sym, file] of exportsMap) {
    // 用词边界匹配，避免 `mean` 命中 `meaning`
    const re = new RegExp(`\\b${sym.replace(/\$/g, "\\$")}\\b`);
    if (!re.test(haystack)) unwired.push({ sym, file });
  }

  unwired.sort((a, b) => a.sym.localeCompare(b.sym));

  if (args.has("--list")) {
    for (const { sym, file } of unwired) console.log(`  ${sym.padEnd(34)} ${file}`);
    console.log(`\n共 ${unwired.length} 个零调用导出`);
    return;
  }

  const unlisted = unwired.filter(({ sym }) => !(sym in ALLOWED_UNWIRED));
  const stale = Object.keys(ALLOWED_UNWIRED).filter((sym) => !unwired.some((u) => u.sym === sym));

  console.log(
    `motion-core 公开导出 ${exportsMap.size} 个，其中 ${unwired.length} 个产品代码零调用。`,
  );
  console.log(`豁免清单 ${Object.keys(ALLOWED_UNWIRED).length} 项。\n`);

  let failed = false;

  if (unlisted.length > 0) {
    failed = true;
    console.error("✗ 以下公开导出没有任何产品代码调用，且不在豁免清单里：\n");
    for (const { sym, file } of unlisted) {
      console.error(`    ${sym}  (${file})`);
    }
    console.error(
      "\n  这不一定是要删 —— 但要**明确决定**：接进产品、删掉、或加进豁免清单并写明理由。\n" +
        "  「定义了、测过了、没人调用」是本项目反复出现的缺陷形状（见 known-failures F-016）。",
    );
  }

  if (stale.length > 0) {
    // 清单过期同样是问题：它会让后来的人以为某符号仍无人用
    failed = true;
    console.error("✗ 豁免清单里有已失效的条目（该符号现在有人调用了，或已不存在）：\n");
    for (const sym of stale) console.error(`    ${sym}`);
    console.error("\n  请把它们从 scripts/audit-wiring.mjs 的 ALLOWED_UNWIRED 里删掉。");
  }

  if (failed) process.exit(1);
  console.log("✓ 所有公开导出要么被产品代码调用，要么在豁免清单里写明了理由。");
}

main().catch((err) => {
  console.error(`audit-wiring 失败：${err.message}`);
  process.exit(1);
});
