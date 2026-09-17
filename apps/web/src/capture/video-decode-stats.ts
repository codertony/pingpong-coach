/**
 * 浏览器侧**解码**计数（评审 §6.3 / 设计 §1.5.1）。
 *
 * ## 为什么需要它
 *
 * "帧率"不是一件事，是**四件事**：源视频的标称帧率、浏览器实际解出多少帧、
 * 真正进姿态模型的帧、以及关键帧缓存里的 JPEG 张数。四者**谁也不能代替谁** ——
 * 实时预览允许丢旧帧来压延迟，所以"进模型的帧"天然比"解出来的帧"少；
 * 而关键帧是**每 3 帧才编一张**，又少一个量级。用一个数字讲完这四件事，
 * 读的人就没法判断"这一组帧少"到底是采集慢、还是解码掉、还是抽帧抽掉的。
 *
 * 丢帧与时间戳回绕都发生在**解码**这一层（F-011 就是回绕），
 * 所以这一层的数字必须来自**浏览器自己报的**，不能由我们数回调次数推算 ——
 * 推算出来的只是"我们看到了几帧"，看不到解码器默默丢了多少。
 *
 * ## 可用性与降级
 *
 * `getVideoPlaybackQuality` 在 Chrome/Edge 上有（`HTMLVideoElement`）；
 * 老 Safari 只有带前缀的版本。**两者都没有时返回 `null`** ——
 * 界面显示"未知"并给出原因，**不显示 0**（红线 1：缺失不是零）。
 */

export interface VideoDecodeStats {
  /** 浏览器累计解出的帧数 */
  decodedFrames: number;
  /** 解码器**自己丢掉的**帧数（不是我们丢的） */
  droppedByDecoder: number;
}

/** `getVideoPlaybackQuality` 的最小形状（有些浏览器没有，所以自己声明）。 */
interface PlaybackQuality {
  totalVideoFrames?: number;
  droppedVideoFrames?: number;
}

interface QualityCapableVideo {
  getVideoPlaybackQuality?: () => PlaybackQuality;
  webkitGetVideoPlaybackQuality?: () => PlaybackQuality;
}

/**
 * 读当前视频元素的解码计数；浏览器不提供时返回 `null`（**不是 0**）。
 *
 * 注意：导入视频的**交互路径**拿到的是"这一刻为止"的累计值，
 * 所以它是**运行期观测**而不是可复现的样本；要可复现的帧集合请用评估探针
 * （它按固定步长 seek，同一支素材两次得到同一批帧）。
 */
export function readVideoDecodeStats(video: unknown): VideoDecodeStats | null {
  if (video == null || typeof video !== "object") return null;
  const el = video as QualityCapableVideo;
  const read = el.getVideoPlaybackQuality ?? el.webkitGetVideoPlaybackQuality;
  if (typeof read !== "function") return null;

  let quality: PlaybackQuality;
  try {
    quality = read.call(video);
  } catch {
    // 元素已被卸载 / 跨域媒体等情况下可能抛 —— 读数失败不等于"没有丢帧"
    return null;
  }
  const decodedFrames = quality.totalVideoFrames;
  const droppedByDecoder = quality.droppedVideoFrames;
  if (typeof decodedFrames !== "number" || !Number.isFinite(decodedFrames)) return null;
  return {
    decodedFrames,
    droppedByDecoder:
      typeof droppedByDecoder === "number" && Number.isFinite(droppedByDecoder)
        ? droppedByDecoder
        : 0,
  };
}
