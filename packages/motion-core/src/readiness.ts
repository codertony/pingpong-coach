/**
 * 准备区标定。
 *
 * 为什么要标定：分段状态机的所有判定都以"准备区中心"为原点，
 * 而这个中心必须与**这位用户在这个机位下的实际准备姿势**一致。
 * 写死一个画面坐标（例如"水平中心、62% 高度"）几乎不可能刚好落在
 * 用户手停的位置上 —— 表现就是"视频里明明有挥拍，却一直等待有效挥拍"，
 * 而且没有任何报错。所以这里从实际观察到的腕部位置推出准备区。
 *
 * 为什么用"速度加权"而不是取最密集的格子：先按落点格子统计过一版，
 * 在真实连续对练视频上**选错了**——180 帧里最密集的格子只有 15 帧（8%），
 * 手腕几乎不停顿，于是被选中的是引拍最高点，而不是准备姿势。
 *
 * 正确的信号不是"在哪里停得久"，而是**"在哪里最慢"**：
 * 挥拍时腕部速度高，准备与还原时低。所以先算每个样本的局部速度，
 * 只保留最慢的一半再取中位数 —— 这样挥拍轨迹会被自然剔除。
 */

export interface WristSample {
  x: number;
  y: number;
}

/** 标定所需的最少样本数。少于它时返回 null，调用方应保持原准备区不变。 */
export const DWELL_MIN_SAMPLES = 20;

/**
 * 局部速度的封顶值（px/帧）。
 *
 * 滤波后的腕部位置在单帧内仍可能出现大跳变（遮挡恢复、跟踪抖动），
 * 不封顶的话少数极端速度会把权重分布拉塌。封顶只影响权重，不改判定。
 */
export const MAX_LOCAL_SPEED_PX = 40;

/** 取速度最慢的这一比例样本参与估计。 */
export const SLOW_FRACTION = 0.5;

/** 两个样本时间差超过它就不算相邻，不参与速度计算（如视频循环回绕）。 */
export const MAX_ADJACENT_GAP_MS = 300;

/** 计算相邻样本的局部速度（px/帧），时间跨度大的位置记为 null。 */
function localSpeeds(
  samples: readonly WristSample[],
  timesMs?: readonly number[],
): Array<number | null> {
  return samples.map((p, i) => {
    const prev = samples[i - 1];
    const next = samples[i + 1];
    let best: number | null = null;
    const consider = (
      other: WristSample | undefined,
      otherT: number | undefined,
      t: number | undefined,
    ) => {
      if (!other || other === p) return;
      if (timesMs && t != null && otherT != null) {
        if (Math.abs(t - otherT) > MAX_ADJACENT_GAP_MS) return;
      }
      const d = Math.hypot(other.x - p.x, other.y - p.y);
      if (best == null || d < best) best = d;
    };
    consider(prev, timesMs?.[i - 1], timesMs?.[i]);
    consider(next, timesMs?.[i + 1], timesMs?.[i]);
    return best;
  });
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * 从腕部位置样本中估计准备区中心。
 *
 * @param timesMs 可选的时间戳（与 samples 一一对应）。给了就能排除
 *                视频循环回绕造成的假跳变；不给则按索引相邻处理。
 * @returns 估计出的中心；样本不足时返回 `null`（**不要**用默认值顶替，
 *          调用方必须显式处理"还没标定出来"这个状态）。
 */
export function estimateReadyZoneFromDwell(
  samples: readonly WristSample[],
  timesMs?: readonly number[],
  minSamples: number = DWELL_MIN_SAMPLES,
): WristSample | null {
  const valid: Array<{ p: WristSample; speed: number | null; t: number | null }> = [];
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i]!;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    valid.push({ p, speed: null, t: timesMs?.[i] ?? null });
  }
  if (valid.length < minSamples) return null;

  const speeds = localSpeeds(
    valid.map((v) => v.p),
    timesMs ? valid.map((v) => v.t ?? Number.NaN) : undefined,
  );
  for (let i = 0; i < valid.length; i++) {
    const s = speeds[i];
    valid[i]!.speed = s == null || !Number.isFinite(s) ? null : Math.min(s, MAX_LOCAL_SPEED_PX);
  }

  // 没有速度信息的样本不参与"最慢一半"的筛选，但保留作为兜底样本池
  const withSpeed = valid.filter((v) => v.speed != null) as Array<{
    p: WristSample;
    speed: number;
    t: number | null;
  }>;

  let pool: WristSample[];
  if (withSpeed.length >= minSamples) {
    const sorted = [...withSpeed].sort((a, b) => a.speed - b.speed);
    const take = Math.max(minSamples, Math.floor(sorted.length * SLOW_FRACTION));
    pool = sorted.slice(0, take).map((v) => v.p);
  } else {
    pool = valid.map((v) => v.p);
  }

  return { x: medianOf(pool.map((p) => p.x)), y: medianOf(pool.map((p) => p.y)) };
}
