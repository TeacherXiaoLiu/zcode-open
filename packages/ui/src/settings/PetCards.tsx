import type {
  DesktopPetInstalledInfo,
  DesktopPetLicenseInfo,
  DesktopPetMarketItem,
} from "@zcode/shared";
import { Trash2 } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PetPreview } from "./PetPreview.js";

export function PetLicense({
  license,
  expanded = false,
}: {
  license: DesktopPetLicenseInfo;
  expanded?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const details = (
    <div className="space-y-1 break-words text-ui-sm text-foreground-subtle">
      <p className="whitespace-pre-wrap">
        {license.text.trim() ||
          intl.formatMessage({ id: "settings.desktopPet.license.unknownText" })}
      </p>
      <p className={license.commercialUse === "allowed" ? "" : "text-warning"}>
        {intl.formatMessage({ id: `settings.desktopPet.license.${license.commercialUse}` })}
      </p>
      {license.attribution ? (
        <p>
          {intl.formatMessage({ id: "settings.desktopPet.license.attribution" })}{" "}
          {license.attribution}
        </p>
      ) : null}
      {license.url ? <p className="break-all">{license.url}</p> : null}
    </div>
  );
  return expanded ? (
    details
  ) : (
    <details className="min-w-0 text-ui-sm text-foreground-subtle">
      <summary className="cursor-pointer break-words">
        {intl.formatMessage({ id: "settings.desktopPet.license" })} ·{" "}
        {intl.formatMessage({ id: `settings.desktopPet.license.badge.${license.commercialUse}` })}
      </summary>
      <div className="mt-2">{details}</div>
    </details>
  );
}

export function resolvePetMarketName(pet: DesktopPetMarketItem, locale: string): string {
  return pet.localizedNames?.[locale]?.trim() || pet.displayName;
}

export function InstalledPetCard({
  pet,
  active,
  disabled,
  onUse,
  onDelete,
}: {
  pet: DesktopPetInstalledInfo;
  active: boolean;
  disabled: boolean;
  onUse: () => void;
  onDelete: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Card
      data-testid="installed-pet-card"
      data-pet-id={pet.id}
      className={cn(
        "min-w-0 gap-3 rounded-lg py-3 shadow-none",
        active && "border-border-hover bg-card-selected",
      )}
    >
      <CardContent className="flex h-full min-w-0 flex-col gap-3 px-3">
        <PetPreview
          kind="atlas"
          src={pet.previewUrl}
          name={pet.displayName}
          spriteVersionNumber={pet.spriteVersionNumber}
          className="rounded-md"
        />
        <div className="min-w-0 space-y-1">
          <h3 className="break-words text-ui-base font-medium">{pet.displayName}</h3>
          <p className="break-words text-ui-sm text-foreground-subtle">
            v{pet.spriteVersionNumber} ·{" "}
            {intl.formatMessage({ id: `settings.desktopPet.source.${pet.source}` })}
          </p>
          <PetLicense license={pet.license} />
        </div>
        <div className="mt-auto flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant={active ? "secondary" : "outline"}
            className="min-w-0 flex-1 rounded-md"
            disabled={disabled || active}
            onClick={onUse}
          >
            {intl.formatMessage({
              id: active ? "settings.desktopPet.inUse" : "settings.desktopPet.use",
            })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="rounded-md text-foreground-subtle hover:text-destructive"
            disabled={disabled || active}
            onClick={onDelete}
            aria-label={intl.formatMessage(
              { id: "settings.desktopPet.deleteNamed" },
              { name: pet.displayName },
            )}
            title={
              active
                ? intl.formatMessage({ id: "settings.desktopPet.error.activeDelete" })
                : undefined
            }
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
        {active ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.desktopPet.activeDeleteHint" })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function MarketPetCard({
  pet,
  installed,
  disabled,
  onInstall,
}: {
  pet: DesktopPetMarketItem;
  installed: boolean;
  disabled: boolean;
  onInstall: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const name = resolvePetMarketName(pet, locale);
  return (
    <Card
      data-testid="market-pet-card"
      data-pet-id={pet.id}
      className="min-w-0 gap-3 py-3 shadow-none"
    >
      <CardContent className="flex h-full min-w-0 flex-col gap-3 px-3">
        <PetPreview
          kind="image"
          src={pet.previewUrl}
          name={name}
          spriteVersionNumber={pet.spriteVersionNumber}
        />
        <div className="min-w-0 space-y-1">
          <h3 className="break-words text-ui-base font-medium">{name}</h3>
          <p className="break-words text-ui-sm text-foreground-subtle">
            {pet.author} · v{pet.spriteVersionNumber}
          </p>
          <PetLicense license={pet.license} />
        </div>
        <Button
          type="button"
          className="mt-auto h-auto min-h-7 w-full whitespace-normal rounded-lg py-1"
          variant={installed ? "outline" : "default"}
          disabled={disabled}
          onClick={onInstall}
        >
          {intl.formatMessage({
            id: installed ? "settings.desktopPet.reinstall" : "settings.desktopPet.install",
          })}
        </Button>
      </CardContent>
    </Card>
  );
}
