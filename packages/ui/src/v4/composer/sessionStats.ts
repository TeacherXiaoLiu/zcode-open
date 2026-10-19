// 会话统计聚合（本地定制，specs/composer-output-speed.md）：
// 把 session-debug 快照的逐请求读数与 v4 turnHeader 的工具时长，汇成"会话统计"面板的四个指标。
// 口径：
//   - 模型用时 = Σ 每个主轮模型请求的总时长 durationMs（含首 token 等待）；
//   - 工具调用用时 = Σ turnHeader.toolDurationMs（CLI 已按轮做工具区间并集）；
//   - 首 token 平均（TTFT）= avg(timeToFirstContentMs)；仅统计有值的请求；
//   - 输出速度（TPS）= (Σ outputTokens − 计入请求数) ÷ Σ generationDurationMs
//     （与调试面板 calculateOutputTps 同一口径：分母已排除首 token 等待，分子同源扣除各请求
//     的首个 token；只统计两个字段同时存在的请求，避免分子分母来自不同的轮集合）。
import type { SessionDebugRound } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

export interface SessionStatsSummary {
  modelDurationMs: number | null;
  toolDurationMs: number | null;
  avgTimeToFirstTokenMs: number | null;
  outputTps: number | null;
}

export function resolveSessionStats(
  rounds: readonly SessionDebugRound[],
  toolDurationMs: number | null,
): SessionStatsSummary {
  let modelDurationMs: number | null = null;
  let ttftSum = 0;
  let ttftCount = 0;
  let outputTokens = 0;
  let generationDurationMs = 0;
  /** 同时具备 outputTokens 与 generationDurationMs 的请求数（分子要扣掉各自的首个 token）。 */
  let tpsRoundCount = 0;
  for (const round of rounds) {
    // 用 typeof 判定而非 !== null：字段缺省（undefined）时同样跳过，不产生 NaN。
    if (typeof round.durationMs === "number") {
      modelDurationMs = (modelDurationMs ?? 0) + round.durationMs;
    }
    if (typeof round.timeToFirstContentMs === "number") {
      ttftSum += round.timeToFirstContentMs;
      ttftCount += 1;
    }
    // 分子分母必须同源：只有两字段都存在的轮才参与 TPS，否则是两组不同请求的比值。
    if (
      typeof round.usage.outputTokens === "number" &&
      typeof round.generationDurationMs === "number"
    ) {
      outputTokens += round.usage.outputTokens;
      generationDurationMs += round.generationDurationMs;
      tpsRoundCount += 1;
    }
  }
  const decodeTokens = outputTokens - tpsRoundCount;
  return {
    modelDurationMs,
    toolDurationMs,
    avgTimeToFirstTokenMs: ttftCount > 0 ? ttftSum / ttftCount : null,
    outputTps:
      generationDurationMs > 0 && decodeTokens > 0
        ? (decodeTokens * 1000) / generationDurationMs
        : null,
  };
}

/** 从投影窗口内的全部 turnHeader 行汇总工具时长；窗口内没有带工具耗时的轮时为 null。 */
export function resolveSessionToolDurationMs(snapshot: ConversationSnapshot | null): number | null {
  if (!snapshot) {
    return null;
  }
  let total: number | null = null;
  for (const row of snapshot.rows.window) {
    if (row.kind !== "turnHeader" || typeof row.toolDurationMs !== "number") {
      continue;
    }
    total = (total ?? 0) + row.toolDurationMs;
  }
  return total;
}

/**
 * 时长展示：满 1 分钟用「X分Y秒」/「Xm Ys」；不足 1 分钟用一位小数秒（「8.9秒」/「8.9s」）。
 * null（数据缺失）返回 null，由调用方渲染占位符。
 */
export function formatSessionDurationLabel(
  durationMs: number | null,
  locale: string | null | undefined,
): string | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  const chinese = (locale ?? "").toLowerCase().startsWith("zh");
  // 先按整秒取判定边界：59.9s 进位到「1分0秒」，避免出现「60.0秒」。
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    const seconds = (durationMs / 1000).toFixed(1);
    return chinese ? `${seconds}秒` : `${seconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return chinese ? `${minutes}分${seconds}秒` : `${minutes}m ${seconds}s`;
}

/** 速度展示：整数 tok/s；null 返回 null。 */
export function formatTpsLabel(tps: number | null): string | null {
  if (tps === null || !Number.isFinite(tps) || tps < 0) {
    return null;
  }
  return `${Math.round(tps)} tok/s`;
}
