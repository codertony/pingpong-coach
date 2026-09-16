/**
 * 关键帧图片的**可解码性**守卫（F-042）。
 *
 * ## 为什么需要它
 *
 * 契约只要求 `keyframes[].jpegBase64` 是**合法 base64**，不要求它是**真图片**。
 * 而提供商（实测 DeepSeek）遇到不是图片的负载会直接 400：
 *
 *     .messages[1].image[0]: You have uploaded an unsupported image.
 *
 * 一次 400 会让**整次分析失败** —— 文本证据本来好好的，用户却什么都拿不到。
 *
 * ## 什么被拒、什么不被拒（实测，别按直觉猜）
 *
 * 我一开始以为是"图太小"，于是逐尺寸打了一遍（各 1 次调用）：
 *
 * | 图 | 结果 |
 * | --- | --- |
 * | 1×1 / 8×8 / 16×16 / 32×32 / 64×64 / 128×128（ffmpeg 生成）| **全部 200** |
 * | fixtures 里那张 **1 分量（灰度）** 的 1×1 JPEG | **200**（模型读出"黑色"）|
 * | 它的 3 分量重编码版本 | 200 |
 * | **600 KB 的随机假字节**（F-031 的用例故意造的）| **400 unsupported image** |
 *
 * ⇒ **尺寸不是原因，分量数也不是原因；"根本不是图片"才是。**
 * 所以这里**没有尺寸门槛**（那会是我拍脑袋定的），只做**格式可解码性**判断。
 *
 * ## 判据只查结构，不真解码
 *
 * Node 里没有内置 JPEG 解码器。这里查的是**结构标记**：SOI 开头、EOI 结尾、
 * 且存在 SOF 段并且宽高非零。这三条足以挡掉"随机字节 / 空串 / 被截断"，
 * 而它们正是实际会发生的形态。**故意不用尺寸阈值** —— 实测表明 1×1 也是合法的，
 * 拿一个我自己编的下限去卡，会把合法的小图误杀。
 */

/** 一张关键帧的最小形状（只用到这两个字段）。 */
export interface EncodableKeyframe {
  id: string;
  jpegBase64: string;
}

const SOI = [0xff, 0xd8]; // Start Of Image
const EOI = [0xff, 0xd9]; // End Of Image
/** SOF0/1/2/3（基线/扩展/渐进…）—— 宽高都在这个段里。 */
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3]);

function base64ToBytes(b64: string): Uint8Array | null {
  if (b64 === "") return null;
  try {
    const buf = Buffer.from(b64, "base64");
    // Buffer 对非法 base64 是"尽力而为"，所以要自己验一下长度与回编码是否一致
    if (buf.length === 0) return null;
    if (Buffer.from(buf.toString("base64"), "base64").length !== buf.length) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** 这张 base64 是否是一张**结构完整**的 JPEG（能拿出非零宽高）。 */
export function isDecodableJpeg(b64: string): boolean {
  const b = base64ToBytes(b64);
  if (b == null || b.length < 4) return false;
  if (b[0] !== SOI[0] || b[1] !== SOI[1]) return false;
  if (b[b.length - 2] !== EOI[0] || b[b.length - 1] !== EOI[1]) return false;

  // 找 SOF：段结构是 FF <marker> <lenHi> <lenLo> …，宽度在 len 之后的 3、4 字节
  for (let i = 2; i + 9 < b.length; i++) {
    if (b[i] !== 0xff) continue;
    const marker = b[i + 1]!;
    if (!SOF_MARKERS.has(marker)) continue;
    const height = (b[i + 5]! << 8) | b[i + 6]!;
    const width = (b[i + 7]! << 8) | b[i + 8]!;
    return width > 0 && height > 0;
  }
  return false;
}

export interface KeyframeGuardResult<T extends EncodableKeyframe> {
  /** 可以发给提供商的（顺序不变） */
  valid: T[];
  /** 被丢掉的 id（调用方应把这件事写进 limitations，**不许静默**） */
  droppedIds: string[];
}

/**
 * 把不能用的关键帧挑出来。
 *
 * **不抛异常、不静默**：返回被丢的 id，让上层如实记录。
 */
export function splitDecodableKeyframes<T extends EncodableKeyframe>(
  keyframes: readonly T[],
): KeyframeGuardResult<T> {
  const valid: T[] = [];
  const droppedIds: string[] = [];
  for (const kf of keyframes) {
    if (isDecodableJpeg(kf.jpegBase64)) valid.push(kf);
    else droppedIds.push(kf.id);
  }
  return { valid, droppedIds };
}
