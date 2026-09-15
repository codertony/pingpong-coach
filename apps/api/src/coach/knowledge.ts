/**
 * 知识选择。
 *
 * 方案第 9.3 节：服务端按 `strokeType + focusId + cameraView` 直接选择内容。
 * 只有知识数量和检索复杂度确实增加时，再引入向量检索。
 *
 * 知识条目自带审核状态。**未审核的知识不能支撑"达标/不达标"判断**，
 * 只能作为观察背景。
 */

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface KnowledgeEntry {
  id: string;
  version: string;
  strokeType: string;
  focusId: string;
  /** 适用机位；空数组表示不限 */
  cameraViews: string[];
  /** 动作适用背景 */
  context: string;
  /** 可观察现象 */
  observable: string[];
  /** 不适用或容易混淆的情形 */
  notApplicable: string[];
  /** 已审核训练提示 */
  reviewedCues: string[];
  /** 允许建议的下一练习 */
  allowedDrillIds: string[];
  /** 来源与参考片段 */
  sources: string[];
  /** 审核状态。reviewed 才允许输出技术判定 */
  status: "observation_only" | "reviewed";
  referenceId: string | null;
}

export interface KnowledgeBase {
  version: string;
  entries: KnowledgeEntry[];
}

const KNOWLEDGE_DIR = resolve(
  process.env.KNOWLEDGE_DIR ?? join(process.cwd(), "../../knowledge"),
);

/** 载入全部知识条目。文件解析失败时明确报错，不静默跳过。 */
export async function loadKnowledge(): Promise<KnowledgeBase> {
  let files: string[] = [];
  try {
    files = (await readdir(KNOWLEDGE_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    // 知识目录不存在时给出空库，但由调用方在响应中体现为"无适用知识"
    return { version: "0", entries: [] };
  }

  const entries: KnowledgeEntry[] = [];
  let maxVersion = "0";

  for (const file of files.sort()) {
    const raw = await readFile(join(KNOWLEDGE_DIR, file), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`知识文件 ${file} 解析失败：${(err as Error).message}`);
    }
    const entry = parsed as KnowledgeEntry;
    // 结构关键字段缺失时立即报错，避免半成品知识进入提示词
    if (!entry.id || !entry.focusId || !entry.strokeType) {
      throw new Error(`知识文件 ${file} 缺少 id/focusId/strokeType 必填字段`);
    }
    entries.push(entry);
    if (entry.version > maxVersion) maxVersion = entry.version;
  }

  return { version: maxVersion, entries };
}

/**
 * 按动作、关注点、机位选择知识。
 * 机位不匹配的条目不进入候选，避免把不适用的建议发给用户。
 */
export function selectKnowledge(
  kb: KnowledgeBase,
  params: { strokeType: string; focusId: string; cameraView: string },
): KnowledgeEntry[] {
  return kb.entries.filter((e) => {
    if (e.strokeType !== params.strokeType) return false;
    if (e.focusId !== params.focusId) return false;
    if (e.cameraViews.length === 0) return true;
    return e.cameraViews.includes(params.cameraView);
  });
}

/**
 * 汇总本轮适用知识所允许的提示与训练项。
 * 服务端用它来约束模型输出：模型给出的提示/训练项必须落在此集合内。
 */
export interface AllowedOutputs {
  cues: string[];
  drillIds: string[];
  /** 是否存在任何已审核知识。为 false 时只能输出 observation_only */
  hasReviewedReference: boolean;
  referenceId: string | null;
}

export function collectAllowedOutputs(entries: KnowledgeEntry[]): AllowedOutputs {
  const cues = new Set<string>();
  const drills = new Set<string>();
  let hasReviewed = false;
  let referenceId: string | null = null;

  for (const e of entries) {
    for (const c of e.reviewedCues) cues.add(c);
    for (const d of e.allowedDrillIds) drills.add(d);
    if (e.status === "reviewed" && e.referenceId != null) {
      hasReviewed = true;
      referenceId = e.referenceId;
    }
  }

  return {
    cues: [...cues],
    drillIds: [...drills],
    hasReviewedReference: hasReviewed,
    referenceId,
  };
}
