/**
 * 证据构建。
 *
 * 约束（方案第 10.3 节）：
 * - 原始 ImageBitmap 仅作为在途帧，处理完释放，不缓存几十秒全分辨率图像。
 * - 用带时间戳的压缩关键帧候选与数值序列形成**有界**缓存（初始 32 MiB）。
 * - 证据选帧与姿态结果通过 frameId 对齐，**不能拿后来的图片配前一帧骨架**。
 * - 被选入当前请求的少量证据先冻结，其他缓存照常流转。
 * - 临时缓存可以淘汰；用户主动保留的样本不自动删除。
 */

import type { EvidenceKeyframe, PhaseEvent, PoseFrame } from "@pingpong/contracts";

export interface KeyframeCandidate {
  frameId: string;
  sourceTimeMs: number;
  /** 压缩后的 JPEG 数据 */
  bytes: Uint8Array;
  width: number;
  height: number;
  /** 用户主动保留的候选不会被自动淘汰 */
  pinned: boolean;
}

/** 挑中的一张图：属于哪一板、锚在哪个事件上、偏了多少毫秒。 */
export interface KeyframePick {
  strokeId: string;
  frameId: string;
  sourceTimeMs: number;
  role: EvidenceKeyframe["role"];
  /**
   * 距**锚定事件**的带符号毫秒偏移（`sourceTimeMs − 事件时刻`）。
   * `0` = 就取在转变时刻；`> 0` = 同一相位内靠后。
   */
  eventTimeOffsetMs: number;
  /**
   * 这一张是不是**相位内的腕速峰值帧**。
   *
   * 为什么要单独记：偏移 > 0 有**两种**来路 ——
   * ① 腕速峰值帧（本来就取在相位中段）；② 事件那一刻**恰好没采到图**（图片每 3 帧
   * 一张），退到窗内最近一张。两者在偏移上看不出区别，但**含义完全不同**：
   * 前者是"这张图代表相位中段"，后者是"转变那一刻没有画面"。
   * 实测（8.15s / 30fps 素材）：18 张里只有 6 张偏移正好是 0，其余大多属于②。
   * 不分开就会写出"其余都是峰值帧"这种假话。
   *
   * **不进契约**：对模型有意义的是偏移本身，来路是发端的自述。
   */
  fromAnchor: boolean;
}

/**
 * 一个**没能配上图**的阶段转变。
 *
 * 与 `buildKeyframes` 的 `missing` 是**两类事**，不能合并：
 * - 这里：**没挑出可用的帧**（该事件的窗口里一张有像素的都没有）——数据侧的缺失；
 * - `missing`：挑中了却取不到像素 —— 链路侧的缺陷。
 * 合成一个数，「缺陷」这个信号就被「数据不足」稀释掉了。
 */
export interface KeyframeEventMiss {
  strokeId: string;
  eventType: PhaseEvent["eventType"];
  /** 该事件的时间窗（闭区间的两个端点，用于把缺失说清楚） */
  windowMs: [number, number];
}

/**
 * 事件类型 → 关键帧角色。
 *
 * 中文说明（避免把状态机口径当成解剖学结论）：
 * - `backswing_start` 离开准备区 → `backswing`
 * - `forward_start` 确认回身并加速向回 → `forward`
 * - `return_start` 重新进入准备区 → `return`
 * - `stroke_closed` 在区内稳定驻留够久、本板成立 → `ready`
 */
const ROLE_BY_EVENT: Record<PhaseEvent["eventType"], EvidenceKeyframe["role"]> = {
  backswing_start: "backswing",
  forward_start: "forward",
  return_start: "return",
  stroke_closed: "ready",
};

/**
 * 事件窗：第 i 个事件从它的时刻起，到**下一个事件**的时刻为止。
 *
 * 非最后一个事件用**半开**区间 `[t_i, t_{i+1})`：否则相邻两个窗口会同时包含
 * 边界那一帧，两个事件都去抢它 —— 抢到手的那张图上标着哪一个阶段就变成了偶然。
 * 最后一个事件（`stroke_closed`）用闭区间到本板结束：它的支撑帧就是闭合那一帧。
 */
function eventWindow(
  events: readonly PhaseEvent[],
  i: number,
  endMs: number | null,
): { lo: number; hi: number; includeHi: boolean } {
  const next = events[i + 1];
  if (next) return { lo: events[i]!.timeMs, hi: next.timeMs, includeHi: false };
  return { lo: events[i]!.timeMs, hi: endMs ?? events[i]!.timeMs, includeHi: true };
}

function inWindow(
  c: KeyframeCandidate,
  w: { lo: number; hi: number; includeHi: boolean },
): boolean {
  if (c.sourceTimeMs < w.lo) return false;
  return w.includeHi ? c.sourceTimeMs <= w.hi : c.sourceTimeMs < w.hi;
}

/**
 * 选择代表性关键帧：**先定事件，再选图**（评审 §6.2 / 方案 §1.5）。
 *
 * ## 为什么把「按区间时间比例挑」整条拆掉
 *
 * 原实现是这样挑的：引拍那张 = 「起点到锚点的中点」，向前那张 = 「最接近锚点的帧」，
 * 还原那张 = 「锚点到终点的中点」，准备那张 = 区间起点。名字看起来像事件
 * （`role=forward`），实际上只是**比例位置** —— 提示词里那句话于是要么骗人、
 * 要么就得配一条「按时间比例挑选」的免责声明。F-054 之后分段器**已经知道**
 * 真实的阶段转变时刻，继续按比例猜没有任何理由。
 *
 * 而且那条回退路径在产品里**根本走不到**：只有 `complete` 挥拍会进 `validStrokes`
 * （`training-session.ts`），而闭合时**无条件**产生 `stroke_closed`
 * （`segmentation.ts`）——每一板的 `phaseEvents` 至少有一条。
 * 留着一条走不到的分支，只会让「这张图是按什么挑的」多出一种永远不出现的情况。
 *
 * ## 规则
 *
 * 1. **每个事件挑一张。** 先要该事件的**支撑帧**（`supportFrameIds` —— 就是触发这次
 *    转变的那一帧，语义上最正当）；它没采到图（图片是每 3 帧一张）时，退到
 *    **该事件的窗口内**离事件时刻最近的一张。
 * 2. **窗内一张都没有 → 记一条 `eventMisses`**，**不借窗外的图、更不借别的板的图**
 *    （方案 §1.5 第 2 条）。借来的图会挂着一个它并不代表的阶段名，比缺一张更糟。
 * 3. **腕速峰值那一张照旧保留**，但角色按它**真实所在的相位**认定：取最后一个
 *    `timeMs ≤ 峰值` 的事件当锚点，偏移 = 峰值 − 该事件时刻。
 *    峰值早于全部事件（还在准备区驻留里 —— 合成用例就是这种）时**不发这一张**：
 *    那是一张静止的准备位图，而且会让 `role=ready` 同时表示「本板闭合」与
 *    「起始驻留」两件事，读的人分不出来。
 *    锚点**不是**击球时刻（红线 2），这里只是把它当「相位内偏后的一张」用。
 * 4. 全部挑选用**同一个 `used` 集合**：峰值帧与 `forward_start` 完全可能是同一帧，
 *    不去重就会产出两张同 `id` 的图 —— 提示词里列两遍、多模态请求多发一份字节。
 *
 * 返回**时间序**：提示词里按时间读下去即是一条动作时间线。
 */
export function selectRepresentativeFrames(
  stroke: {
    strokeId: string;
    startMs: number;
    endMs: number | null;
    anchor: { timeMs: number };
    /** 这一板的证据帧 id。只有它们有资格当关键帧 */
    evidenceFrameIds: readonly string[];
    /** 这一板真实发生的阶段转变（时间递增）。每板至少一条（含 `stroke_closed`） */
    phaseEvents: readonly PhaseEvent[];
  },
  candidates: KeyframeCandidate[],
  maxCount = 6,
): { picks: KeyframePick[]; eventMisses: KeyframeEventMiss[] } {
  const allowed = new Set(stroke.evidenceFrameIds);
  // 候选先收窄成「本板证据帧 ∧ 有像素」，且必须落在本板区间内
  const pool = candidates.filter(
    (c) =>
      allowed.has(c.frameId) &&
      c.sourceTimeMs >= stroke.startMs &&
      (stroke.endMs == null || c.sourceTimeMs <= stroke.endMs),
  );

  const picks: KeyframePick[] = [];
  const eventMisses: KeyframeEventMiss[] = [];
  const used = new Set<string>();
  const events = stroke.phaseEvents;

  /** 窗口内离 `targetMs` 最近的一张未用候选。 */
  const nearestIn = (
    w: { lo: number; hi: number; includeHi: boolean },
    targetMs: number,
  ): KeyframeCandidate | null => {
    let best: KeyframeCandidate | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const c of pool) {
      if (used.has(c.frameId) || !inWindow(c, w)) continue;
      const delta = Math.abs(c.sourceTimeMs - targetMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = c;
      }
    }
    return best;
  };

  const take = (
    c: KeyframeCandidate,
    role: EvidenceKeyframe["role"],
    anchorMs: number,
    fromAnchor: boolean,
  ): void => {
    used.add(c.frameId);
    picks.push({
      strokeId: stroke.strokeId,
      frameId: c.frameId,
      sourceTimeMs: c.sourceTimeMs,
      role,
      eventTimeOffsetMs: c.sourceTimeMs - anchorMs,
      fromAnchor,
    });
  };

  if (events.length === 0) {
    // 产品里到不了这里（只有 complete 挥拍才有图，而 complete 必有 stroke_closed）。
    // 照实记一条缺失，而不是临时编一张图出来。
    eventMisses.push({
      strokeId: stroke.strokeId,
      eventType: "stroke_closed",
      windowMs: [stroke.startMs, stroke.endMs ?? stroke.startMs],
    });
  }

  for (const [i, ev] of events.entries()) {
    const w = eventWindow(events, i, stroke.endMs);
    const role = ROLE_BY_EVENT[ev.eventType];
    // ① 支撑帧优先（它就在事件时刻上）
    const support = pool.find(
      (c) => ev.supportFrameIds.includes(c.frameId) && !used.has(c.frameId),
    );
    if (support) {
      take(support, role, ev.timeMs, false);
      continue;
    }
    // ② 退到窗内最近的一张
    const nearest = nearestIn(w, ev.timeMs);
    if (nearest) {
      take(nearest, role, ev.timeMs, false);
      continue;
    }
    eventMisses.push({
      strokeId: stroke.strokeId,
      eventType: ev.eventType,
      windowMs: [w.lo, w.hi],
    });
  }

  /*
   * 腕速峰值那一张：角色取**峰值真实所在相位**对应的事件。
   * 早于全部事件（还在准备区驻留）就不发 —— 见上面规则 3。
   */
  const peakMs = stroke.anchor.timeMs;
  let anchorIndex = -1;
  for (const [i, ev] of events.entries()) {
    if (ev.timeMs <= peakMs) anchorIndex = i;
  }
  if (anchorIndex >= 0) {
    const anchorEvent = events[anchorIndex]!;
    const w = eventWindow(events, anchorIndex, stroke.endMs);
    const peakPick = nearestIn(w, peakMs);
    if (peakPick) {
      take(peakPick, ROLE_BY_EVENT[anchorEvent.eventType], anchorEvent.timeMs, true);
    }
  }

  // 时间序：提示词里按时间读下去就是一条动作时间线
  picks.sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);

  if (picks.length <= maxCount) return { picks, eventMisses };

  /*
   * 超出图片预算（拉锯的一板可以有很多次转变 —— 实测素材里出现过 7 条）。
   *
   * 先保**每个相位各一张**（让模型看得到完整的过程），余量再按时间顺序补上重复的
   * 那几次转变（拉锯本身也是信息：它说明这一板没一次到位）。
   * 直接按时间截尾会丢掉「有没有还原」，那恰恰是最该看的一段。
   */
  const seenRoles = new Set<string>();
  const firstOfRole: KeyframePick[] = [];
  const repeats: KeyframePick[] = [];
  for (const p of picks) {
    if (seenRoles.has(p.role)) {
      repeats.push(p);
    } else {
      seenRoles.add(p.role);
      firstOfRole.push(p);
    }
  }
  const kept = [...firstOfRole, ...repeats].slice(0, maxCount);
  kept.sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
  return { picks: kept, eventMisses };
}

/** 初始媒体缓存预算 32 MiB */
const DEFAULT_CACHE_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * 有界关键帧缓存。
 * 达到上限时淘汰未保留的旧候选（先进先出），不影响被 pin 的样本。
 */
export class KeyframeCache {
  private items: KeyframeCandidate[] = [];
  private bytes = 0;

  constructor(private readonly budgetBytes = DEFAULT_CACHE_BUDGET_BYTES) {}

  add(candidate: KeyframeCandidate): void {
    this.items.push(candidate);
    this.bytes += candidate.bytes.byteLength;
    this.evictIfNeeded();
  }

  /** 淘汰未 pin 的最旧候选，直到回到预算内。 */
  private evictIfNeeded(): void {
    while (this.bytes > this.budgetBytes) {
      const index = this.items.findIndex((c) => !c.pinned);
      if (index === -1) break; // 全是用户保留的，不再淘汰
      const [removed] = this.items.splice(index, 1);
      if (removed) this.bytes -= removed.bytes.byteLength;
    }
  }

  /** 标记为保留，不再被自动淘汰。 */
  pin(frameId: string): void {
    const item = this.items.find((c) => c.frameId === frameId);
    if (item) item.pinned = true;
  }

  get(frameId: string): KeyframeCandidate | undefined {
    return this.items.find((c) => c.frameId === frameId);
  }

  get size(): number {
    return this.items.length;
  }

  get usedBytes(): number {
    return this.bytes;
  }

  /** 清空全部缓存（停止训练时调用）。 */
  clear(): void {
    this.items = [];
    this.bytes = 0;
  }
}

/**
 * 把挑中的帧转成证据包中的关键帧（按 frameId 从缓存取图）。
 *
 * 取不到图或取不到对应姿态帧的 frameId 进 `missing`，**由调用方负责说出来** ——
 * 静默少几张，用户只会觉得"怎么时多时少"（F-028 就是这么静默了整条图片链路）。
 *
 * ## 为什么入参从 `string[]` 换成了带角色的对象数组（R2）
 *
 * 原签名是 `buildKeyframes(ids: string[], cache, poses, role = "other")` ——
 * `selectRepresentativeFrames` 明明算出了每张图的阶段角色（引拍/前挥/还原），
 * 调用点却只传了 `frameId` 数组，于是**每一张的角色都落到默认值 `"other"`**。
 *
 * 后果不是"少一个字段"：提示词里写着 `角色=${k.role}`，模型看到的是
 * 六张一律 `other` 的图 —— 它没法知道哪张是引拍、哪张在击球附近，
 * 于是只能讲"整体节奏"这类没有落点的话。
 *
 * 修法是把**那个默认值本身去掉**，而不是在调用点补一个参数：
 * 只要这个参数还能被省略，下一次改动就会再漏一次。
 *
 * `strokeId` 与 `eventTimeOffsetMs` 同理**没有默认值**：漏了就是"这张图不知道
 * 属于哪一板、不知道锚在哪"，而这两件事正是选帧器存在的理由。
 */
export function buildKeyframes(
  picks: ReadonlyArray<KeyframePick>,
  cache: KeyframeCache,
  posesByFrameId: Map<string, PoseFrame>,
): { keyframes: EvidenceKeyframe[]; missing: string[] } {
  const keyframes: EvidenceKeyframe[] = [];
  const missing: string[] = [];

  for (const pick of picks) {
    const candidate = cache.get(pick.frameId);
    const pose = posesByFrameId.get(pick.frameId);
    if (!candidate || !pose) {
      missing.push(pick.frameId);
      continue;
    }
    keyframes.push({
      id: candidate.frameId,
      sourceTimeMs: candidate.sourceTimeMs,
      jpegBase64: bytesToBase64(candidate.bytes),
      frameId: pose.frameId,
      strokeId: pick.strokeId,
      width: candidate.width,
      height: candidate.height,
      role: pick.role,
      eventTimeOffsetMs: pick.eventTimeOffsetMs,
    });
  }

  return { keyframes, missing };
}

/** 把字节转换为 base64。在浏览器中用分块方式避免超长参数溢出。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
