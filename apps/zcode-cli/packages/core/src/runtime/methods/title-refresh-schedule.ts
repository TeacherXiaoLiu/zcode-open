import type { ModelSelection } from "../deps.js";

/**
 * 会话标题定期刷新——调度纯逻辑（本地定制）。
 *
 * 上游设计里标题只在会话早期由 sidecar 生成一次；这里给同一条生成链补上
 * 「真实用户轮次完成时按绝对网格定期刷新」的调度。触发点对齐绝对网格
 * （firstRound、firstRound+interval、…），只认**正好落在网格上**的完成轮次——
 * 中途改参数、重启、恢复旧会话都不补跑历史，一次重启不会引发一串辅助调用。
 *
 * 本文件只有无副作用的判断与装配：轮次网格、取样选择、输入文本构建。
 * 生成与持久化不在这一层，复用 session-title 既有链路（不新增第二条生成路径）。
 * 规则与验收见 specs/session-title-auto-refresh.md。
 */

export interface SessionTitleRefreshConfig {
  /** 总开关：关闭后行为退回上游（只有早期一次标题生成）。 */
  enabled: boolean;
  /** 首次刷新发生在第几个真实用户轮次完成后。 */
  firstRound: number;
  /** 之后每多少轮刷新一次。 */
  interval: number;
  /** 标题生成模型（可选）：首轮生成 / 定期刷新 / 手动生成统一使用；null/缺席 = 跟随会话当前模型。 */
  modelSelection?: ModelSelection | null;
}

/** 均衡档：与 DSH 生态参考实现（dsh-session-title-refresh）的推荐档一致。 */
export const DEFAULT_SESSION_TITLE_REFRESH: SessionTitleRefreshConfig = {
  enabled: true,
  firstRound: 3,
  interval: 5,
};

/** 取样上限：首条 + 最近若干条（共 8 条）。 */
export const TITLE_REFRESH_SAMPLE_WINDOW = 8;

const HARD_BOUNDS = {
  firstRound: [1, 50],
  interval: [1, 100],
} as const;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  const base = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.min(Math.max(base, min), max);
}

/**
 * 合并多层配置并夹紧（低 → 高优先级；界面保存的层最优先）。
 * 任何非法值都回退到默认档的对应值，绝不把 NaN / 越界值带进调度。
 */
export function normalizeSessionTitleRefreshConfig(
  ...sources: Array<Partial<SessionTitleRefreshConfig> | null | undefined>
): SessionTitleRefreshConfig {
  const read = (key: keyof SessionTitleRefreshConfig): unknown => {
    for (let index = sources.length - 1; index >= 0; index -= 1) {
      const value = sources[index]?.[key];
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  };
  const enabled = read("enabled");
  // 标题生成模型：只透传显式提供的值；null/缺席都不写入（读取方按「跟随会话当前模型」处理）。
  const modelSelection = read("modelSelection") as ModelSelection | undefined;
  return {
    enabled: typeof enabled === "boolean" ? enabled : DEFAULT_SESSION_TITLE_REFRESH.enabled,
    ...(modelSelection ? { modelSelection } : {}),
    firstRound: clampInt(
      read("firstRound"),
      HARD_BOUNDS.firstRound[0],
      HARD_BOUNDS.firstRound[1],
      DEFAULT_SESSION_TITLE_REFRESH.firstRound,
    ),
    interval: clampInt(
      read("interval"),
      HARD_BOUNDS.interval[0],
      HARD_BOUNDS.interval[1],
      DEFAULT_SESSION_TITLE_REFRESH.interval,
    ),
  };
}

/**
 * 当前完成轮次是否正好落在刷新网格上（绝对网格，不补跑）。
 *
 * rounds 是**已完成**的真实用户轮次总数：等于 firstRound，或与 firstRound
 * 相差 interval 的整数倍时为 true。提前于 firstRound 或落在网格点之间都为 false，
 * 因此改参数后只会从"下一个网格点"重新开始，不会追赶历史。
 */
export function isTitleRefreshDueAtRound(
  rounds: number,
  config: SessionTitleRefreshConfig,
): boolean {
  if (!config.enabled) return false;
  if (!Number.isFinite(rounds) || rounds < config.firstRound) return false;
  return (rounds - config.firstRound) % config.interval === 0;
}

/** 人话描述当前规则（设置页当前规则行与日志共用同一语义）。 */
export function describeSessionTitleRefresh(config: SessionTitleRefreshConfig): string {
  const every = config.interval === 1 ? "之后每轮刷新一次" : `之后每 ${config.interval} 轮刷新一次`;
  const body = `第 ${config.firstRound} 轮首次刷新，${every}`;
  return config.enabled ? body : `已停用 · ${body}`;
}

/**
 * 取样：短会话全取；长会话取「首条 + 最近 windowSize-1 条」。
 *
 * 首条给出会话的起点诉求，最近的若干条给出它现在的方向——两者合起来才贴近
 * 「这次对话在干什么」。按出现序返回、不重复。
 */
export function selectTitleRefreshSamples(
  texts: readonly string[],
  windowSize: number = TITLE_REFRESH_SAMPLE_WINDOW,
): string[] {
  const list = texts.filter((text) => text.trim().length > 0);
  const size = Math.max(2, Math.trunc(windowSize) || TITLE_REFRESH_SAMPLE_WINDOW);
  if (list.length <= size) return list;
  return [list[0]!, ...list.slice(list.length - (size - 1))];
}

/** 按字符上限截断，不切断代理对（surrogate pair）。 */
function truncateChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join("");
}

/**
 * 装配送模型的输入文本：JSON 数组（用户文本无法破坏分隔结构），
 * 头部附一行英文说明与 sidecar 的系统提示词风格保持一致。
 *
 * 超预算时先丢中段（保首条与最新一条），再按比例截断每条文本；
 * 首条与最新一条是标题的两根支柱，任何情况下都不丢。
 */
export function buildTitleRefreshInputText(
  samples: readonly string[],
  maxChars: number,
): string {
  const budget = Math.max(128, Math.trunc(maxChars) || 1200);
  const frame = (messages: readonly string[]) =>
    `Session title refresh samples (JSON array of human messages; the first item is the session's opening request, the last items are the most recent):\n${JSON.stringify(messages)}`;

  let selected = samples.filter((text) => text.trim().length > 0);
  if (selected.length === 0) return "";

  let text = frame(selected);
  while (text.length > budget && selected.length > 2) {
    // 丢掉第二条（中段里最老的一条），保住首条与最新一条。
    selected = [selected[0]!, ...selected.slice(2)];
    text = frame(selected);
  }

  if (text.length > budget) {
    const overhead = frame(selected.map(() => "")).length;
    const available = Math.max(0, budget - overhead - 8);
    const perMessage = Math.max(24, Math.floor(available / selected.length));
    selected = selected.map((message) => truncateChars(message, perMessage));
    text = frame(selected);
    if (text.length > budget) text = truncateChars(text, budget);
  }

  return text;
}