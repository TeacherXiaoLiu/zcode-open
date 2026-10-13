import { useCallback, useEffect, useState } from "react";
import type { DesktopPetInstalledInfo } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 桌面宠物设置卡（本地定制，specs/desktop/desktop-pet.md）。
 * 仅桌面端渲染（platform.desktopPet 缺失时返回 null）。开关走 useSettings().update
 * （落盘 + 即时同步 main）；宠物列表/切换走平台端口，main 持久化 desktopPetId
 * 并热重建宠物窗口。
 */
export function DesktopPetSetting() {
  const { intl } = useZCodeIntl();
  const { settings, update, refresh } = useSettings();
  const platform = usePlatform();
  const port = platform.desktopPet;
  const [pets, setPets] = useState<DesktopPetInstalledInfo[]>([]);
  const [saving, setSaving] = useState(false);

  const enabled = settings?.desktopPetEnabled === true;
  const activePetId = settings?.desktopPetId?.trim() ?? "";

  const refreshPets = useCallback(async () => {
    if (!port) {
      return;
    }
    try {
      setPets(await port.listInstalled());
    } catch (error) {
      logger.warn("[settings] 读取桌宠目录失败", { error: String(error) });
    }
  }, [port]);

  // 开启后才需要列表（关闭时下拉不渲染，也不必触碰宠物目录）。
  useEffect(() => {
    if (enabled) {
      void refreshPets();
    }
  }, [enabled, refreshPets]);

  if (!port) {
    return null;
  }

  const effectivePetId = activePetId || (pets[0]?.id ?? "");

  const handleEnabledChange = async (checked: boolean) => {
    setSaving(true);
    try {
      await update({ desktopPetEnabled: checked });
    } catch (error) {
      logger.warn("[settings] 更新桌宠开关失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.desktopPet.saveError" }));
    } finally {
      setSaving(false);
    }
  };

  const handlePetChange = async (petId: string) => {
    setSaving(true);
    try {
      await port.setActive(petId);
      // desktopPetId 由 main 写盘；刷新快照让下拉显示与持久值一致。
      await refresh();
      void refreshPets();
    } catch (error) {
      logger.warn("[settings] 切换桌宠失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.desktopPet.saveError" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPet" })}
        description={intl.formatMessage({ id: "settings.desktopPet.description" })}
        control={
          <Switch
            checked={enabled}
            disabled={saving || !settings}
            onCheckedChange={(checked) => void handleEnabledChange(checked)}
            aria-label={intl.formatMessage({ id: "settings.desktopPet" })}
          />
        }
      />
      {enabled && pets.length > 0 ? (
        <SettingsRow
          label={intl.formatMessage({ id: "settings.desktopPet.activePet" })}
          description={intl.formatMessage({ id: "settings.desktopPet.activePetDescription" })}
          control={
            <Select
              value={effectivePetId}
              onValueChange={(value) => void handlePetChange(value)}
              disabled={saving}
            >
              <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pets.map((pet) => (
                  <SelectItem key={pet.id} value={pet.id}>
                    {pet.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      ) : null}
    </>
  );
}