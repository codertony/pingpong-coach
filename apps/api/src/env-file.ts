/**
 * `.env` 加载（仓库自己实现，不引依赖）。
 *
 * ## 为什么要有它
 *
 * 之前**根本没有** `.env` 加载器，而文档却让用户建 `.env` —— 于是"照做"与
 * "生效"之间是断的，用户会静默跑成 mock（见 `docs/known-failures.md` F-039）。
 * 用户明确要求密钥走 `.env` 传入，所以这里把它实现出来。
 *
 * ## 为什么不用 Node 自带的 `--env-file`
 *
 * 那个开关要用命令行参数传，而本包的启动方式是 `tsx src/server.ts` ——
 * 参数得靠脚本拼、且各平台行为不一致。自己实现一个二十行的解析器
 * **可以单测**（`apps/api/test/env-file.test.ts`），行为与启动方式无关。
 *
 * ## 三条硬约定
 *
 * 1. **不覆盖已有的环境变量** —— 命令行上显式给的 `MODEL_API_KEY=... pnpm start`
 *    永远优先于文件。否则"临时换个 key 试一下"会静默失效。
 * 2. **只在服务端入口调用**，不在 `loadConfig()` 里调用 —— 否则测试会被
 *    开发者本机的 `.env` 污染（一个真实 `.env` 会让 config 测试全红）。
 * 3. **绝不打印值**（红线 11）。返回值只含**变量名**。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface EnvFileResult {
  /** 实际加载的文件（绝对路径）；没有可用文件时为 null */
  path: string | null;
  /** 被应用进去的**变量名**（不含值） */
  appliedNames: string[];
}

/**
 * 解析 `.env` 文本。
 *
 * 支持的形态：`KEY=value`、`export KEY=value`、`#` 注释、空行、
 * 值两侧的单/双引号。**不支持**多行值与变量插值 —— 需要那些的话，
 * 宁可让人用真正的 shell 环境变量，也不要一个半吊子解析器悄悄给错值。
 */
export function parseEnvFile(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue; // 没有 = ，或 = 在开头（键名空）

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // 键名不合法就跳过，不猜

    let value = withoutExport.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);

    out.push([key, value]);
  }
  return out;
}

/**
 * 按顺序找第一个存在的文件并应用。
 *
 * @param candidates 候选路径（相对 `cwd` 解析）
 * @param env 目标环境对象；默认 `process.env`（测试可注入）
 * @param exists 存在性判断；默认 `fs.existsSync`（测试可注入）
 */
export function applyEnvFile(
  candidates: readonly string[],
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
): EnvFileResult {
  const found = candidates.map((p) => resolve(p)).find((p) => exists(p));
  if (found == null) return { path: null, appliedNames: [] };

  let text: string;
  try {
    text = readFileSync(found, "utf8");
  } catch {
    // 读不了就当作没有 —— 但**不要**因此静默改变行为：调用方会看到 path=null
    return { path: null, appliedNames: [] };
  }

  const appliedNames: string[] = [];
  for (const [key, value] of parseEnvFile(text)) {
    // 已有值优先：命令行/系统环境变量 > .env
    if (env[key] != null && env[key] !== "") continue;
    env[key] = value;
    appliedNames.push(key);
  }
  return { path: found, appliedNames };
}

/**
 * 服务端默认查找顺序。
 *
 * 两个位置都查，因为启动目录随调用方式而变：`pnpm --filter` 的 cwd 是
 * `apps/api`（所以仓库根的 `.env` 是 `../../.env`），而从仓库根直接跑时
 * 就落在 `./.env`。可用 `PPC_ENV_FILE` 显式指定，指定了就只用它。
 */
export function defaultEnvCandidates(cwd: string = process.cwd()): string[] {
  const explicit = process.env.PPC_ENV_FILE;
  if (explicit != null && explicit.trim() !== "") return [explicit];
  return [resolve(cwd, ".env"), resolve(cwd, "../../.env")];
}
