/**
 * 仓库自带门禁的**自身**回归。
 *
 * 门禁坏掉是最难发现的一类问题：它照样打印"通过"，只是**扫的东西变少了**。
 * 这与"没有门禁"在结果上完全一样，而看起来更让人放心。这里钉住两条已经出过事的：
 *
 * 1. **接线审计的递归**（F-023）：脚本曾经只扫一层目录，而 `apps/web/src` 与
 *    `apps/api/src` 下面**全是子目录** —— 于是那两个包**一个文件都没扫到**，
 *    却一直打印"通过"。脚本注释与文档都写着"扫全部四个包"。
 * 2. **e2e 隔离 `.env`**（F-041）：浏览器端到端会自己起一个 API 进程，
 *    不隔离的话它会读到你的 `.env`、**跑成 live 并真的花钱**。
 *    这条由 `playwright.config.ts` 里的 `PPC_NO_ENV_FILE=1` 保证 ——
 *    而它一旦被删掉，没有任何测试会红，只会开始扣费。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

describe("接线审计脚本自身（F-023）", () => {
  it("扫到的导出数量不能塌下来 —— 递归坏掉时它会照样打印「通过」", () => {
    const out = execFileSync("node", [resolve(repoRoot, "scripts/audit-wiring.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const m = /扫了\s*(\d+)\s*个运行时导出/.exec(out);
    expect(m, `审计脚本的输出格式变了，这条守卫失效了：\n${out}`).not.toBeNull();
    const scanned = Number(m![1]);
    /*
     * 下限 **140**，是量出来的，不是拍的：
     *   - 正常（四个包递归）：**158**
     *   - 退回 F-023 的坏法（只扫一层，`apps/web/src`/`apps/api/src` 整体消失）：**103**
     *
     * ⚠️ 第一版把下限写成 100 —— 于是**坏的那一版照样通过**，守卫等于没有
     * （我把它改回坏法实测过）。所以这里取两者之间、且离两边都留出余量：
     * 正常增删导出不会误报，而少扫一个包（约 55 个导出）必然越界。
     */
    expect(
      scanned,
      `接线审计只扫到 ${scanned} 个导出（正常 158，只扫一层会掉到 103）—— ` +
        `递归是不是又坏了（F-023）？`,
    ).toBeGreaterThanOrEqual(140);
  });
});

describe("e2e 必须隔离 .env（F-041）", () => {
  it("两个 API webServer 的启动命令都带 PPC_NO_ENV_FILE=1", () => {
    // 读配置文本而不是 import：这个文件里有 playwright 的类型与路径探测，
    // 在 vitest 里 import 它会连带执行，且断言的东西本来就是"这几行字还在不在"。
    const config = readFileSync(resolve(here, "../../web/playwright.config.ts"), "utf8");
    const envLines = config.split("\n").filter((l) => l.includes("PPC_NO_ENV_FILE"));
    expect(
      envLines.length,
      `playwright.config.ts 里只找到 ${envLines.length} 处 PPC_NO_ENV_FILE —— 两个起 API 的` +
        `地方都要设（少一处就等于不隔离），否则 e2e 会读到 .env、**跑成 live 并真的花钱**（F-041）。`,
    ).toBeGreaterThanOrEqual(2);
    for (const line of envLines) {
      expect(line, `这一行没有设成 1：${line}`).toMatch(/PPC_NO_ENV_FILE:\s*"1"/);
    }
  });
});
