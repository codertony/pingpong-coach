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

import type { EvidenceKeyframe, PoseFrame } from "@pingpong/contracts";

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

/** 初始媒体缓存预算 32 MiB */
export const DEFAULT_CACHE_BUDGET_BYTES = 32 * 1024 * 1024;

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
 * 把候选关键帧转成证据包中的关键帧。
 *
 * 会强制校验 frameId 与姿态帧对齐 —— 拿错帧配骨架是必须避免的错误。
 */
export function buildKeyframes(
  ids: string[],
  cache: KeyframeCache,
  posesByFrameId: Map<string, PoseFrame>,
  role: EvidenceKeyframe["role"] = "other",
): { keyframes: EvidenceKeyframe[]; missing: string[] } {
  const keyframes: EvidenceKeyframe[] = [];
  const missing: string[] = [];

  for (const id of ids) {
    const candidate = cache.get(id);
    const pose = posesByFrameId.get(id);
    if (!candidate || !pose) {
      missing.push(id);
      continue;
    }
    keyframes.push({
      id: candidate.frameId,
      sourceTimeMs: candidate.sourceTimeMs,
      jpegBase64: bytesToBase64(candidate.bytes),
      frameId: pose.frameId,
      width: candidate.width,
      height: candidate.height,
      role,
    });
  }

  return { keyframes, missing };
}

/**
 * 选择代表性关键帧：优先覆盖引拍、向前挥拍与还原。
 * 最多 6 张（方案 9.2 的初始预算）。
 */
export function selectRepresentativeFrames(
  stroke: { startMs: number; endMs: number | null; anchor: { timeMs: number } },
  candidates: KeyframeCandidate[],
  maxCount = 6,
): Array<{ frameId: string; role: EvidenceKeyframe["role"] }> {
  const inRange = candidates.filter(
    (c) => c.sourceTimeMs >= stroke.startMs && (stroke.endMs == null || c.sourceTimeMs <= stroke.endMs),
  );
  if (inRange.length === 0) return [];

  const anchorMs = stroke.anchor.timeMs;
  const picked: Array<{ frameId: string; role: EvidenceKeyframe["role"] }> = [];
  const used = new Set<string>();

  const takeNearest = (targetMs: number, role: EvidenceKeyframe["role"]): void => {
    let best: KeyframeCandidate | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const c of inRange) {
      if (used.has(c.frameId)) continue;
      const delta = Math.abs(c.sourceTimeMs - targetMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = c;
      }
    }
    if (best) {
      picked.push({ frameId: best.frameId, role });
      used.add(best.frameId);
    }
  };

  // 引拍：锚点之前、区间前段
  takeNearest(stroke.startMs + (anchorMs - stroke.startMs) * 0.5, "backswing");
  // 向前挥拍：锚点附近
  takeNearest(anchorMs, "forward");
  // 还原：锚点之后
  if (stroke.endMs != null) {
    takeNearest(anchorMs + (stroke.endMs - anchorMs) * 0.5, "return");
    takeNearest(stroke.endMs, "return");
  }
  // 准备：区间起点
  takeNearest(stroke.startMs, "ready");

  // 仍有余量时按时间均匀补齐，保证覆盖完整动作
  while (picked.length < maxCount && picked.length < inRange.length) {
    const step = (stroke.endMs ?? anchorMs) - stroke.startMs;
    const target = stroke.startMs + step * (picked.length / maxCount);
    const before = picked.length;
    takeNearest(target, "other");
    if (picked.length === before) break;
  }

  return picked.slice(0, maxCount);
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
