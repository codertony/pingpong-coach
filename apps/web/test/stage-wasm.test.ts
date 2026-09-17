/**
 * 构建必须**自己**把 MediaPipe 的 WASM 铺进 `public/wasm`。
 *
 * 为什么值得一条测试：`public/wasm` 在 .gitignore 里，而只有模型有权重下载脚本 ——
 * WASM 谁都不负责。所以"产物里有没有 WASM"曾经取决于**构建机上有没有人手跑过一条 cp**：
 * 本机照文档做过的人有、别人没有，而**生产镜像一定没有**（`.dockerignore` 排除了它，
 * 构建里又没有任何一步复制它）。`vite build` 对空的 public 目录不报错，
 * 健康检查也照样过 —— 缺 WASM 的表现是**骨架永远出不来**，没有任何一处会报红。
 *
 * 这条测试就是那个"该报红的地方"，所以它必须**真的**从零铺一遍：
 * 先把 public/wasm 删掉（那是可再生的派生目录），再调插件，逐文件比大小。
 * 不这么做的话，本机那份早就铺好的文件会让它永远是绿的 —— 空转的守卫。
 */

import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../vite.config";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageWasm = resolve(webRoot, "node_modules/@mediapipe/tasks-vision/wasm");
const publicWasm = resolve(webRoot, "public/wasm");
/** 临时改名用的名字：把包内目录挪开以模拟"依赖没装/布局变了"。 */
const packageWasmHidden = resolve(
  webRoot,
  "node_modules/@mediapipe/tasks-vision/.wasm-moved-for-test",
);

/** 取出并执行构建用的铺文件钩子；插件被删掉时这里就红。 */
function stageHook(): () => void {
  const plugins = (Array.isArray(config.plugins) ? config.plugins : []).flat();
  const plugin = plugins.find(
    (p) => p && typeof p === "object" && "name" in p && p.name === "stage-mediapipe-wasm",
  );
  if (!plugin || typeof plugin !== "object" || !("buildStart" in plugin)) {
    throw new Error(
      "vite.config.ts 的 plugins 里没有 stage-mediapipe-wasm —— " +
        "构建产物会缺 WASM，浏览器里骨架起不来（也就是 F-007 的症状）",
    );
  }
  const hook = plugin.buildStart;
  if (typeof hook !== "function") throw new Error("stage-mediapipe-wasm 缺少 buildStart 钩子");
  return () => {
    (hook as () => void).call(plugin);
  };
}

describe("构建铺 WASM 运行时", () => {
  it("从 node_modules 铺进 public/wasm，逐个文件大小一致", () => {
    const stage = stageHook();

    // 从零开始：不删的话本机那份旧文件会让"什么都没复制"也通过
    rmSync(publicWasm, { recursive: true, force: true });
    stage();

    const names = readdirSync(packageWasm);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const to = resolve(publicWasm, name);
      expect(existsSync(to), `${name} 没被铺进 public/wasm`).toBe(true);
      expect(statSync(to).size, `${name} 大小与包内不一致`).toBe(
        statSync(resolve(packageWasm, name)).size,
      );
    }
  });

  it("包内没有 WASM 目录时直接报错，不静默产出没有 WASM 的产物", () => {
    const stage = stageHook();

    renameSync(packageWasm, packageWasmHidden);
    try {
      expect(() => stage()).toThrow(/WASM/);
    } finally {
      renameSync(packageWasmHidden, packageWasm);
    }
  });
});
