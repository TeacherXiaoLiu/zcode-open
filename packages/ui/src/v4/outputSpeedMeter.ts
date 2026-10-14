// 会话输出速度计量（本地定制）：从 v4 投影的流式文本增量估算模型输出速度。
//
// 为什么是"估算"：协议在流式过程中只有文本字符增量（row.delta），usage 只在每个模型请求
// 结束时一次性给出，无法逐 token 计数。这里按字符构成粗估 token 数——CJK 约 1 token/字、
// 其余约 4 字符/token，典型模型（cl100k/Claude 系）误差约 ±30%。用途是「节奏反馈」，
// 权威速度（真实 tokens ÷ 请求耗时）以会话统计/调试面板的 TPS 为准。
//
// 两个口径：
//   - 实时速度：最近 RATE_WINDOW 滑动窗口内的估算 token ÷ 有效跨度（流式刚开始时用实际
//     跨度，避免固定分母低估；窗口填满后即窗口长度本身），空闲 5 秒后自然归零。
//   - 平均速度：本计量器生命周期内累计估算 token ÷ 累计生成时长。生成时长按"段"累计：
//     相邻增量间隔超过 IDLE_GAP 视为一次停顿（工具执行、等待权限等），停顿不计入分母，
//     与"首 token 之后才算生成时间"的既有口径（calculateOutputTps）保持一致。

/** 实时速度滑动窗口：最近 5 秒内到达的输出。 */
export const OUTPUT_SPEED_RATE_WINDOW_MS = 5_000;
/** 样本保留时长（大于滑动窗口即可，再长只是浪费内存）。 */
const OUTPUT_SPEED_SAMPLE_TTL_MS = 30_000;
/** 超过该间隔视为一段新的生成（工具执行、等待用户等停顿不计入生成时长）。 */
export const OUTPUT_SPEED_IDLE_GAP_MS = 2_000;
/** 分母下限：单帧到达无法精确计时，避免除零或瞬时爆表。 */
const OUTPUT_SPEED_MIN_SPAN_MS = 500;
/** 单帧字符数超过该值视为批量/重放内容（正常流式帧远小于此），不参与统计。 */
export const OUTPUT_SPEED_MAX_FRAME_CHARS = 20_000;
/**
 * 实时速度显示上限（tok/s）。正常流式远达不到；用于兜住"断线重放/异常快照"把大量
 * 增量挤在一瞬间到达的场景（沿用 Hermes h-stats 的 100k 保护口径），避免出现荒谬数字。
 */
export const OUTPUT_SPEED_MAX_TPS = 100_000;

interface SpeedSample {
  t: number;
  tokens: number;
}

/**
 * 平均速度快照（跨会话切换保留）。
 * 实时样本带 renderer 时钟时间戳，切走的会话再回来时必然过期，所以跨会话只保留平均口径；
 * 实时读数回到会话后等新输出自然恢复。
 */
export interface OutputSpeedAverageSnapshot {
  /** 累计估算 token（平均速度的分子）。 */
  totalTokens: number;
  /** 累计生成时长毫秒（平均速度的分母，不含停顿）。 */
  totalActiveMs: number;
}

export interface OutputSpeedMeter {
  /** 推入一段模型输出文本（assistantText / reasoning 的流式增量）。 */
  push(text: string): void;
  /** 清空全部统计（当前会话没有可用快照时调用）。 */
  reset(): void;
  /** 实时速度（tok/s 估算）；滑动窗口内无输出时返回 null。 */
  liveTokensPerSecond(now?: number): number | null;
  /** 平均速度（tok/s 估算）；从未有过输出时返回 null。 */
  averageTokensPerSecond(): number | null;
  /** 最近是否有输出活动（驱动状态条按需刷新）。 */
  hasRecentActivity(withinMs?: number, now?: number): boolean;
  /** 导出平均口径快照；无数据时返回 null。 */
  snapshotAverage(): OutputSpeedAverageSnapshot | null;
  /**
   * 从快照恢复平均口径（切回有历史的会话时调用）。
   * 只恢复平均的分子分母：实时样本的时间戳在切换期间已过期，不恢复。
   */
  restoreAverage(snapshot: OutputSpeedAverageSnapshot | null): void;
}

/**
 * 字符 → token 粗估。
 * CJK（中日韩统一表意文字，含扩展 A 区）按约 1 token/字；其余非空白按约 4 字符/token。
 * 系数取的是主流模型的中位量级（cl100k 对中文偏高、中文优化模型偏低），不做 per-model 校准。
 */
export function estimateOutputTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isCjkCodePoint(code)) {
      cjk += 1;
    } else if (!/\s/u.test(char)) {
      other += 1;
    }
  }
  return cjk + other / 4;
}

/** CJK 统一表意文字（4E00–9FFF）与扩展 A 区（3400–4DBF）；代理对（扩展 B+）按对计 1 字。 */
function isCjkCodePoint(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

export function createOutputSpeedMeter(
  now: () => number = () => performance.now(),
): OutputSpeedMeter {
  let samples: SpeedSample[] = [];
  /** 过期样本的最左下标（数组只在明显偏斜时才压缩，避免 shift 的 O(n) 逐帧搬移）。 */
  let head = 0;
  /** 累计估算 token（平均速度的分子）。 */
  let totalTokens = 0;
  /** 已结算段的生成时长之和（平均速度的分母之一）。 */
  let closedActiveMs = 0;
  /** 当前生成段起点；null = 尚无输出。 */
  let segmentStart: number | null = null;
  let lastPushAt: number | null = null;

  function settleCurrentSegment(): void {
    if (segmentStart !== null && lastPushAt !== null) {
      closedActiveMs += Math.max(0, lastPushAt - segmentStart);
    }
    segmentStart = null;
  }

  /** 当前平均口径的完整分母（含未结算段），供导出快照与读平均值共用。 */
  function currentTotalActiveMs(): number {
    const openMs =
      segmentStart !== null && lastPushAt !== null ? Math.max(0, lastPushAt - segmentStart) : 0;
    return closedActiveMs + openMs;
  }

  return {
    push(text: string): void {
      if (text.length === 0 || text.length > OUTPUT_SPEED_MAX_FRAME_CHARS) {
        return;
      }
      const tokens = estimateOutputTokens(text);
      if (tokens <= 0) {
        return;
      }
      const t = now();
      if (lastPushAt === null || t - lastPushAt > OUTPUT_SPEED_IDLE_GAP_MS) {
        // 停顿后重新开始：结算上一段，本帧成为新段起点。停顿时间不计入生成时长。
        settleCurrentSegment();
        segmentStart = t;
      }
      lastPushAt = t;
      totalTokens += tokens;
      samples.push({ t, tokens });
      const cutoff = t - OUTPUT_SPEED_SAMPLE_TTL_MS;
      while (head < samples.length && (samples[head]?.t ?? t) < cutoff) {
        head += 1;
      }
      if (head > 256 && head * 2 > samples.length) {
        samples = samples.slice(head);
        head = 0;
      }
    },

    reset(): void {
      samples = [];
      head = 0;
      totalTokens = 0;
      closedActiveMs = 0;
      segmentStart = null;
      lastPushAt = null;
    },

    liveTokensPerSecond(at = now()): number | null {
      const cutoff = at - OUTPUT_SPEED_RATE_WINDOW_MS;
      // 分母：窗口与当前生成段的交集跨度；刚开始输出时用实际跨度（不低估），
      // 窗口填满或输出已停止时由窗口本身兜底（平滑衰减）。
      // 分子必须与分母同段：停顿切段后旧段样本仍在窗口里，混入会虚高。
      const spanStart = Math.max(cutoff, segmentStart ?? cutoff);
      let sum = 0;
      for (let index = head; index < samples.length; index += 1) {
        const sample = samples[index];
        if (!sample || sample.t < spanStart) {
          continue;
        }
        sum += sample.tokens;
      }
      if (sum <= 0) {
        return null;
      }
      const spanMs = Math.max(OUTPUT_SPEED_MIN_SPAN_MS, at - spanStart);
      return Math.min(OUTPUT_SPEED_MAX_TPS, sum / (spanMs / 1000));
    },

    averageTokensPerSecond(): number | null {
      if (totalTokens <= 0) {
        return null;
      }
      const totalMs = currentTotalActiveMs();
      if (totalMs <= 0) {
        return null;
      }
      return totalTokens / (totalMs / 1000);
    },

    snapshotAverage(): OutputSpeedAverageSnapshot | null {
      if (totalTokens <= 0) {
        return null;
      }
      const totalMs = currentTotalActiveMs();
      if (totalMs <= 0) {
        return null;
      }
      return { totalTokens, totalActiveMs: totalMs };
    },

    restoreAverage(snapshot: OutputSpeedAverageSnapshot | null): void {
      // 先整体清空（含实时样本与生成段）：恢复的只是平均口径，不把旧实时样本带回来。
      samples = [];
      head = 0;
      segmentStart = null;
      lastPushAt = null;
      if (!snapshot || snapshot.totalTokens <= 0 || snapshot.totalActiveMs <= 0) {
        totalTokens = 0;
        closedActiveMs = 0;
        return;
      }
      totalTokens = snapshot.totalTokens;
      closedActiveMs = snapshot.totalActiveMs;
    },

    hasRecentActivity(withinMs = OUTPUT_SPEED_RATE_WINDOW_MS * 2, at = now()): boolean {
      return lastPushAt !== null && at - lastPushAt <= withinMs;
    },
  };
}
