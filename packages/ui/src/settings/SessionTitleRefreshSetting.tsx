import { useEffect, useState } from "react";
import type { AppSettings } from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsCommitOnReleaseRange, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 会话标题自动刷新设置卡（本地定制，规则见 specs/session-title-auto-refresh.md）。
 * 三个字段平铺存于 AppSettings，修改经 useSettings().update 落盘并即时推送给
 * Agent 进程（热更新：改动对下一轮完成时的触发判断生效，不补跑历史）。
 */

export function SessionTitleRefreshSetting() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const enabled = settings?.sessionTitleRefreshEnabled !== false;
  const submittedFirstRound = settings?.sessionTitleRefreshFirstRound ?? 3;
  const submittedInterval = settings?.sessionTitleRefreshInterval ?? 5;
  const [draftFirstRound, setDraftFirstRound] = useState<number | null>(null);
  const [draftInterval, setDraftInterval] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // 设置快照更新（本地提交结果或其它窗口广播）后丢弃草稿，界面以已保存值为准。
  useEffect(() => {
    setDraftFirstRound(null);
  }, [submittedFirstRound]);
  useEffect(() => {
    setDraftInterval(null);
  }, [submittedInterval]);

  const firstRoundValue = draftFirstRound ?? submittedFirstRound;
  const intervalValue = draftInterval ?? submittedInterval;

  const savePatch = async (patch: Partial<AppSettings>) => {
    setSaving(true);
    try {
      await update(patch);
    } catch (error) {
      // 提交失败回退草稿：界面回到已保存值，不停留在未保存状态。
      setDraftFirstRound(null);
      setDraftInterval(null);
      logger.warn("[settings] 更新会话标题自动刷新失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.sessionTitleRefresh.saveError" }));
    } finally {
      setSaving(false);
    }
  };

  const commitFirstRound = () => {
    const next = draftFirstRound;
    if (next === null || next === submittedFirstRound) {
      return;
    }
    void savePatch({ sessionTitleRefreshFirstRound: next });
  };
  const commitInterval = () => {
    const next = draftInterval;
    if (next === null || next === submittedInterval) {
      return;
    }
    void savePatch({ sessionTitleRefreshInterval: next });
  };

  const ruleText = enabled
    ? intl.formatMessage(
        { id: "settings.sessionTitleRefresh.rule" },
        { firstRound: String(firstRoundValue), interval: String(intervalValue) },
      )
    : intl.formatMessage({ id: "settings.sessionTitleRefresh.ruleDisabled" });

  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.sessionTitleRefresh" })}
        description={intl.formatMessage({ id: "settings.sessionTitleRefresh.description" })}
        control={
          <Switch
            checked={enabled}
            disabled={!settings || saving}
            onCheckedChange={(checked) => void savePatch({ sessionTitleRefreshEnabled: checked })}
            aria-label={intl.formatMessage({ id: "settings.sessionTitleRefresh" })}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.sessionTitleRefresh.firstRound" })}
        description={intl.formatMessage({
          id: "settings.sessionTitleRefresh.firstRoundDescription",
        })}
        control={
          <SettingsCommitOnReleaseRange
            value={firstRoundValue}
            min={1}
            max={50}
            onChange={setDraftFirstRound}
            onCommit={commitFirstRound}
            valueLabel={firstRoundValue}
            ariaLabel={intl.formatMessage({ id: "settings.sessionTitleRefresh.firstRound" })}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.sessionTitleRefresh.interval" })}
        description={intl.formatMessage({
          id: "settings.sessionTitleRefresh.intervalDescription",
        })}
        control={
          <SettingsCommitOnReleaseRange
            value={intervalValue}
            min={1}
            max={100}
            onChange={setDraftInterval}
            onCommit={commitInterval}
            valueLabel={intervalValue}
            ariaLabel={intl.formatMessage({ id: "settings.sessionTitleRefresh.interval" })}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.sessionTitleRefresh.currentRule" })}
        control={<span className="text-ui-base text-foreground-subtle">{ruleText}</span>}
      />
    </>
  );
}