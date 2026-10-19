import { useEffect, useState } from "react";
import { formatModelPickerValue, parseModelPickerValue, type AppSettings } from "@zcode/shared";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsCommitOnReleaseRange, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 会话标题自动刷新设置卡（本地定制，规则见 specs/session-title-auto-refresh.md）。
 * 刷新参数字段平铺存于 AppSettings，修改经 useSettings().update 落盘并即时推送给
 * Agent 进程（热更新：改动对下一轮完成时的触发判断生效，不补跑历史）。
 * 「标题生成模型」用文本输入 `provider/model[ $推理档位 ]`：留空 = 跟随会话当前模型，
 * 用于绕开不接受辅助调用最低推理档的模型（见 spec「标题生成模型（可选指定）」）。
 */

export function SessionTitleRefreshSetting() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const enabled = settings?.sessionTitleRefreshEnabled !== false;
  const submittedFirstRound = settings?.sessionTitleRefreshFirstRound ?? 3;
  const submittedInterval = settings?.sessionTitleRefreshInterval ?? 5;
  const submittedModelValue = formatModelPickerValue(
    settings?.sessionTitleModelSelection ?? undefined,
  );
  const [draftFirstRound, setDraftFirstRound] = useState<number | null>(null);
  const [draftInterval, setDraftInterval] = useState<number | null>(null);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [modelInvalid, setModelInvalid] = useState(false);
  const [saving, setSaving] = useState(false);

  // 设置快照更新（本地提交结果或其它窗口广播）后丢弃草稿，界面以已保存值为准。
  useEffect(() => {
    setDraftFirstRound(null);
  }, [submittedFirstRound]);
  useEffect(() => {
    setDraftInterval(null);
  }, [submittedInterval]);
  useEffect(() => {
    setDraftModel(null);
    setModelInvalid(false);
  }, [submittedModelValue]);

  const firstRoundValue = draftFirstRound ?? submittedFirstRound;
  const intervalValue = draftInterval ?? submittedInterval;
  const modelValue = draftModel ?? submittedModelValue;

  const savePatch = async (patch: Partial<AppSettings>) => {
    setSaving(true);
    try {
      await update(patch);
    } catch (error) {
      // 提交失败回退草稿：界面回到已保存值，不停留在未保存状态。
      setDraftFirstRound(null);
      setDraftInterval(null);
      setDraftModel(null);
      setModelInvalid(false);
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
  const commitModel = () => {
    if (saving || draftModel === null) {
      return;
    }
    const raw = draftModel.trim();
    if (raw === submittedModelValue) {
      // 未实际修改：清掉草稿与错误态，不发保存请求。
      setDraftModel(null);
      setModelInvalid(false);
      return;
    }
    if (raw === "") {
      // 留空 = 跟随会话当前模型：显式提交 null（替换式提交，浅合并不会误留旧模型）。
      setModelInvalid(false);
      void savePatch({ sessionTitleModelSelection: null });
      return;
    }
    try {
      const selection = parseModelPickerValue(raw);
      setModelInvalid(false);
      void savePatch({ sessionTitleModelSelection: selection });
    } catch {
      // 解析失败不提交、不弹 toast：保留输入并给出行内提示，等用户修正。
      setModelInvalid(true);
    }
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
        label={intl.formatMessage({ id: "settings.sessionTitleRefresh.model" })}
        description={intl.formatMessage({ id: "settings.sessionTitleRefresh.modelDescription" })}
        control={
          <Input
            size="sm"
            value={modelValue}
            disabled={!settings || saving}
            placeholder={intl.formatMessage({
              id: "settings.sessionTitleRefresh.modelPlaceholder",
            })}
            aria-label={intl.formatMessage({ id: "settings.sessionTitleRefresh.model" })}
            aria-invalid={modelInvalid || undefined}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            onChange={(event) => {
              setDraftModel(event.target.value);
              setModelInvalid(false);
            }}
            onBlur={commitModel}
            onKeyDown={(event) => {
              if (event.key !== "Enter") {
                return;
              }
              event.preventDefault();
              // 统一走失焦提交，避免 Enter 与紧随其后的 blur 各提交一次。
              event.currentTarget.blur();
            }}
          />
        }
        detail={
          modelInvalid ? (
            <div className="text-ui-base text-destructive">
              {intl.formatMessage({ id: "settings.sessionTitleRefresh.modelInvalid" })}
            </div>
          ) : undefined
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.sessionTitleRefresh.currentRule" })}
        control={<span className="text-ui-base text-foreground-subtle">{ruleText}</span>}
      />
    </>
  );
}
