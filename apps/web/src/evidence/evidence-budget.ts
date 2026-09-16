/**
 * 证据包的请求体积预算（数据契约「图片与请求预算」）。
 *
 * ## 为什么需要它
 *
 * `docs/data-contracts.md` 对请求总大小写的是"上限 2 MiB，**超限先减少冗余图片
 * 并记录降采样**"。而此前代码里没有这回事：服务端 `analyze.ts` 超限直接返回
 * **HTTP 413 + `evidence_too_large`**，附带一句"请减少冗余关键帧或降低图片质量"
 * —— 把这件事**推给调用方**，自己既不减图也不记录。
 *
 * 也就是说：超一点预算，用户**什么都拿不到**（没有反馈），
 * 而契约描述的行为本该是"少给几张图，照样给反馈，并如实说明"。
 * 所以这件事该在**客户端**做：客户端手里才有图片，也只有它能把图重新压小。
 *
 * ## 与服务端那个上限的关系（诚实说明）
 *
 * 服务端的上限来自 `apps/api` 的 `MAX_REQUEST_BYTES`，**可以被环境变量覆盖**。
 * 客户端这个常量是一份**副本**，两处没有自动比对（`apps/web` 不依赖 `apps/api`）。
 * 所以这里做的是**尽力而为的事前压**：压完仍然超预算时，服务端照样会 413 ——
 * 那是正确的兜底，只是这时用户拿不到反馈。把这条写清楚，免得有人以为客户端
 * 已经能保证不超。
 */

/** 与服务端 `MAX_REQUEST_BYTES` 的默认值一致（2 MiB）。 */
export const MAX_REQUEST_BYTES_BUDGET = 2 * 1024 * 1024;

/** UTF-8 字节长度。服务端用 `Buffer.byteLength(json, "utf8")` 量，这里对齐同一口径。 */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/**
 * 按预算裁剪关键帧：**从最后一张开始丢**，直到放得下、或只剩一张。
 *
 * 为什么从末尾丢：`selectRepresentativeFrames` 是按
 * 引拍 → 向前挥拍 → 还原 → 准备 → 其他 的顺序返回的，
 * 所以末尾那几张是最不关键的。先丢冗余，再丢关键 —— 与契约里
 * "先减少**冗余**图片"的意思一致。
 *
 * 保留"至少一张"：一张都不给就等于没有图片证据，那还不如让服务端去 413，
 * 至少失败是明确的。只剩一张仍超预算时如实返回 `fits: false`。
 *
 * @param sizeOf 给定这批关键帧时，**整个包**的字节数（含其它字段）。
 *               用真实序列化结果去量，不做估算 —— 估偏了会算出"压过了"其实没压过。
 */
export function trimKeyframesToBudget<K>(
  keyframes: readonly K[],
  sizeOf: (kept: readonly K[]) => number,
  budgetBytes: number = MAX_REQUEST_BYTES_BUDGET,
): { kept: K[]; dropped: number; bytes: number; fits: boolean } {
  let kept = [...keyframes];
  let bytes = sizeOf(kept);
  let dropped = 0;

  while (bytes > budgetBytes && kept.length > 1) {
    kept = kept.slice(0, -1);
    dropped++;
    bytes = sizeOf(kept);
  }

  return { kept, dropped, bytes, fits: bytes <= budgetBytes };
}

/** 被裁剪时写进 `limitations` 的一句话。必须能被模型和用户看见。 */
export function describeKeyframeTrim(dropped: number, bytes: number): string {
  const mib = (bytes / 1024 / 1024).toFixed(2);
  return (
    `请求体积超出预算，已丢弃 ${dropped} 张关键帧后发送（压后约 ${mib} MiB）——` +
    `模型看到的画面比实际采集到的少，涉及画面的结论应相应保守`
  );
}
