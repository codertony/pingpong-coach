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
  /** 来源（文献 / 教学页 / 视频时间段）。声称已审核时**必须非空** */
  sources: string[];
  /** 审核状态。reviewed 才允许输出技术判定 —— 但**光有它不够**（见下） */
  status: "observation_only" | "reviewed";
  /** 参考片段 id。声称已审核时**必须非空** */
  referenceId: string | null;
  /**
   * 适用条件的**自然语言描述**（来球旋转/高度/速度、站位、示范速度……）。
   *
   * 为什么必须有它才能声称已审核：标准的第一件事是"**先决定是否可比**"
   * （设计 §1.4 的第一行）—— 一条不说清适用条件的规则，读者无法判断它是否
   * 适用于眼前这段练习，也就无法判断"偏差"是不是偏差。
   */
  appliesTo: string | null;
  /** 审核人（谁为这条规则负责）。声称已审核时必须写明 */
  reviewer: string | null;
  /** 媒体与内容的许可说明。声称已审核时必须写明 */
  license: string | null;
}

/**
 * 一条知识**声称已审核**时，站不站得住；返回**缺什么**（给人和模型看的原话）。
 *
 * ## 为什么需要它
 *
 * 门禁此前只看两个字段：`status === "reviewed"` 与 `referenceId != null`。
 * 于是**把 status 改一下、随便填个非空字符串当 referenceId**，「达标」这条路就通了，
 * 而来源、审核人、许可、适用条件一概不必写。
 *
 * 设计 §1.4 / P2 明确点名了这个失败模式：**"不为上线方便直接把 status 改成
 * reviewed"** —— 审核不是改一个字段，而是"参考真实存在、媒体与版本可取、
 * 适用条件匹配"。
 *
 * ## 为什么是"降级并说出来"，不是"载入时抛错"
 *
 * 抛错会让**整条服务**因为一个内容文件写得不全而不可用 —— 代价与收益不成比例。
 * 正确的处理是**按未审核对待**（本来就不该给达标结论），并把"自称已审核但缺 X"
 * **说出来**（进 limitations 与提示词）。这样它既不静默，也不会把应用带下去。
 */
export function reviewedClaimDefects(entry: KnowledgeEntry): string[] {
  const defects: string[] = [];
  if (entry.reviewer == null || entry.reviewer.trim() === "") defects.push("没有审核人");
  if (entry.sources.length === 0) defects.push("没有来源");
  if (entry.license == null || entry.license.trim() === "") defects.push("没有许可说明");
  if (entry.appliesTo == null || entry.appliesTo.trim() === "") defects.push("没有适用条件");
  if (entry.referenceId == null) defects.push("没有参考片段 id");
  return defects;
}

export interface KnowledgeBase {
  version: string;
  entries: KnowledgeEntry[];
}

/**
 * 知识目录。**每次调用时读**，不是在模块载入时定死。
 *
 * 为什么：`KNOWLEDGE_DIR` 是文档里写明的可配置项，而模块载入只在进程启动时发生一次 ——
 * 载入时定死意味着"改了配置不生效，除非重启"，也意味着这条链路**没法被测到**
 * （测试没法把知识目录换成一个临时目录）。两种代价都不必要。
 */
function knowledgeDir(): string {
  return resolve(process.env.KNOWLEDGE_DIR ?? join(process.cwd(), "../../knowledge"));
}

/** 载入全部知识条目。文件解析失败时明确报错，不静默跳过。 */
export async function loadKnowledge(dir: string = knowledgeDir()): Promise<KnowledgeBase> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    // 知识目录不存在时给出空库，但由调用方在响应中体现为"无适用知识"
    return { version: "0", entries: [] };
  }

  const entries: KnowledgeEntry[] = [];
  let maxVersion = "0";

  for (const file of files.sort()) {
    const raw = await readFile(join(dir, file), "utf8");
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
  /** 是否存在**站得住的**已审核知识。为 false 时只能输出 observation_only */
  hasReviewedReference: boolean;
  referenceId: string | null;
  /**
   * 哪几条**自称已审核但站不住**、各缺什么。
   *
   * 调用方**必须把它们说出来**（服务端会把它们写进 `limitations` 与提示词）：
   * 静默降级与"当成审过了"在结果上完全一样 —— 而后者正是这条门禁要挡的事。
   */
  unsupportedReviewedClaims: Array<{ id: string; defects: string[] }>;
}

export function collectAllowedOutputs(entries: KnowledgeEntry[]): AllowedOutputs {
  const cues = new Set<string>();
  const drills = new Set<string>();
  let hasReviewed = false;
  let referenceId: string | null = null;
  const unsupportedReviewedClaims: Array<{ id: string; defects: string[] }> = [];

  for (const e of entries) {
    for (const c of e.reviewedCues) cues.add(c);
    for (const d of e.allowedDrillIds) drills.add(d);
    if (e.status !== "reviewed") continue;
    // 声称已审核 → 必须经得起审：缺任何一项都**按未审核处理**并记账
    const defects = reviewedClaimDefects(e);
    if (defects.length > 0) {
      unsupportedReviewedClaims.push({ id: e.id, defects });
      continue;
    }
    hasReviewed = true;
    referenceId = e.referenceId;
  }

  return {
    cues: [...cues],
    drillIds: [...drills],
    hasReviewedReference: hasReviewed,
    referenceId,
    unsupportedReviewedClaims,
  };
}
