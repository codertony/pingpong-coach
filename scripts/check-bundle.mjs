#!/usr/bin/env node
/**
 * 依赖体积预算：对 apps/web 生产产物算 gzip 体积，超预算即失败。
 *
 * 纪律（roadmap A6）：设一个 gzip 上限，超过则门禁失败，
 * 拦住「意外把大依赖打进主包 / 误打包模型资产」这类灾难性回归。
 *
 * 只统计被打包进 bundle 的 JS / CSS / HTML（dist/assets + dist/index.html），
 * 不含 dist/models、dist/wasm —— 那是运行时静态资产，不属于依赖体积预算。
 *
 * 用法：
 *   pnpm check:bundle                       # 用默认预算（见 BUDGET_BYTES）
 *   PPC_BUNDLE_BUDGET_BYTES=160000 pnpm check:bundle   # 覆盖预算
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const distRoot = resolve(repoRoot, "apps/web/dist");

// 预算 = gzip 后的 JS+CSS+HTML 总字节。当前基线约 123 kB，给约 30% 余量。
const BUDGET_BYTES = Number(process.env.PPC_BUNDLE_BUDGET_BYTES ?? 160 * 1024);

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(full)));
    } else if (entry.isFile() && /\.(js|css|html)$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const distExists = await stat(distRoot).catch(() => null);
  if (!distExists) {
    console.error(`✗ 未找到 ${relative(repoRoot, distRoot)}。请先运行 pnpm build。`);
    process.exit(1);
  }

  const assetsDir = join(distRoot, "assets");
  const indexHtml = join(distRoot, "index.html");

  const candidates = [indexHtml, ...(await collect(assetsDir).catch(() => []))];

  const rows = [];
  for (const file of candidates) {
    const exists = await stat(file).catch(() => null);
    if (!exists) continue;
    const raw = exists.size;
    const gz = gzipSync(await readFile(file)).length;
    rows.push({ file: relative(repoRoot, file), raw, gz });
  }

  rows.sort((a, b) => b.gz - a.gz);

  const totalGz = rows.reduce((sum, r) => sum + r.gz, 0);
  const totalRaw = rows.reduce((sum, r) => sum + r.raw, 0);

  for (const r of rows) {
    console.log(
      `  ${r.file.padEnd(48)} ${(r.raw / 1024).toFixed(1).padStart(8)} KiB   gzip ${(r.gz / 1024).toFixed(1).padStart(8)} KiB`,
    );
  }
  console.log(
    `\n合计 gzip ${(totalGz / 1024).toFixed(1)} KiB（原始 ${(totalRaw / 1024).toFixed(1)} KiB），预算 ${(BUDGET_BYTES / 1024).toFixed(1)} KiB`,
  );

  if (totalGz > BUDGET_BYTES) {
    console.error(
      `✗ 超出依赖体积预算：gzip ${(totalGz / 1024).toFixed(1)} KiB > ${(BUDGET_BYTES / 1024).toFixed(1)} KiB。\n` +
        `  不要悄悄调大预算：先查明是什么依赖把包撑大的，再决定是否值得。`,
    );
    process.exit(1);
  }

  console.log("✓ 依赖体积在预算内。");
}

main().catch((err) => {
  console.error(`check:bundle 失败：${err.message}`);
  process.exit(1);
});
