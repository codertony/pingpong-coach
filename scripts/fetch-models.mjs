#!/usr/bin/env node
/**
 * 下载并校验声明的模型资产。
 *
 * 纪律（方案第 6 节）：
 * - 记录模型 ID、来源、下载 URL、SHA-256、文件大小、SDK 版本与许可来源。
 * - 若下载或校验失败，**明确报错**，不静默换用另一版模型。
 *
 * 用法：
 *   pnpm models:fetch                # 下载缺失的资产
 *   pnpm models:fetch -- --write-hash  # 下载后把 sha256 与大小写回 manifest
 *   pnpm models:fetch -- --verify      # 仅校验已存在文件，不下载
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const manifestPath = resolve(repoRoot, "models/manifest.json");

const args = new Set(process.argv.slice(2));
const writeHash = args.has("--write-hash");
const verifyOnly = args.has("--verify");

async function sha256Of(path) {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return buf.length;
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  let failed = 0;
  let downloaded = 0;
  let verified = 0;
  let skipped = 0;

  for (const asset of manifest.assets ?? []) {
    for (const file of asset.files ?? []) {
      const abs = resolve(repoRoot, file.path);
      const present = await exists(abs);

      if (!present) {
        if (verifyOnly) {
          console.error(`✗ 缺失：${file.path}`);
          failed++;
          continue;
        }
        if (!file.url) {
          console.error(`✗ ${file.path} 不存在且 manifest 未提供 URL`);
          failed++;
          continue;
        }
        process.stdout.write(`↓ 下载 ${asset.modelId} → ${file.path} ... `);
        try {
          const bytes = await download(file.url, abs);
          console.log(`${(bytes / 1024 / 1024).toFixed(1)} MiB`);
          downloaded++;
        } catch (err) {
          console.log("失败");
          console.error(`  ${err.message}`);
          failed++;
          continue;
        }
      } else {
        skipped++;
      }

      const actualSize = await fileSize(abs);
      const actualHash = await sha256Of(abs);

      if (file.sha256 && file.sha256 !== actualHash) {
        console.error(
          `✗ 校验失败：${file.path}\n  期望 ${file.sha256}\n  实际 ${actualHash}\n` +
            `  这个文件可能损坏或被替换。请删除后重新下载，不要直接继续。`,
        );
        failed++;
        continue;
      }

      if (!file.sha256) {
        if (writeHash) {
          file.sha256 = actualHash;
          file.bytes = actualSize;
        } else {
          console.warn(
            `! ${file.path} 尚无 sha256 记录。用 --write-hash 写入，或手工核对后填入 manifest。`,
          );
        }
      } else {
        verified++;
      }

      console.log(
        `  ✓ ${file.path}  ${(actualSize / 1024 / 1024).toFixed(1)} MiB  sha256=${actualHash.slice(0, 16)}…`,
      );
    }
  }

  if (writeHash) {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(`\n已把实际 sha256 与大小写回 ${"models/manifest.json"}。`);
  }

  console.log(
    `\n完成：下载 ${downloaded}，已存在 ${skipped}，校验通过 ${verified}，失败 ${failed}`,
  );

  if (failed > 0) {
    console.error(
      "\n存在未通过的资产。请解决后再开始训练 —— 不要用未校验的模型文件产出评估结论。",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`models:fetch 失败：${err.message}`);
  process.exit(1);
});
