import { useMemo } from "react";
import { TID_V4_COMPOSER_SESSION_STATS } from "@zcode/shared";
import { GaugeIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSessionDebug } from "@/hooks/useSessionDebug.js";
import {
  formatSessionDurationLabel,
  formatTpsLabel,
  resolveSessionStats,
} from "@/v4/composer/sessionStats.js";

interface ComposerSessionStatsPanelProps {
  enabled: boolean;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 读投影窗口内 turnHeader 的工具时长合计；ref 读取，不把 snapshot 带进工具栏 memo。 */
  readToolDurationMs: () => number | null;
}

/**
 * "会话统计"弹窗内容（本地定制，specs/composer-output-speed.md）：
 * 模型用时 / 工具调用用时 / 首 token 平均（TTFT）/ 输出速度（TPS）。
 * 数据来自 session-debug 旁路的逐请求读数（打开期间 1 秒轮询）与投影里的 turnHeader 工具时长；
 * 缺失项显示占位符。只在弹窗打开时挂载，不打开不产生任何轮询。
 */
export function ComposerSessionStatsPanel({
  enabled,
  sessionId,
  workspacePath,
  workspaceIdentity,
  readToolDurationMs,
}: ComposerSessionStatsPanelProps) {
  const { intl, locale } = useZCodeIntl();
  const debug = useSessionDebug({
    workspacePath,
    workspaceIdentity,
    taskId: sessionId,
    enabled,
  });
  // 工具时长在打开期间随投影推进刷新：session-debug 每秒更新触发重渲染时一并重读。
  const summary = useMemo(
    () => resolveSessionStats(debug.rounds, readToolDurationMs()),
    [debug.rounds, readToolDurationMs],
  );
  const rows = [
    {
      key: "modelDuration",
      labelId: "chat.composerOutputSpeed.stats.modelDuration",
      value: formatSessionDurationLabel(summary.modelDurationMs, locale),
    },
    {
      key: "toolDuration",
      labelId: "chat.composerOutputSpeed.stats.toolDuration",
      value: formatSessionDurationLabel(summary.toolDurationMs, locale),
    },
    {
      key: "ttft",
      labelId: "chat.composerOutputSpeed.stats.ttft",
      value: formatSessionDurationLabel(summary.avgTimeToFirstTokenMs, locale),
    },
    {
      key: "tps",
      labelId: "chat.composerOutputSpeed.stats.tps",
      value: formatTpsLabel(summary.outputTps),
    },
  ];
  return (
    <div className="w-64 space-y-2" data-testid={TID_V4_COMPOSER_SESSION_STATS}>
      <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
        <GaugeIcon className="size-4 shrink-0" aria-hidden="true" />
        {intl.formatMessage({ id: "chat.composerOutputSpeed.stats.title" })}
      </div>
      <div className="space-y-1.5 border-t border-[var(--color-border)] pt-2">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-3 text-ui-sm">
            <span className="text-foreground-subtle">
              {intl.formatMessage({ id: row.labelId })}
            </span>
            <span className="shrink-0 font-mono text-ui-sm tabular-nums text-foreground">
              {row.value ?? "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
