/**
 * 关键帧的采集与编码（F-028）。
 *
 * ## 为什么需要这个模块
 *
 * `EvidencePacket.keyframes` 从契约、缓存（`KeyframeCache`）、到服务端校验
 * **整条链路都是为图片设计的** —— 只有"谁往缓存里放图"这一步没写。
 * 结果 `keyframes` 恒为空数组，"多模态调用"实际收到的是纯文本。
 *
 * 参数**照抄 `configs/thresholds.json` 里已经声明的预算**，不是自己定的：
 * 长边不超过 `maxImageLongEdgePx`（960），关键帧张数由
 * `selectRepresentativeFrames` 的默认值（6）控制。
 *
 * ## 为什么缩放放在这里而不是靠服务端兜
 *
 * 服务端的 `maxRequestBytes` 是 **2 MiB 并且是"拒绝"而不是"降采样"** ——
 * 超了就直接失败。所以必须在客户端就压到预算内。
 */

/** 编码质量。0.7 是 JPEG 的常见折中：再高体积涨得快，再低人脸/球拍边缘会糊。 */
const KEYFRAME_JPEG_QUALITY = 0.7;

/**
 * 按"长边不超过 `maxLongEdgePx`"等比算出目标尺寸。
 *
 * 纯函数，单测直接覆盖（不需要 DOM）。规则：
 * - 长边已经不超过上限 → **原样返回**（不放大：放大只会白增体积）；
 * - 否则按长边缩放，短边同比取整并保证 ≥ 1（避免出现 0 宽/0 高的画布）；
 * - 输入非法（非正数）时返回 null，让调用方明确跳过这一帧，而不是产出一张坏图。
 */
export function fitWithinLongEdge(
  width: number,
  height: number,
  maxLongEdgePx: number,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (!Number.isFinite(maxLongEdgePx) || maxLongEdgePx <= 0) return null;

  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdgePx) {
    return { width: Math.round(width), height: Math.round(height) };
  }

  const scale = maxLongEdgePx / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** 一帧的编码结果。`bytes` 为空的条目**不要**塞进缓存 —— 那等于没图。 */
export interface EncodedKeyframe {
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface EncodeOptions {
  maxLongEdgePx: number;
  quality?: number;
}

/**
 * 把一帧位图缩放到预算内并编码成 JPEG。
 *
 * 只在**浏览器**里可用（依赖 `OffscreenCanvas` 与 `convertToBlob`），
 * 所以这一段的回归在 e2e 里，不在 jsdom 单测里。
 *
 * 返回 `null` 表示这一帧**取不到图**（尺寸非法或编码失败）——
 * 明确返回 null 而不是抛错：单帧编码失败不该打断整条采集链路（红线 9 的精神），
 * 上层只是少一张关键帧。编码体积超出预算时也返回 null 并由此处的调用方决定如何处理。
 */
export async function encodeKeyframeJpeg(
  bitmap: ImageBitmap,
  opts: EncodeOptions,
): Promise<EncodedKeyframe | null> {
  const target = fitWithinLongEdge(bitmap.width, bitmap.height, opts.maxLongEdgePx);
  if (!target) return null;

  try {
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);

    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: opts.quality ?? KEYFRAME_JPEG_QUALITY,
    });
    const buf = await blob.arrayBuffer();
    if (buf.byteLength === 0) return null;
    return { bytes: new Uint8Array(buf), width: target.width, height: target.height };
  } catch {
    // 编码失败只影响这一帧 —— 不让它把采集链路带下去
    return null;
  }
}

/**
 * `configs/thresholds.json` 的 `evidenceBudget.maxImageLongEdgePx` 声明值。
 * 现在**真的被读**了（此前这个预算没有任何代码读它，见 F-027/F-028）。
 */
export const MAX_KEYFRAME_LONG_EDGE_PX = 960;

/**
 * 每隔几帧编一张关键帧。
 *
 * 为什么抽帧而不是每帧都编：JPEG 编码是毫秒级的，30fps 下每帧都编会直接吃进
 * 端到端延迟（合成输入下实测往返中位 25ms，见 evaluation-log）。
 * 每 3 帧 ≈ 10 张/秒，配上 32 MiB 的缓存预算
 * （`DEFAULT_CACHE_BUDGET_BYTES`）足够覆盖一整组，而编码开销降到约 1/3。
 */
export const KEYFRAME_CAPTURE_EVERY_N_FRAMES = 3;

/** 缓存要接收图片的那一面。只依赖这一个方法，便于测试替身。 */
export interface KeyframeSink {
  addFramePixels(
    frameId: string,
    sourceTimeMs: number,
    bytes: Uint8Array,
    width: number,
    height: number,
  ): void;
}

/** 采集侧一帧的最小形状（`FrameEnvelope` 是它的超集）。 */
export interface CapturableFrame {
  frameId: string;
  sourceTimeMs: number;
  bitmap: ImageBitmap;
}

export interface KeyframeCapturer {
  /**
   * 到点就编一张并写进 `sink`。**同步返回、内部异步**：
   * 采集与推理绝不能等编码（红线 9：模型/编码失败不得阻塞本地链路）。
   */
  captureIfDue(sink: KeyframeSink | null, frame: CapturableFrame): void;
}

/**
 * 造一个采集器。计数器放在闭包里而不是模块级 —— 否则测试之间会互相干扰，
 * 而且"什么时候重置"会变成一个说不清的全局问题。
 */
export function createKeyframeCapturer(
  opts: {
    everyNFrames?: number;
    maxLongEdgePx?: number;
    quality?: number;
    /**
     * 编码器。默认是真正的 JPEG 编码（需要 `OffscreenCanvas`）。
     * 留这个注入点是为了让**抽帧节奏与错误隔离**能在 vitest 里测 ——
     * jsdom 没有 `OffscreenCanvas`，不注入的话那两条逻辑只能靠 e2e 覆盖，
     * 而它们恰恰是最容易写错的部分。
     */
    encode?: (bitmap: ImageBitmap, o: EncodeOptions) => Promise<EncodedKeyframe | null>;
  } = {},
): KeyframeCapturer {
  const everyN = Math.max(1, opts.everyNFrames ?? KEYFRAME_CAPTURE_EVERY_N_FRAMES);
  const maxLongEdgePx = opts.maxLongEdgePx ?? MAX_KEYFRAME_LONG_EDGE_PX;
  const encode = opts.encode ?? encodeKeyframeJpeg;
  let seen = 0;

  return {
    captureIfDue(sink, frame) {
      if (sink == null) return;
      const due = seen % everyN === 0;
      seen++;
      if (!due) return;

      // 故意不 await、也不把 promise 抛出去：编码失败只意味着少一张关键帧，
      // 不该冒泡到采集循环里（那条路径上任何一次异常都可能中断采集）。
      void encode(frame.bitmap, { maxLongEdgePx, quality: opts.quality })
        .then((encoded) => {
          if (!encoded) return;
          sink.addFramePixels(
            frame.frameId,
            frame.sourceTimeMs,
            encoded.bytes,
            encoded.width,
            encoded.height,
          );
        })
        .catch(() => {
          /* 同上：静默跳过这一帧 */
        });
    },
  };
}
