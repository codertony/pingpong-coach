/**
 * 仓库自带门禁的**自身**回归。
 *
 * 门禁坏掉是最难发现的一类问题：它照样打印"通过"，只是**扫的东西变少了**。
 * 这与"没有门禁"在结果上完全一样，而看起来更让人放心。下面每条都写明它挡的是哪一种静默失败：
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

describe("CI 的 e2e 必须自带模型资产", () => {
  it("e2e job 里下载权重，且在构建之前 —— 否则那 6 条整页链路用例一直 skip", () => {
    /*
     * 6 条用例（`app.e2e.ts` 4 条 + `camera-fault.e2e.ts` 2 条）需要真实模型资产，
     * 缺资产时**整组 skip**（这是对的：不伪装成通过）。但"skip"与"通过"在 CI 上
     * 长得一模一样 —— 于是这两类只在这条路径上才暴露的缺陷
     * （F-007 模块 Worker 里能否真正加载 WASM/权重、F-008 采集流有没有接到界面上那个 video）
     * 在 CI 上长期无人守，而 CI 一直是绿的。
     *
     * 顺序也是断言的一部分：`public/models` 要先有，`pnpm build` 才会把它复制进 dist
     * （集成测试起第二个 API 实例托管 dist），也才会被 dev server 提供。
     */
    const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const start = ci.indexOf("\n  e2e:");
    const end = ci.indexOf("\n  docker:");
    expect(start, "找不到 e2e job").toBeGreaterThan(-1);
    expect(end, "找不到 docker job（用于界定 e2e job 的边界）").toBeGreaterThan(start);

    const e2eSteps = [...ci.slice(start, end).matchAll(/run:\s*pnpm\s+([^\s&|]+)/g)].map(
      (m) => m[1]!,
    );
    expect(
      e2eSteps,
      "CI 的 e2e job 没有 `pnpm models:fetch` —— 那 6 条整页链路用例会在 CI 上静默 skip",
    ).toContain("models:fetch");
    expect(
      e2eSteps.indexOf("models:fetch"),
      "`pnpm models:fetch` 必须在 `pnpm build` 之前：否则 dist 里没有模型权重",
    ).toBeLessThan(e2eSteps.indexOf("build"));
  });
});

describe("生产镜像的内容（镜像不进 verify，只能在这里钉）", () => {
  /*
   * F-065 就是这么发生的：`.dockerignore` 排除了 `apps/web/public/wasm`（并注明
   * "wasm 来自 node_modules，装依赖时就有"），而构建里**没有任何一步**把它复制过去 ——
   * `vite build` 对空的 public 目录不报错，于是镜像能构建成功、健康检查也过，
   * 只是骨架永远出不来。而这条链路**本机无法验证**（没有 docker，见 A7），
   * 所以它能悄悄回来：改一行 `.dockerignore` 或删掉铺文件那一步，没有任何东西会红。
   *
   * 这里钉住的是一条**不变量**，不是某几行字：
   * **凡是被 `.dockerignore` 挡在构建上下文之外的东西，构建里都必须有一步把它产出来。**
   * 挡在门外 + 没人产出 = 镜像缺件，而这是**静默**的。
   */
  const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");
  const dockerignore = readFileSync(resolve(repoRoot, ".dockerignore"), "utf8");
  const viteConfig = readFileSync(resolve(repoRoot, "apps/web/vite.config.ts"), "utf8");

  it("被排除的 public 资产，构建里都有一步把它产出来", () => {
    const excluded = (p: string) => new RegExp(`^${p}\\s*$`, "m").test(dockerignore);

    if (excluded("apps/web/public/models")) {
      expect(
        dockerfile,
        "`.dockerignore` 排除了 `apps/web/public/models`，而 Dockerfile 里没有一步" +
          "`pnpm models:fetch` —— 镜像里会没有模型权重，而构建照样成功",
      ).toContain("pnpm models:fetch");
    }
    if (excluded("apps/web/public/wasm")) {
      // ⚠️ 断言的是"**接上了**"，不是"文件里出现过这几个字"。
      // 第一版写成 `toContain("stageMediapipeWasm")` —— 于是把插件从 `plugins` 数组里
      // 拿掉、只留函数定义，它照样绿（我实测过）。这正是 F-065 的形态：
      // 代码写着、但**没有一步真的会跑它**。
      const pluginsArray = /plugins:\s*\[([^\]]*)\]/.exec(viteConfig)?.[1] ?? "";
      expect(
        pluginsArray,
        "`.dockerignore` 排除了 `apps/web/public/wasm`，而 `plugins` 数组里没有" +
          "`stageMediapipeWasm()`（定义了却没接上，等于没有）—— " +
          "镜像里会没有 WASM 运行时（F-065：界面正常、就是没有骨架）",
      ).toContain("stageMediapipeWasm()");
    }
  });

  it("资产必须赶在构建之前产出，dist 才带得上", () => {
    // 只在 `RUN` 行里找：Dockerfile 的**注释**里也写着 `pnpm build`（第 58 行那句说明），
    // 用 indexOf 找子串会被注释满足 —— 那样"构建提到下载之前"也照样绿。
    const runLineIndex = (needle: string): number => {
      const m = new RegExp(`^RUN .*${needle}.*$`, "m").exec(dockerfile);
      return m ? m.index : -1;
    };
    const iFetch = runLineIndex("models:fetch");
    const iBuild = runLineIndex("pnpm build");
    expect(iFetch, "Dockerfile 里没有 `RUN ... models:fetch`").toBeGreaterThan(-1);
    expect(iBuild, "Dockerfile 里没有 `RUN pnpm build`").toBeGreaterThan(-1);
    expect(
      iBuild,
      "`pnpm build` 在 `pnpm models:fetch` 之前 —— 那时 public/models 还是空的，" +
        "vite 会把一个没有权重的 dist 打进镜像",
    ).toBeGreaterThan(iFetch);
  });

  it("运行阶段带着 dist、knowledge 与 tsx 入口", () => {
    // API 自己托管 dist（含 WASM 与权重）；缺 knowledge 时 analyze 会直接失败；
    // tsx 的路径必须是 apps/api 下的（装在声明它的那个包里）—— 三处都踩过。
    expect(dockerfile, "运行阶段没复制 dist 或 knowledge").toMatch(
      /COPY --from=builder \/app\/apps\/web\/dist\s+\.\/apps\/web\/dist/,
    );
    expect(dockerfile).toMatch(/COPY --from=builder \/app\/knowledge\s+\.\/knowledge/);
    expect(dockerfile).toMatch(/apps\/api\/node_modules\/tsx/);
  });
});

describe("文档一致性的编号区间检查（F-030 那一类里唯一机械可查的子类）", () => {
  it("真的校验到了区间，而不是「检查通过、其实一处都没看」", () => {
    /*
     * 踩过的坑：台账已经到 F-066，而 README 两处还写着「F-001 ~ F-042」，
     * **没有任何门禁会红** —— F-030 记过「叙述性漂移 check:docs 结构上查不到」。
     * 现在 `check-docs` 会校验编号区间是否落后于台账。但这类检查有个共通的自毁方式：
     * 区间写法一变（或不再写死数字），它就**一处都匹配不到**，然后照样打印「通过」。
     * 所以这里钉住它**实际校验过的数量** —— 与 `audit:wiring` 的数量下限同一个套路。
     */
    const out = execFileSync("node", [resolve(repoRoot, "scripts/check-docs.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const m = /另校验了\s*(\d+)\s*处 F-0NN 编号区间/.exec(out);
    expect(m, `check-docs 的输出格式变了，这条守卫失效了：\n${out}`).not.toBeNull();
    expect(
      Number(m![1]),
      "一处编号区间都没校验到 —— 要么区间写法变了，要么这条检查已经空转",
    ).toBeGreaterThanOrEqual(1);
  });
});
