#!/usr/bin/env node
/**
 * 文档一致性检查。
 *
 * 为什么需要它：本仓库的文档要随测试数、脚本、命令反复更新，而**手工同步
 * 必然漂移** —— 这一轮开发里同一类问题至少手工修了 5 次（测试计数、
 * 不存在的命令、写错的端口、过时的路径）。每次都是"改了代码忘了改文档"，
 * 而文档一旦说错，读它的人会去查不存在的东西。
 *
 * 这个脚本只检查**机械可验**的那几类 —— 刻意不检查需要判断的内容：
 *
 * 1. 文档里写的 `pnpm <script>` 必须真的存在于 package.json；
 * 2. 文档里写的相对路径/文件必须真的存在；
 * 3. 各文档里声明的测试总数必须**彼此一致**（不校验真实值，那要跑测试）。
 *
 * 不检查的：文字是否准确、结论是否成立、数字是否符合真实测试数 ——
 * 那些要么需要人判断，要么需要跑一遍测试，不适合放进门禁。
 *
 * 用法：node scripts/check-docs.mjs
 */

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 这个路径是不是**被 git 忽略的**（构建产物 / 下载的资产 / 临时目录）。
 *
 * 为什么必须区分：文档里会提到 `apps/web/dist`、`apps/web/public/models/`、
 * 临时导出目录这些**由某个步骤生成、仓库刻意不跟踪**的路径。要求它们此刻存在，
 * 等于要求"先跑一遍全部步骤，再来跑这个检查" —— 而 `check:docs` 恰好排在
 * `pnpm verify` 的**中段**（构建之前）。
 *
 * 实测的后果：**一份全新的 git clone 上 `pnpm verify` 永远过不了**
 * （`dist` 还没构建、模型还没下载、临时目录还没生成），而清单里"阶段 1
 * 一把梭验收"正是让用户在一份新克隆上跑它。
 *
 * 判据用 git 自己的话：**仓库不跟踪的东西，文档不欠它存在性**。
 * 仓库内必须存在的路径（源码、文档、配置）照旧逐个查。
 */
function isIgnoredByGit(p) {
  try {
    execFileSync("git", ["check-ignore", "-q", p], { cwd: repoRoot, stdio: "ignore" });
    return true; // 退出码 0 = 被忽略
  } catch {
    // 退出码 1 = 没被忽略；git 不可用等其它情况也走这里 ——
    // 宁可多报（要求它存在），不要静默放宽。
    return false;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/** 要检查的文档。README 与 docs/ 下的都算。 */
const DOCS = [
  "README.md",
  "HANDOFF.md",
  "AGENTS.md",
  "docs/roadmap.md",
  "docs/spec.md",
  "docs/acceptance.md",
  "docs/data-contracts.md",
  "docs/decisions.md",
  "docs/evaluation-log.md",
  "docs/known-failures.md",
  "docs/local-verification.md",
];

/**
 * 明显是伪造/示例的路径，跳过存在性检查。
 *
 * 第一版**没有**这些豁免，于是三条报错全是误报 —— 最讽刺的一条是
 * `scripts/setup.sh` 出现在一句"仓库里**没有** `scripts/setup.sh`"的说明里。
 * 检查器必须能分清"断言存在"与"提到它不存在 / 只是举例"。
 */
const PATH_EXEMPT = [
  /^<.+>/, // 占位符
  /\.\.\.$/,
  /^pingpong-coach\.zip$/,
];

/** 行内出现这些词，说明是在**否定**或**举例**，不是断言存在。 */
const NON_ASSERTION = /没有|不存在|从未|尚未|不是|例如|建议|将来|若|如果|预期|应是|placeholder/i;

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));

  const problems = [];
  /** 有多少条路径因为"仓库刻意不跟踪"而跳过存在性检查（末尾要报出来） */
  let ignoredSkipped = 0;
  /** doc -> 该文档里出现的"合计 N 项测试"数字，用于跨文档一致性 */
  const totalClaims = new Map();

  for (const rel of DOCS) {
    const abs = resolve(repoRoot, rel);
    if (!(await exists(abs))) continue;
    const text = await readFile(abs, "utf8");

    // ── 1. `pnpm <script>` 必须存在 ──
    //
    // **必须同时认两种写法**：行内反引号 `` `pnpm foo` ``，以及代码块里的裸文本
    // `pnpm foo`。第一版只认前者，于是漏掉了 README 命令块里的
    // `pnpm preflight`（那正是当初真实的缺陷形状）。
    //
    // 两个收紧条件，都是被误报逼出来的：
    // - **只认行首**的 pnpm（项目脚本都写在行首）。否则 `pnpm store path` 这种
    //   pnpm 自身的子命令会被当成项目脚本（实测误报了 6 次）；
    // - 散文里的"例如用 `pnpm deploy`"靠 NON_ASSERTION 排除。
    for (const m of text.matchAll(/^[ \t>*+-]*`?pnpm ([a-z][\w:-]*)/gm)) {
      const name = m[1];
      if (
        [
          "exec",
          "install",
          "add",
          "remove",
          "run",
          "dlx",
          "why",
          "outdated",
          "deploy",
          "config",
          "publish",
          "pack",
          "version",
          "store",
          // "pnpm workspace" 在文档里是**技术栈名词**（"pnpm workspace + React…"），
          // 不是命令 —— 实测误报过一次。
          "workspace",
        ].includes(name)
      ) {
        continue;
      }
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const lineEnd = text.indexOf("\n", m.index);
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (NON_ASSERTION.test(line)) continue;
      if (!scripts.has(name)) {
        problems.push(`${rel}: 提到 \`pnpm ${name}\`，但 package.json 里没有这个 script`);
      }
    }

    // ── 2. 文档里引用的仓库内路径必须存在 ──
    // 同样**含代码块**（示例路径若指向不存在的东西，读的人照样会去查）。
    // 靠占位符豁免与"否定/举例"语境过滤误报。
    const topLevel = [
      "docs/",
      "packages/",
      "apps/",
      "scripts/",
      "configs/",
      "knowledge/",
      "models/",
      "evaluation/",
    ];
    for (const m of text.matchAll(/`([A-Za-z0-9_./-]+)`/g)) {
      const p = m[1];
      if (!topLevel.some((t) => p.startsWith(t))) continue;
      if (PATH_EXEMPT.some((re) => re.test(p))) continue;
      if (p.includes("*")) continue; // 通配，不查
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const lineEnd = text.indexOf("\n", m.index);
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (NON_ASSERTION.test(line)) continue;
      // 被忽略的路径（构建产物 / 下载的资产 / 临时目录）不查存在性 —— 见 isIgnoredByGit
      if (isIgnoredByGit(p)) {
        ignoredSkipped++;
        continue;
      }
      if (!(await exists(resolve(repoRoot, p)))) {
        problems.push(`${rel}: 引用了 \`${p}\`，但该路径不存在`);
      }
    }

    // ── 3. 记录该文档声明的测试总数 ──
    for (const m of text.matchAll(/共\s*\*{0,2}(\d{3})\s*项测试\*{0,2}/g)) {
      const n = Number(m[1]);
      if (!totalClaims.has(n)) totalClaims.set(n, []);
      totalClaims.get(n).push(rel);
    }
    for (const m of text.matchAll(/^合计\s+(\d{3})$/gm)) {
      const n = Number(m[1]);
      if (!totalClaims.has(n)) totalClaims.set(n, []);
      totalClaims.get(n).push(rel);
    }
  }

  // 跨文档一致性：同一份仓库里不该出现两个不同的"总计"
  if (totalClaims.size > 1) {
    const detail = [...totalClaims.entries()]
      .map(([n, docs]) => `    ${n} ← ${[...new Set(docs)].join(", ")}`)
      .join("\n");
    problems.push(`各文档声明的测试总数不一致：\n${detail}`);
  }

  if (problems.length > 0) {
    console.error("✗ 文档与仓库实际不符：\n");
    for (const p of problems) console.error(`  ${p}`);
    console.error("\n  这类漂移手工同步一定会漏 —— 改完代码顺手跑一次 `pnpm check:docs`。");
    process.exit(1);
  }

  const totalNote =
    totalClaims.size === 1
      ? `（各文档一致声明 ${[...totalClaims.keys()][0]} 项）`
      : "（文档未声明总数）";
  console.log(
    `✓ 文档一致性通过：命令、路径、测试总数声明都对得上 ${totalNote}` +
      (ignoredSkipped > 0
        ? `（另有 ${ignoredSkipped} 条路径因为**仓库刻意不跟踪**而跳过存在性检查 —— ` +
          `构建产物、下载的资产、临时目录；它们只有在跑过对应步骤之后才存在）`
        : ""),
  );
}

main().catch((err) => {
  console.error(`check-docs 失败：${err.message}`);
  process.exit(1);
});
