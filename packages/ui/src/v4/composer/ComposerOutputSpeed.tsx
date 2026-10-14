import { memo, useEffect, useReducer, useState } from "react";
import { TID_V4_COMPOSER_OUTPUT_SPEED } from "@zcode/shared";
import { GaugeIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ComposerSessionStatsPanel } from "@/v4/composer/ComposerSessionStatsPanel.js";
import { OUTPUT_SPEED_RATE_WINDOW_MS, type OutputSpeedMeter } from "@/v4/outputSpeedMeter.js";

/** 状态标签刷新间隔：数字按秒级节奏跳动即可，避免随每个 token 批次重渲染。 */
const REFRESH_INTERVAL_MS = 1_000;
/** 最近活动判定窗口：超过该时长没有新输出，实时数字已归零，停止空转刷新。 */
const ACTIVITY_TAIL_MS = OUTPUT_SPEED_RATE_WINDOW_MS * 2;

/** 会话统计面板的数据源（由 ConversationComposer 组装；字段保持稳定引用以不击穿工具栏 memo）。 */
export interface ComposerOutputSpeedStatsSource {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 读投影窗口内 turnHeader 的工具时长合计。 */
  readToolDurationMs: () => number | null;
}

interface ComposerOutputSpeedProps {
  /** 会话输出速度计量器；无会话 lease 时为 null。 */
  meter: OutputSpeedMeter | null;
  /** 统计面板数据源；null 时标签只展示数值、不可展开（如草稿会话）。 */
  stats?: ComposerOutputSpeedStatsSource | null;
}

/**
 * 输入框工具栏内的输出速度标签（本地定制，specs/composer-output-speed.md）：
 * 「实时 xx tok/s · 平均 xx tok/s」，紧靠上下文图标、与模型/思考深度同一行；
 * 点击展开"会话统计"（模型用时 / 工具调用用时 / TTFT / TPS）。
 * 无任何输出数据时不渲染（不占位），会话一旦有输出即保持显示最近数值。
 * 口径与误差说明见 outputSpeedMeter.ts。
 */
function ComposerOutputSpeedImpl({ meter, stats = null }: ComposerOutputSpeedProps) {
  const { intl } = useZCodeIntl();
  const [, forceRender] = useReducer((count: number) => count + 1, 0);
  const [statsOpen, setStatsOpen] = useState(false);
  // 实时数字需要随"窗口滑过而没有新输出"自然衰减到零；按秒 tick 驱动重算。
  // 计量器里最近 ACTIVITY_TAIL_MS 无输出后不再触发渲染，空闲会话不产生无谓重渲染。
  useEffect(() => {
    if (!meter) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      if (meter.hasRecentActivity(ACTIVITY_TAIL_MS)) {
        forceRender();
      }
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [meter]);

  if (!meter) {
    return null;
  }
  const live = meter.liveTokensPerSecond();
  const average = meter.averageTokensPerSecond();
  if (live === null && average === null) {
    return null;
  }
  const liveLabel = intl.formatMessage({ id: "chat.composerOutputSpeed.live" });
  const averageLabel = intl.formatMessage({ id: "chat.composerOutputSpeed.average" });
  const trigger = (
    <button
      type="button"
      data-testid={TID_V4_COMPOSER_OUTPUT_SPEED}
      title={intl.formatMessage({ id: "chat.composerOutputSpeed.hint" })}
      className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-ui-sm text-foreground-subtle transition-colors hover:bg-[var(--color-surface-hover)] hover:text-foreground"
    >
      <GaugeIcon className="size-3.5 shrink-0" aria-hidden="true" />
      {live !== null ? (
        <span className="whitespace-nowrap">
          {liveLabel} <span className="font-mono tabular-nums">{Math.round(live)}</span> tok/s
        </span>
      ) : null}
      {live !== null && average !== null ? <span aria-hidden="true">·</span> : null}
      {average !== null ? (
        <span className="whitespace-nowrap">
          {averageLabel} <span className="font-mono tabular-nums">{Math.round(average)}</span> tok/s
        </span>
      ) : null}
    </button>
  );
  if (!stats) {
    return trigger;
  }
  return (
    <Popover open={statsOpen} onOpenChange={setStatsOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-auto p-3">
        {statsOpen ? <ComposerSessionStatsPanel enabled {...stats} /> : null}
      </PopoverContent>
    </Popover>
  );
}

export const ComposerOutputSpeed = memo(ComposerOutputSpeedImpl);
