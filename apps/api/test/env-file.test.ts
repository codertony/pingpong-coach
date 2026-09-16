/**
 * `.env` 加载的测试（F-039 的修法）。
 *
 * 三条要钉住的：① 解析能吃常见写法；② **不覆盖已有环境变量**
 * （命令行显式给的必须赢，否则"临时换个 key"会静默失效）；
 * ③ 返回值里**只有变量名、没有值**（红线 11：密钥不得落进日志）。
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyEnvFile, defaultEnvCandidates, parseEnvFile } from "../src/env-file.js";

describe("parseEnvFile — 解析", () => {
  it("基本的 KEY=value，忽略空行与 # 注释", () => {
    const parsed = parseEnvFile(
      ["# 注释", "", "MODEL_ID=deepseek-flash", "   ", "PORT=8787"].join("\n"),
    );
    expect(parsed).toEqual([
      ["MODEL_ID", "deepseek-flash"],
      ["PORT", "8787"],
    ]);
  });

  it("支持 export 前缀与两侧引号", () => {
    const parsed = parseEnvFile(
      ['export MODEL_API_KEY="sk-quoted"', "MODEL_ID='single'", "PLAIN=bare"].join("\n"),
    );
    expect(parsed).toEqual([
      ["MODEL_API_KEY", "sk-quoted"],
      ["MODEL_ID", "single"],
      ["PLAIN", "bare"],
    ]);
  });

  it("值里可以含 =（只在第一个 = 处切分）", () => {
    expect(parseEnvFile("MODEL_BASE_URL=https://x/y?a=b")).toEqual([
      ["MODEL_BASE_URL", "https://x/y?a=b"],
    ]);
  });

  it("没有 = 、键名为空、键名不合法 —— 一律跳过而不是猜", () => {
    const parsed = parseEnvFile(["JUSTAWORD", "=novalue", "2BAD=x", "BAD-KEY=x"].join("\n"));
    expect(parsed).toEqual([]);
  });

  it("不管多行值与插值（不支持就不要假装支持）", () => {
    // 这两行会被当成"值里有 $ 的普通变量"和"另一个变量"，而不是插值 ——
    // 需要插值的人应该用真正的 shell 环境变量。
    const parsed = parseEnvFile(["A=$B", "B=1"].join("\n"));
    expect(parsed).toEqual([
      ["A", "$B"],
      ["B", "1"],
    ]);
  });
});

/** 造一个临时目录放假的 .env。 */
function withTempEnv(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ppc-env-"));
  try {
    const path = join(dir, ".env");
    writeFileSync(path, content, "utf8");
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("applyEnvFile — 应用", () => {
  it("把文件里的键写进环境，并返回**变量名**（不含值）", () => {
    withTempEnv("MODEL_ID=deepseek-flash\nPORT=9001\n", (path) => {
      const env: Record<string, string | undefined> = {};
      const result = applyEnvFile([path], env);

      expect(env.MODEL_ID).toBe("deepseek-flash");
      expect(env.PORT).toBe("9001");
      expect(result.path).toBe(path);
      expect(result.appliedNames.sort()).toEqual(["MODEL_ID", "PORT"]);
      // 红线 11：返回值里绝不能出现值
      expect(JSON.stringify(result)).not.toContain("deepseek-flash");
    });
  });

  it("**不覆盖**已有的环境变量（命令行 > .env）", () => {
    withTempEnv("MODEL_ID=from-file\nPORT=9001\n", (path) => {
      const env: Record<string, string | undefined> = { MODEL_ID: "from-command-line" };
      const result = applyEnvFile([path], env);

      expect(env.MODEL_ID, "命令行给的值被 .env 覆盖了 —— 临时换 key 会静默失效").toBe(
        "from-command-line",
      );
      // 没被覆盖的那个不算"应用过"
      expect(result.appliedNames).toEqual(["PORT"]);
    });
  });

  it("空字符串视为未设置，允许被 .env 填补", () => {
    withTempEnv("MODEL_ID=from-file\n", (path) => {
      const env: Record<string, string | undefined> = { MODEL_ID: "" };
      applyEnvFile([path], env);
      expect(env.MODEL_ID).toBe("from-file");
    });
  });

  it("文件不存在时是**无操作**，不抛异常（path=null 让调用方知道）", () => {
    const env: Record<string, string | undefined> = {};
    const result = applyEnvFile(["/definitely/not/here/.env"], env);
    expect(result.path).toBeNull();
    expect(result.appliedNames).toEqual([]);
    expect(env).toEqual({});
  });

  it("多个候选取**第一个存在**的（近处优先于仓库根）", () => {
    withTempEnv("MODEL_ID=near\n", (near) => {
      withTempEnv("MODEL_ID=far\n", (far) => {
        const env: Record<string, string | undefined> = {};
        applyEnvFile(["/nope/.env", near, far], env);
        expect(env.MODEL_ID).toBe("near");
      });
    });
  });
});

describe("defaultEnvCandidates — 查找顺序", () => {
  it("默认查 cwd/.env 与 cwd/../../.env（启动目录随调用方式而变）", () => {
    const prev = process.env.PPC_ENV_FILE;
    delete process.env.PPC_ENV_FILE;
    try {
      // 用 resolve 构造期望值，避免把 POSIX 路径写死（Windows 上会带盘符）
      const cwd = "/repo/apps/api";
      const list = defaultEnvCandidates(cwd);
      expect(list).toEqual([resolve(cwd, ".env"), resolve(cwd, "../../.env")]);
    } finally {
      if (prev != null) process.env.PPC_ENV_FILE = prev;
    }
  });

  it("PPC_ENV_FILE 指定后只用它", () => {
    const prev = process.env.PPC_ENV_FILE;
    process.env.PPC_ENV_FILE = "/custom/my.env";
    try {
      expect(defaultEnvCandidates("/repo/apps/api")).toEqual(["/custom/my.env"]);
    } finally {
      if (prev == null) delete process.env.PPC_ENV_FILE;
      else process.env.PPC_ENV_FILE = prev;
    }
  });

  /**
   * 测试必须能**彻底关掉** `.env` 加载。
   *
   * 不是为了洁癖：e2e 会自己起 API 进程，若它读到开发者本机的 `.env`，
   * ① 会跑成 live 而不是 mock（结果不再确定）；② **真的花钱**。
   * 实测踩到过 —— 加了 `.env` 之后 `pnpm test:e2e` 直接打到了真实模型上。
   */
  it("PPC_NO_ENV_FILE=1 时一个候选都不返回（测试用）", () => {
    const prev = process.env.PPC_NO_ENV_FILE;
    process.env.PPC_NO_ENV_FILE = "1";
    try {
      expect(defaultEnvCandidates("/repo/apps/api")).toEqual([]);
      // 连 PPC_ENV_FILE 显式指定的也要压过去 —— 测试场景下不该有例外
      process.env.PPC_ENV_FILE = "/custom/my.env";
      expect(defaultEnvCandidates("/repo/apps/api")).toEqual([]);
      delete process.env.PPC_ENV_FILE;
    } finally {
      if (prev == null) delete process.env.PPC_NO_ENV_FILE;
      else process.env.PPC_NO_ENV_FILE = prev;
    }
  });
});
