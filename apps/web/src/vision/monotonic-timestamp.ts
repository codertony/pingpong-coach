/**
 * 把媒体时间**单调化**再交给 MediaPipe 的 `detectForVideo`。
 *
 * ## 为什么必须做（F-011）
 *
 * `detectForVideo` 的 timestamp 必须**严格递增**：喂进一个不增的时间戳，
 * 计算图直接报 `Packet timestamp mismatch`，而且**之后每一帧都会继续失败** ——
 * 整条推理静默死掉，界面只是不再更新骨架，看不出任何报错。
 *
 * 触发场景很常见：导入视频循环播放时媒体时间从结尾跳回 0；seek 重播同理。
 * 用户看到的现象是"视频里明明有挥拍，却一直等待有效挥拍"。
 *
 * ## 两条不许越的线
 *
 * 1. **输出严格递增**（不是"非递减"）：重复帧的时间戳相等也算不增，同样会踩报错，
 *    所以相等时抬到"上一个 + 1ms"。
 * 2. **只改喂给引擎的时间戳，不改投影到 `PoseFrame` 的 `sourceTimeMs`** ——
 *    那是源视频的真实媒体时间，改了就破坏了它作为速度基准的含义。
 *    所以这个模块只负责"算出一个可用的引擎时间戳"，调用方自己决定怎么用。
 *
 * 抽成独立模块的理由很直接：它原先住在 `pose.worker.ts` 里（一个 Worker 入口，
 * 单测没法直接 import），于是这条**一旦坏了就静默**的逻辑**一个测试都没有**。
 */

export interface MonotonicTimestamp {
  /** 交出下一个可用的引擎时间戳（保证比上一次严格大）。 */
  next(mediaTimeMs: number): number;
  /**
   * 归零，从"无历史"重新开始。
   *
   * 重新初始化模型时必须调用：沿用上一个实例的时间戳基线本身不算错，
   * 但会让"新实例的第一帧"带上一个与它无关的起点，排查时更难看。
   */
  reset(): void;
}

export function createMonotonicTimestamp(): MonotonicTimestamp {
  let last = Number.NEGATIVE_INFINITY;
  return {
    next(mediaTimeMs: number): number {
      // 负数时间戳一律当 0：MediaPipe 不接受负值，而"负的媒体时间"本身也是异常的
      const candidate = Number.isFinite(mediaTimeMs) ? Math.max(0, mediaTimeMs) : 0;
      last = candidate > last ? candidate : last + 1;
      return last;
    },
    reset(): void {
      last = Number.NEGATIVE_INFINITY;
    },
  };
}
