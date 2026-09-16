/**
 * 模型资产的自洽性检查。
 *
 * 守的是一个**会伪造溯源**的分歧：`VITE_MODEL_ID_ASSET` 的用途是在同一素材上
 * 比较 full 与 lite（见 models/manifest.json 里 lite 的 role: speed-comparison）。
 * 但如果只让环境变量改 `modelId`、加载路径却写死，就会**加载 full 权重、
 * 却上报 lite 的 modelId** —— 而 `modelId` 是写进 `PoseFrame`、
 * 用于评估与费用归因的。那等于伪造溯源。
 *
 * 所以这里断言：**id 与路径必须成对出现**，且与 manifest 的声明一致。
 *
 * 注意：本文件只读 manifest 的**文本**，不加载真实 `.task`（那些在 Git 之外，
 * 由 `pnpm models:fetch` 获取）—— 所以它在任何机器上都能跑。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
const manifest = JSON.parse(readFileSync(resolve(repoRoot, "models/manifest.json"), "utf8"));
const assetSource = readFileSync(resolve(repoRoot, "apps/web/src/config/model-asset.ts"), "utf8");

/** manifest 声明的 modelId → 前端路径（去掉 apps/web/public 前缀）。 */
function declaredPaths(): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of manifest.assets ?? []) {
    for (const f of a.files ?? []) {
      out.set(a.modelId, f.path.replace("apps/web/public", ""));
    }
  }
  return out;
}

describe("模型资产：id 与路径不能各说各话", () => {
  it("manifest 里每个 modelId 都声明了文件路径", () => {
    const declared = declaredPaths();
    expect(declared.size).toBeGreaterThanOrEqual(3);
    for (const [id, path] of declared) {
      expect(path, `${id} 没有声明路径`).toMatch(/^\/models\/.+\.task$/);
    }
  });

  it("前端映射表里的每个 id，路径都与 manifest 一致", () => {
    const declared = declaredPaths();
    // 抓「modelId: "/models/xxx.task"」这种成对写法
    const pairs = [...assetSource.matchAll(/^\s{2}(\w+):\s*"(\/models\/[^"]+)",?$/gm)];
    expect(pairs.length).toBeGreaterThanOrEqual(2);

    for (const m of pairs) {
      const id = m[1];
      const path = m[2];
      if (id == null || path == null) continue;
      const declaredPath = declared.get(id);
      // 只有"看起来是 modelId"的键才要求 manifest 有声明
      if (declaredPath == null) continue;
      expect(path, `${id} 的路径与 manifest 不一致`).toBe(declaredPath);
    }
  });

  it("姿态模型的路径由 id 推导，不是写死的 —— 防止改 id 不改路径", () => {
    // 若把路径写死，`VITE_MODEL_ID_ASSET` 改成 lite 时会加载 full 权重
    // 却上报 lite 的 modelId。这条断言守住"路径必须来自映射表"。
    expect(assetSource).toMatch(/POSE_MODEL_PATHS\[poseModelId\]/);
    // full 与 lite 都必须在映射表里，否则比较实验根本做不了
    expect(assetSource).toMatch(/pose_landmarker_full:\s*"\/models\/pose_landmarker_full\.task"/);
    expect(assetSource).toMatch(/pose_landmarker_lite:\s*"\/models\/pose_landmarker_lite\.task"/);
  });

  it("未知 modelId 会明确抛错，而不是静默退回默认模型", () => {
    // 静默退回会让"上报的 id"与"实际加载的权重"不一致 —— 那正是本文件要防的事
    expect(assetSource).toMatch(/throw new Error/);
    expect(assetSource).toMatch(/没有对应的资产路径/);
  });
});
