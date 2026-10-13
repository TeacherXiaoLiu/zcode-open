import { useState } from "react";
import type { DesktopPetInstalledInfo, DesktopPetMarketItem } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { DesktopPetsController } from "@/hooks/useDesktopPets.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PetLicense, resolvePetMarketName } from "./PetCards.js";
import { PetErrorNotice, PetOperationStatus } from "./PetOperationStatus.js";
import { PetPreview } from "./PetPreview.js";

export function PetMarketInstallDialog({
  pet,
  pets,
  onClose,
}: {
  pet: DesktopPetMarketItem;
  pets: DesktopPetsController;
  onClose: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  const [replaceAccepted, setReplaceAccepted] = useState(false);
  const existing = pets.installed.find((item) => item.id === pet.id);
  const duplicate = Boolean(existing || pet.installed);
  const name = resolvePetMarketName(pet, locale);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pets.busy) onClose();
      }}
    >
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-lg"
        showCloseButton={!pets.busy}
        onEscapeKeyDown={(event) => {
          if (pets.busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pets.busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.desktopPet.market.confirmTitle" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.desktopPet.market.licenseHint" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 items-start gap-3">
          <PetPreview kind="image" src={pet.previewUrl} name={name} className="size-24 shrink-0" />
          <div className="min-w-0 space-y-2">
            <h3 className="break-words text-ui-base font-medium">
              {name} · v{pet.spriteVersionNumber}
            </h3>
            <p className="break-words text-ui-sm text-foreground-subtle">{pet.author}</p>
            <PetLicense license={pet.license} expanded />
          </div>
        </div>
        <label className="flex items-start gap-2 text-ui-base">
          <Checkbox
            checked={licenseAccepted}
            disabled={pets.busy}
            onCheckedChange={(checked) => setLicenseAccepted(checked === true)}
          />
          <span>{intl.formatMessage({ id: "settings.desktopPet.market.acceptLicense" })}</span>
        </label>
        {duplicate ? (
          <div className="space-y-2 rounded-xl border border-warning/30 p-3 text-ui-base">
            <p className="text-warning">
              {intl.formatMessage({ id: "settings.desktopPet.import.duplicate" })}
            </p>
            {existing ? (
              <p className="break-words text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.desktopPet.import.existing" },
                  { name: existing.displayName, version: existing.spriteVersionNumber },
                )}
              </p>
            ) : null}
            <label className="flex items-start gap-2">
              <Checkbox
                checked={replaceAccepted}
                disabled={pets.busy}
                onCheckedChange={(checked) => setReplaceAccepted(checked === true)}
              />
              <span className="break-words">
                {intl.formatMessage({ id: "settings.desktopPet.import.replaceNamed" }, { name })}
              </span>
            </label>
          </div>
        ) : null}
        <PetErrorNotice error={pets.actionError} />
        <PetOperationStatus
          operation={pets.operation}
          noticeId={pets.noticeId}
          onCancel={pets.cancelOperation}
        />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pets.busy} onClick={onClose}>
            {intl.formatMessage({ id: "settings.desktopPet.cancel" })}
          </Button>
          <Button
            type="button"
            disabled={pets.busy || !licenseAccepted || (duplicate && !replaceAccepted)}
            onClick={async () => {
              if (await pets.installMarketPet(pet.id, duplicate && replaceAccepted)) onClose();
            }}
          >
            {intl.formatMessage({ id: "settings.desktopPet.market.confirmInstall" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PetDeleteDialog({
  pet,
  pets,
  onClose,
}: {
  pet: DesktopPetInstalledInfo;
  pets: DesktopPetsController;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const active = pet.id === pets.activePetId;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pets.busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!pets.busy}>
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "settings.desktopPet.deleteTitle" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage(
              {
                id: active
                  ? "settings.desktopPet.error.activeDelete"
                  : "settings.desktopPet.deleteDescription",
              },
              { name: pet.displayName },
            )}
          </DialogDescription>
        </DialogHeader>
        <PetErrorNotice error={pets.actionError} />
        <PetOperationStatus
          operation={pets.operation}
          noticeId={pets.noticeId}
          onCancel={pets.cancelOperation}
        />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pets.busy} onClick={onClose}>
            {intl.formatMessage({ id: "settings.desktopPet.cancel" })}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pets.busy || active}
            onClick={async () => {
              if (await pets.deletePet(pet.id)) onClose();
            }}
          >
            {intl.formatMessage({ id: "settings.desktopPet.delete" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
