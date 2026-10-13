import { useEffect, useState } from "react";
import { Cat } from "lucide-react";
import { DESKTOP_PET_SCALE_MAX, DESKTOP_PET_SCALE_MIN } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import type { DesktopPetsController } from "@/hooks/useDesktopPets.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PetPreview } from "@/settings/PetPreview.js";
import { PetErrorNotice, PetLoadingNotice } from "@/settings/PetOperationStatus.js";
import {
  SettingsCommitOnReleaseRange,
  SettingsGroupCard,
  SettingsRow,
} from "@/settings/SettingsPageParts.js";

/**
 * 大小滑条（三期）：拖动中只改本地草稿，释放才提交写盘（与标题刷新滑条同模式）。
 * 提交后的快照更新（本地或其它窗口广播）会丢弃草稿，界面以已保存值为准。
 */
function DesktopPetScaleControl({ pets }: { pets: DesktopPetsController }) {
  const { intl } = useZCodeIntl();
  const submitted = pets.scale;
  const [draft, setDraft] = useState<number | null>(null);

  useEffect(() => {
    setDraft(null);
  }, [submitted]);

  const value = draft ?? submitted;
  const commit = () => {
    if (draft === null || draft === submitted) {
      return;
    }
    void pets.setScale(draft);
  };

  return (
    <SettingsCommitOnReleaseRange
      value={value}
      min={DESKTOP_PET_SCALE_MIN}
      max={DESKTOP_PET_SCALE_MAX}
      step={0.05}
      onChange={setDraft}
      onCommit={commit}
      valueLabel={`${Math.round(value * 100)}%`}
      ariaLabel={intl.formatMessage({ id: "settings.desktopPet.scale" })}
    />
  );
}

/** 独立 Pets 首页；宠物设置与所有平台调用统一交给 useDesktopPets，不再出现在常规页。 */
export function DesktopPetSetting({
  pets,
  onManage,
}: {
  pets: DesktopPetsController;
  onManage: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { activePet } = pets;
  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPet" })}
        description={intl.formatMessage({ id: "settings.desktopPet.description" })}
        controlLayout="compact"
        control={
          <Switch
            checked={pets.enabled}
            disabled={pets.busy || !pets.settingsReady || pets.settingsLoading}
            onCheckedChange={(checked) => void pets.setEnabled(checked)}
            aria-label={intl.formatMessage({ id: "settings.desktopPet" })}
          />
        }
        detail={
          pets.settingsLoading && !pets.settingsReady ? (
            <PetLoadingNotice messageId="settings.desktopPet.settingsLoading" />
          ) : undefined
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPet.scale" })}
        description={intl.formatMessage({ id: "settings.desktopPet.scaleDescription" })}
        control={<DesktopPetScaleControl pets={pets} />}
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPet.activePet" })}
        description={
          activePet ? `${activePet.displayName} · v${activePet.spriteVersionNumber}` : undefined
        }
        controlLayout="compact"
        control={
          <Button type="button" variant="outline" size="lg" onClick={onManage}>
            <Cat aria-hidden="true" />
            {intl.formatMessage({ id: "settings.desktopPet.manage" })}
          </Button>
        }
      />
      <div className="space-y-3 px-4 pb-4" data-testid="desktop-pets-current">
        <PetErrorNotice error={pets.installedError} onRetry={() => void pets.refreshInstalled()} />
        {pets.installedLoading ? (
          <PetLoadingNotice messageId="settings.desktopPet.installedLoading" />
        ) : null}
        {activePet ? (
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <PetPreview
              kind="atlas"
              src={activePet.previewUrl}
              name={activePet.displayName}
              spriteVersionNumber={activePet.spriteVersionNumber}
              className="size-24 shrink-0 rounded-lg"
            />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="break-words text-ui-base font-medium text-foreground">
                {activePet.displayName}
              </div>
              <div className="break-all text-ui-sm text-foreground-subtle">{activePet.id}</div>
            </div>
          </div>
        ) : !pets.installedLoading && !pets.installedError ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({
              id: pets.installed.length
                ? "settings.desktopPet.activeMissing"
                : "settings.desktopPet.installedEmpty",
            })}
          </p>
        ) : null}
      </div>
    </SettingsGroupCard>
  );
}
