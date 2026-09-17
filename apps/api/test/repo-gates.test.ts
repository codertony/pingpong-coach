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

describe("dev server 必须绑 127.0.0.1（F-009 的附带修复）", () => {
  it("vite 的 server.host 显式设成 127.0.0.1（不是 vite 的 localhost 默认值）", () => {
    /*
     * vite 默认绑 `localhost`，Windows 上解析成 IPv6 的 `::1` ——
     * 实测表现是 `http://localhost:5173` 通、`http://127.0.0.1:5173` **连不上**。
     * 而 README 与其它文档写的都是 `127.0.0.1`，用户照着敲会打不开，现象是连接被拒，
     * 很容易被误判成"服务没起来"（F-009 记了完整排查）。
     *
     * 这类"配置行被删掉"的回归没有任何测试会红 —— 所以在这里钉住那一行。
     */
    const config = readFileSync(resolve(here, "../../web/vite.config.ts"), "utf8");
    expect(
      config,
      "vite.config.ts 里的 server.host 不见了 —— 默认会绑 ::1，" +
        "而文档让用户开 127.0.0.1（F-009）",
    ).toMatch(/host:\s*process\.env\.HOST\s*\?\?\s*"127\.0\.0\.1"/);
  });
});

describe("标注字段名不许与加载器脱节（samples.json ↔ eval:replay）", () => {
  it("清单里每板用的名字必须是加载器**真的在读**的那些", () => {
    /*
     * 踩过的坑：`samples.json` 的 `annotationSchema` 原先写着
     * `strokeStartMs` / `strokeEndMs`，而 `scripts/eval-replay.ts` 读的是
     * `startMs` / `endMs` —— 照着文档标的人，标出来的东西会被**当成缺字段丢掉**，
     * 指标那边只表现为"缺人工标注"，看不出是自己的字段名写错了。
     * 代价落在**人的标注时间**上，所以值得钉住。
     *
     * 断言**结构**（键名）而不是扫文本：这段散文里会正当地提到错误名字
     * （"写成 strokeStartMs 会被丢掉"），扫文本会把它当成违规。
     */
    const manifest = JSON.parse(
      readFileSync(resolve(repoRoot, "evaluation/samples.json"), "utf8"),
    ) as { samples?: Array<{ annotation?: { strokes?: Array<Record<string, unknown>> } }> };
    const script = readFileSync(resolve(repoRoot, "scripts/eval-replay.ts"), "utf8");

    // 加载器读的就是这两个名字
    expect(script).toMatch(/s\?\.startMs\s*===\s*"number"/);
    expect(script).toMatch(/s\?\.endMs\s*===\s*"number"/);

    // 清单模板里每板的键名必须与之一致（`$comment` 这类说明键不算）
    const strokes = (manifest.samples ?? []).flatMap((s) => s.annotation?.strokes ?? []);
    expect(strokes.length, "samples.json 里连一个模板条目都没有了").toBeGreaterThan(0);
    for (const st of strokes) {
      const keys = Object.keys(st).filter((k) => !k.startsWith("$"));
      expect(
        keys.sort(),
        `标注模板里的键是 ${JSON.stringify(keys)}，而加载器读的是 startMs/endMs`,
      ).toEqual(["endMs", "startMs"]);
    }
  });
});

describe("CI 必须逐条覆盖本地 pnpm verify（顺序也一样）", () => {
  it("本地 verify 的每一步，CI 的 verify job 里都有，且顺序一致", () => {
    /*
     * 踩过的坑：CI 的 verify job 标题写着"与本地 `pnpm verify` **逐条对齐**"，
     * 而它**漏了两步** —— `typecheck:scripts`（F-034：scripts/ 从来没被类型检查过）
     * 和 `check:secrets`（密钥守卫）。后者尤其要命：README 写着"pnpm verify 里有一道
     * check:secrets 守卫"，于是所有人以为 CI 上也在守，实际上**只在本地守** ——
     * 别人提上来的 PR 里，那道守卫从来没运行过。
     *
     * 这类"两个地方各写一份清单"的漂移，靠人同步一定会漏（本仓库已经栽过好几次），
     * 所以这里让它**机械对齐**：以 package.json 的 verify 链为唯一来源，逐个查 CI。
     */
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const verifyChain = (pkg.scripts?.verify ?? "")
      .split("&&")
      .map((seg) => /pnpm\s+([^\s&]+)/.exec(seg.trim())?.[1])
      .filter((x): x is string => x != null);
    expect(verifyChain.length, "verify 链解析出来太短，守卫会形同虚设").toBeGreaterThan(5);

    const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const start = ci.indexOf("\n  verify:");
    const end = ci.indexOf("\n  e2e:");
    expect(start, "找不到 verify job").toBeGreaterThan(-1);
    expect(end, "找不到 e2e job（用于界定 verify job 的边界）").toBeGreaterThan(start);
    const ciSteps = [...ci.slice(start, end).matchAll(/run:\s*pnpm\s+([^\s&|]+)/g)].map(
      (m) => m[1]!,
    );

    for (const step of verifyChain) {
      expect(
        ciSteps,
        `CI 的 verify job 里没有 \`pnpm ${step}\` —— 本地跑得到、CI 里没人守`,
      ).toContain(step);
    }
    const positions = verifyChain.map((s2) => ciSteps.indexOf(s2));
    expect(
      positions,
      `CI 里的门禁顺序与本地 verify 不一致：本地 ${JSON.stringify(verifyChain)}，CI ${JSON.stringify(ciSteps)}`,
    ).toEqual([...positions].sort((a, b) => a - b));
  });
});
