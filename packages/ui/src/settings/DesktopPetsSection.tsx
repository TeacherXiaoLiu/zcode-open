import { useState } from "react";
import type { DesktopPetInstalledInfo, DesktopPetMarketItem } from "@zcode/shared";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useDesktopPets, type DesktopPetsController } from "@/hooks/useDesktopPets.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DesktopPetSetting } from "./DesktopPetSetting.js";
import { InstalledPetCard, MarketPetCard } from "./PetCards.js";
import { PetDeleteDialog, PetMarketInstallDialog } from "./PetConfirmationDialogs.js";
import { PetImportDialog } from "./PetImportDialog.js";
import { PetErrorNotice, PetLoadingNotice, PetOperationStatus } from "./PetOperationStatus.js";
import { SettingsBreadcrumbReporter } from "./SettingsHeaderBreadcrumb.js";
import { SettingsGroupCard } from "./SettingsPageParts.js";
import { SettingsSearchInput } from "./SettingsSearchInput.js";

/** 唯一的页面内导航状态；breadcrumb 只投影返回动作，平台业务状态统一经 hook 读取。 */
export function DesktopPetsSection() {
  const { intl } = useZCodeIntl();
  const [managing, setManaging] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [marketPet, setMarketPet] = useState<DesktopPetMarketItem | null>(null);
  const [deletePet, setDeletePet] = useState<DesktopPetInstalledInfo | null>(null);
  const pets = useDesktopPets({ showMarket: managing });
  if (!pets.available) return null;
  const dialogOpen = importOpen || Boolean(marketPet || deletePet);
  return (
    <div className="min-w-0 space-y-4" data-testid="desktop-pets-section">
      {managing ? (
        <SettingsBreadcrumbReporter
          items={[{ label: intl.formatMessage({ id: "settings.desktopPet.managementTitle" }) }]}
          onSectionSelect={() => setManaging(false)}
        />
      ) : null}
      <PetErrorNotice error={pets.settingsError} onRetry={() => void pets.refreshSettings()} />
      {!dialogOpen ? (
        <>
          <PetErrorNotice error={pets.actionError} />
          <PetOperationStatus
            operation={pets.operation}
            noticeId={pets.noticeId}
            onCancel={pets.cancelOperation}
          />
          {pets.busy && !pets.operation ? (
            <PetLoadingNotice messageId="settings.desktopPet.saving" />
          ) : null}
        </>
      ) : null}
      {managing ? (
        <>
          <SettingsGroupCard>
            <section
              className="min-w-0 space-y-4 p-4"
              aria-labelledby="desktop-pets-installed-title"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="desktop-pets-installed-title" className="text-ui-base font-medium">
                  {intl.formatMessage({ id: "settings.desktopPet.installed" })}
                </h2>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  disabled={pets.busy}
                  onClick={() => {
                    pets.clearActionError();
                    pets.clearImportReview();
                    setImportOpen(true);
                  }}
                >
                  <Download aria-hidden="true" />
                  {intl.formatMessage({ id: "settings.desktopPet.import" })}
                </Button>
              </div>
              <PetErrorNotice
                error={pets.installedError}
                onRetry={() => void pets.refreshInstalled()}
              />
              {pets.installedLoading ? (
                <PetLoadingNotice messageId="settings.desktopPet.installedLoading" />
              ) : null}
              {!pets.installed.length && !pets.installedLoading && !pets.installedError ? (
                <p role="status" className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.desktopPet.installedEmpty" })}
                </p>
              ) : null}
              <div
                className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,10rem),1fr))] gap-3"
                data-testid="installed-pets-grid"
              >
                {pets.installed.map((pet) => (
                  <InstalledPetCard
                    key={pet.id}
                    pet={pet}
                    active={pets.activePetId === pet.id}
                    disabled={pets.busy || pets.settingsLoading || !pets.settingsReady}
                    onUse={() => void pets.setActive(pet.id)}
                    onDelete={() => {
                      pets.clearActionError();
                      setDeletePet(pet);
                    }}
                  />
                ))}
              </div>
            </section>
          </SettingsGroupCard>
          <PetMarketSection
            pets={pets}
            onInstall={(pet) => {
              pets.clearActionError();
              setMarketPet(pet);
            }}
          />
        </>
      ) : (
        <DesktopPetSetting pets={pets} onManage={() => setManaging(true)} />
      )}
      {importOpen ? <PetImportDialog pets={pets} onClose={() => setImportOpen(false)} /> : null}
      {marketPet ? (
        <PetMarketInstallDialog
          key={marketPet.id}
          pet={marketPet}
          pets={pets}
          onClose={() => setMarketPet(null)}
        />
      ) : null}
      {deletePet ? (
        <PetDeleteDialog pet={deletePet} pets={pets} onClose={() => setDeletePet(null)} />
      ) : null}
    </div>
  );
}

function PetMarketSection({
  pets,
  onInstall,
}: {
  pets: DesktopPetsController;
  onInstall: (pet: DesktopPetMarketItem) => void;
}) {
  const { intl } = useZCodeIntl();
  const [query, setQuery] = useState(pets.marketQuery);
  const categories = [
    ...new Set([
      ...(pets.marketPage?.categories ?? []),
      ...(pets.marketCategory ? [pets.marketCategory] : []),
    ]),
  ];
  return (
    <section className="min-w-0 space-y-4" aria-labelledby="desktop-pets-market-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="desktop-pets-market-title" className="text-ui-base font-medium">
          {intl.formatMessage({ id: "settings.desktopPet.market" })}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="lg"
          disabled={pets.marketLoading || pets.busy}
          onClick={() => void pets.refreshMarket()}
        >
          <RefreshCw aria-hidden="true" />
          {intl.formatMessage({ id: "settings.desktopPet.refresh" })}
        </Button>
      </div>
      <form
        className="flex min-w-0 flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void pets.searchMarket(query, pets.marketCategory);
        }}
      >
        <SettingsSearchInput
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          containerClassName="min-w-0 flex-1 basis-52"
          className="rounded-lg"
          placeholder={intl.formatMessage({ id: "settings.desktopPet.market.searchPlaceholder" })}
          aria-label={intl.formatMessage({ id: "settings.desktopPet.market.search" })}
          disabled={pets.busy}
        />
        <Select
          value={pets.marketCategory || "all"}
          disabled={pets.busy}
          onValueChange={(value) => void pets.searchMarket(query, value === "all" ? "" : value)}
        >
          <SelectTrigger
            size="lg"
            className="min-w-0 max-w-full flex-1 basis-40"
            aria-label={intl.formatMessage({ id: "settings.desktopPet.market.category" })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {intl.formatMessage({ id: "settings.desktopPet.market.allCategories" })}
            </SelectItem>
            {categories.map((category) => (
              <SelectItem key={category} value={category}>
                {category}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" variant="outline" size="lg" disabled={pets.busy}>
          {intl.formatMessage({ id: "settings.desktopPet.market.search" })}
        </Button>
      </form>
      <PetErrorNotice error={pets.marketError} onRetry={() => void pets.refreshMarket()} />
      {pets.marketLoading ? (
        <PetLoadingNotice messageId="settings.desktopPet.marketLoading" />
      ) : null}
      {pets.marketPage &&
      !pets.marketPage.items.length &&
      !pets.marketLoading &&
      !pets.marketError ? (
        <p role="status" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.desktopPet.market.empty" })}
        </p>
      ) : null}
      <div
        className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,10rem),1fr))] gap-3"
        data-testid="market-pets-grid"
        aria-busy={pets.marketLoading}
      >
        {pets.marketPage?.items.map((pet) => (
          <MarketPetCard
            key={pet.id}
            pet={pet}
            installed={pet.installed || pets.installed.some((installed) => installed.id === pet.id)}
            disabled={pets.busy || pets.marketLoading}
            onInstall={() => onInstall(pet)}
          />
        ))}
      </div>
      {pets.marketPage ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-ui-sm text-foreground-subtle">
          <span>
            {intl.formatMessage(
              { id: "settings.desktopPet.market.page" },
              { page: pets.marketPageIndex + 1, total: pets.marketPage.total },
            )}
          </span>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pets.marketLoading || pets.busy || pets.marketPageIndex === 0}
              onClick={() => void pets.previousMarketPage()}
            >
              {intl.formatMessage({ id: "settings.desktopPet.market.previous" })}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pets.marketLoading || pets.busy || !pets.marketPage.nextCursor}
              onClick={() => void pets.nextMarketPage()}
            >
              {intl.formatMessage({ id: "settings.desktopPet.market.next" })}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
