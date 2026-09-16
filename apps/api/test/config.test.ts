/**
 * 服务端配置测试。
 *
 * 最要紧的一条：**只要 API key / baseURL / modelId 三者缺一，就必须落到 mock**。
 * 绝不允许出现「以为在跑真模型、其实在跑 mock」的静默降级 ——
 * 那会让所有真实延迟与准确率数据都失去意义。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

const KEYS = [
  "MODEL_API_KEY",
  "MODEL_BASE_URL",
  "MODEL_ID",
  "PORT",
  "HOST",
  "MODEL_TIMEOUT_MS",
  "MODEL_MAX_TOKENS",
  "MAX_REQUEST_BYTES",
  "DEDUPE_TTL_MS",
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadConfig — mock/live 判定", () => {
  it("三个变量都缺失时为 mock 模式", () => {
    expect(loadConfig().modelMode).toBe("mock");
  });

  it("只有 API key 时为 mock（不能半配置就当 live）", () => {
    process.env.MODEL_API_KEY = "sk-x";
    expect(loadConfig().modelMode).toBe("mock");
  });

  it("只有 key + baseURL 时仍为 mock", () => {
    process.env.MODEL_API_KEY = "sk-x";
    process.env.MODEL_BASE_URL = "https://x.invalid/v1";
    expect(loadConfig().modelMode).toBe("mock");
  });

  it("只有 baseURL + modelId 时（缺 key）仍为 mock", () => {
    process.env.MODEL_BASE_URL = "https://x.invalid/v1";
    process.env.MODEL_ID = "m";
    expect(loadConfig().modelMode).toBe("mock");
  });

  it("三者齐备时为 live 模式", () => {
    process.env.MODEL_API_KEY = "sk-x";
    process.env.MODEL_BASE_URL = "https://x.invalid/v1";
    process.env.MODEL_ID = "m";
    const c = loadConfig();
    expect(c.modelMode).toBe("live");
    expect(c.modelId).toBe("m");
  });

  it("空白字符串不算有效配置（防止 .env 里留了空值假装配好）", () => {
    process.env.MODEL_API_KEY = "   ";
    process.env.MODEL_BASE_URL = "   ";
    process.env.MODEL_ID = "   ";
    expect(loadConfig().modelMode).toBe("mock");
  });

  it("mock 模式下 modelId 归一为 mock-coach，便于费用归因时一眼识别", () => {
    expect(loadConfig().modelId).toBe("mock-coach");
  });
});

describe("loadConfig — 数值项与缺省值", () => {
  it("未设置时使用文档约定的默认值", () => {
    const c = loadConfig();
    expect(c.port).toBe(8787);
    expect(c.host).toBe("127.0.0.1");
    expect(c.modelTimeoutMs).toBe(45_000);
    expect(c.modelMaxTokens).toBe(4000);
    expect(c.maxRequestBytes).toBe(2 * 1024 * 1024);
    expect(c.dedupeTtlMs).toBe(30_000);
  });

  it("合法数值被采纳", () => {
    process.env.PORT = "9000";
    process.env.MODEL_TIMEOUT_MS = "1500";
    const c = loadConfig();
    expect(c.port).toBe(9000);
    expect(c.modelTimeoutMs).toBe(1500);
  });

  it("非法数值回落到默认值（不产生 NaN 端口）", () => {
    process.env.PORT = "not-a-number";
    process.env.MODEL_TIMEOUT_MS = "-5";
    const c = loadConfig();
    expect(c.port).toBe(8787);
    expect(c.modelTimeoutMs).toBe(45_000);
  });

  it("小数数值被向下取整为整数", () => {
    process.env.PORT = "8080.9";
    expect(loadConfig().port).toBe(8080);
  });

  it("空字符串环境变量回落到默认值", () => {
    process.env.PORT = "";
    expect(loadConfig().port).toBe(8787);
  });
});

describe("loadConfig — 密钥不外泄", () => {
  it("配置对象里不包含把密钥打印出来的辅助字段", () => {
    process.env.MODEL_API_KEY = "sk-secret-value";
    process.env.MODEL_BASE_URL = "https://x.invalid/v1";
    process.env.MODEL_ID = "m";
    const c = loadConfig();
    // 密钥本身要在（服务端要用），但序列化结果里不应出现额外副本或派生字段。
    expect(c.modelApiKey).toBe("sk-secret-value");
    const serialized = JSON.stringify(c);
    // 只应出现一次 —— 不该被复制到 modelId / baseUrl 等字段里。
    expect(serialized.split("sk-secret-value").length - 1).toBe(1);
  });
});
