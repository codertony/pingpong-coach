#!/usr/bin/env node
/**
 * 密钥守卫：**不让 API key 有机会进仓库**。
 *
 * 由来：用户明确要求「大模型的 key 不要提交到仓库，要通过 .env 传入」。
 * `.gitignore` 只管住 `.env` 这个**文件名** —— 它挡不住
 * "顺手把 key 贴进某个 .ts / .md / .json 里" 这种情况，
 * 而那正是最容易发生的形态（调试时贴一下、忘了删）。
 *
 * 做两件事：
 *   1. 扫**已被 git 跟踪的文件**（`git ls-files`）里有没有像密钥的串；
 *   2. 确认 `.env` 仍然被 `.gitignore` 忽略（规则被谁删掉时要能发现）。
 *
 * ⚠️ **命中时绝不打印命中内容** —— 打印密钥就等于把它写进 CI 日志，
 * 那是同一个泄漏换了个地方发生。只报**文件名、行号、以及脱敏后的前几位**。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/** 形如 `sk-` 后跟一长串字母数字的串。够长才算，避免误伤 `sk-x` 这类测试值。 */
const KEY_PATTERNS = [
  { name: "OpenAI/DeepSeek 风格", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "Anthropic 风格", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
];

/** 超过这个大小就不读（密钥不会藏在 1MB 的二进制里，避免拖慢门禁）。 */
const MAX_BYTES = 1024 * 1024;

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return out.split("\0").filter((s) => s !== "");
}

/** 只保留前 6 位，其余打码。 */
function mask(match) {
  return `${match.slice(0, 6)}…（共 ${match.length} 位，已打码）`;
}

const findings = [];

for (const file of trackedFiles()) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    continue; // 已被删除但还在索引里之类的情况，跳过
  }
  if (size > MAX_BYTES) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // 二进制读不成 utf8 就跳过
  }
  if (text.includes("\u0000")) continue; // 含 NUL ⇒ 二进制

  const lines = text.split(/\r?\n/);
  for (const { name, re } of KEY_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (m) findings.push({ file, line: i + 1, kind: name, masked: mask(m[0]) });
    }
  }
}

// `.env` 必须仍然被忽略 —— 这条规则被人删掉时要能发现
let envIgnored = true;
try {
  execFileSync("git", ["check-ignore", "-q", ".env"], { stdio: "ignore" });
} catch {
  envIgnored = false;
}

if (findings.length > 0) {
  console.error("✗ 疑似 API 密钥出现在**被跟踪的文件**里：\n");
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.kind}  ${f.masked}`);
  }
  console.error(
    "\n  密钥只能走 .env（已被 .gitignore 忽略）或环境变量。\n" +
      "  请把密钥移出文件，并**轮换它** —— 一旦进了 git 历史就当作已泄漏。\n" +
      "  （本脚本刻意不打印命中内容，避免把它再写进 CI 日志。）",
  );
  process.exit(1);
}

if (!envIgnored) {
  console.error("✗ `.env` 不再被 .gitignore 忽略 —— 密钥会被提交。请恢复该规则。");
  process.exit(1);
}

console.log("✓ 密钥守卫通过：被跟踪的文件里没有疑似密钥，且 .env 仍被忽略。");
