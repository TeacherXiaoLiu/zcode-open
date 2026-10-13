import { useState } from "react";
import type { DesktopPetImportReview, DesktopPetImportSource } from "@zcode/shared";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import type { DesktopPetsController } from "@/hooks/useDesktopPets.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PetLicense } from "./PetCards.js";
import { PetErrorNotice, PetLoadingNotice, PetOperationStatus } from "./PetOperationStatus.js";
import { PetPreview } from "./PetPreview.js";

const SOURCES: DesktopPetImportSource[] = ["codex", "mikiko", "zcode", "directory", "archive"];

export function PetImportDialog({
  pets,
  onClose,
}: {
  pets: DesktopPetsController;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [source, setSource] = useState<DesktopPetImportSource>("codex");
  const close = () => {
    if (!pets.busy) {
      pets.clearImportReview();
      onClose();
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="max-h-[85vh] min-w-0 overflow-y-auto sm:max-w-2xl"
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
            {intl.formatMessage({ id: "settings.desktopPet.import.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.desktopPet.import.description" })}
          </DialogDescription>
        </DialogHeader>
        <PetErrorNotice error={pets.actionError} />
        <PetOperationStatus
          operation={pets.operation}
          noticeId={pets.noticeId}
          onCancel={pets.cancelOperation}
        />
        {pets.importReview ? (
          <PetImportReviewSelection
            key={pets.importReview.reviewId}
            review={pets.importReview}
            pets={pets}
            onClose={close}
          />
        ) : (
          <>
            <label className="space-y-2 text-ui-base">
              <span>{intl.formatMessage({ id: "settings.desktopPet.import.source" })}</span>
              <Select
                value={source}
                disabled={pets.busy}
                onValueChange={(value) => setSource(value as DesktopPetImportSource)}
              >
                <SelectTrigger
                  size="lg"
                  className="w-full min-w-0"
                  aria-label={intl.formatMessage({ id: "settings.desktopPet.import.source" })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {intl.formatMessage({ id: `settings.desktopPet.import.source.${value}` })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.desktopPet.import.sourceHint" })}
            </p>
            {pets.busy ? <PetLoadingNotice messageId="settings.desktopPet.phase.scanning" /> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pets.busy} onClick={close}>
                {intl.formatMessage({ id: "settings.desktopPet.cancel" })}
              </Button>
              <Button
                type="button"
                disabled={pets.busy}
                onClick={() => void pets.prepareImport(source)}
              >
                {intl.formatMessage({ id: "settings.desktopPet.import.scan" })}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PetImportReviewSelection({
  review,
  pets,
  onClose,
}: {
  review: DesktopPetImportReview;
  pets: DesktopPetsController;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [selected, setSelected] = useState(
    () =>
      new Set(
        review.candidates
          .filter((candidate) => !candidate.alreadyInstalled)
          .map((candidate) => candidate.id),
      ),
  );
  const [replacements, setReplacements] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const selectedCandidates = review.candidates.filter((candidate) => selected.has(candidate.id));
  const missingReplacement = selectedCandidates.some(
    (candidate) => candidate.alreadyInstalled && !replacements.has(candidate.id),
  );
  const expired = review.expiresAt <= Date.now();
  const toggle = (id: string, checked: boolean, replacement = false) => {
    const setter = replacement ? setReplacements : setSelected;
    setter((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    // 取消某候选的选择也撤销该候选的覆盖授权，重新选中必须再次明确授权。
    if (!replacement && !checked)
      setReplacements((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
  };
  return (
    <>
      {review.warnings.length ? (
        <div
          role="status"
          className="rounded-xl border border-warning/30 p-3 text-ui-sm text-foreground-subtle"
        >
          <p className="font-medium text-warning">
            {intl.formatMessage({ id: "settings.desktopPet.import.warnings" })}
          </p>
          <ul className="mt-2 list-inside list-disc space-y-1 break-all">
            {review.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {expired ? (
        <p role="alert" className="text-ui-base text-destructive">
          {intl.formatMessage({ id: "settings.desktopPet.error.reviewExpired" })}
        </p>
      ) : null}
      {!review.candidates.length ? (
        <p role="status" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.desktopPet.import.empty" })}
        </p>
      ) : null}
      {confirming ? (
        <div className="space-y-3">
          <p className="text-ui-base font-medium">
            {intl.formatMessage(
              { id: "settings.desktopPet.import.confirmSummary" },
              { count: selectedCandidates.length },
            )}
          </p>
          <ul className="space-y-2 rounded-xl border border-border p-3 text-ui-base">
            {selectedCandidates.map((candidate) => (
              <li key={candidate.id} className="break-words">
                {candidate.displayName} · v{candidate.spriteVersionNumber}
                {candidate.alreadyInstalled ? (
                  <span className="ml-2 text-ui-sm text-warning">
                    {intl.formatMessage({ id: "settings.desktopPet.import.willReplace" })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.desktopPet.import.confirmHint" })}
          </p>
        </div>
      ) : (
        <div className="max-h-80 space-y-3 overflow-y-auto">
          {review.candidates.map((candidate, index) => {
            const existing = pets.installed.find((pet) => pet.id === candidate.id);
            const selectedId = `pet-import-select-${index}`;
            const replaceId = `pet-import-replace-${index}`;
            return (
              <div
                key={candidate.id}
                className="min-w-0 space-y-3 rounded-xl border border-border p-3"
                data-testid="pet-import-candidate"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <Checkbox
                    id={selectedId}
                    checked={selected.has(candidate.id)}
                    disabled={pets.busy || expired}
                    onCheckedChange={(checked) => toggle(candidate.id, checked === true)}
                  />
                  {candidate.previewUrl ? (
                    <PetPreview
                      kind="atlas"
                      src={candidate.previewUrl}
                      name={candidate.displayName}
                      spriteVersionNumber={candidate.spriteVersionNumber}
                      className="size-16 shrink-0"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1 space-y-1">
                    <label
                      htmlFor={selectedId}
                      className="block break-words text-ui-base font-medium"
                    >
                      {candidate.displayName}
                    </label>
                    <p className="break-all text-ui-sm text-foreground-subtle">
                      {candidate.id} · v{candidate.spriteVersionNumber} ·{" "}
                      {intl.formatMessage({
                        id: `settings.desktopPet.import.source.${candidate.source}`,
                      })}
                    </p>
                    <PetLicense license={candidate.license} expanded />
                  </div>
                </div>
                {candidate.alreadyInstalled ? (
                  <div className="space-y-2 rounded-lg bg-surface p-3 text-ui-sm">
                    <p className="break-words text-warning">
                      {intl.formatMessage({ id: "settings.desktopPet.import.duplicate" })}
                    </p>
                    {existing ? (
                      <p className="break-words text-foreground-subtle">
                        {intl.formatMessage(
                          { id: "settings.desktopPet.import.existing" },
                          { name: existing.displayName, version: existing.spriteVersionNumber },
                        )}
                      </p>
                    ) : null}
                    <label htmlFor={replaceId} className="flex items-start gap-2">
                      <Checkbox
                        id={replaceId}
                        checked={replacements.has(candidate.id)}
                        disabled={!selected.has(candidate.id) || pets.busy || expired}
                        onCheckedChange={(checked) => toggle(candidate.id, checked === true, true)}
                      />
                      <span className="break-words">
                        {intl.formatMessage(
                          { id: "settings.desktopPet.import.replaceNamed" },
                          { name: candidate.displayName },
                        )}
                      </span>
                    </label>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {missingReplacement ? (
        <p className="text-ui-sm text-warning">
          {intl.formatMessage({ id: "settings.desktopPet.error.replaceRequired" })}
        </p>
      ) : null}
      <DialogFooter className="flex-wrap">
        <Button
          type="button"
          variant="ghost"
          disabled={pets.busy}
          onClick={() => {
            pets.clearImportReview();
            pets.clearActionError();
          }}
        >
          {intl.formatMessage({ id: "settings.desktopPet.import.chooseAnother" })}
        </Button>
        <Button type="button" variant="outline" disabled={pets.busy} onClick={onClose}>
          {intl.formatMessage({ id: "settings.desktopPet.cancel" })}
        </Button>
        {confirming ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={pets.busy}
              onClick={() => setConfirming(false)}
            >
              {intl.formatMessage({ id: "settings.desktopPet.import.back" })}
            </Button>
            <Button
              type="button"
              disabled={pets.busy || expired || missingReplacement || !selected.size}
              onClick={async () => {
                if (await pets.installImport([...selected], [...replacements])) onClose();
              }}
            >
              {intl.formatMessage({ id: "settings.desktopPet.import.confirm" })}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            disabled={pets.busy || expired || missingReplacement || !selected.size}
            onClick={() => setConfirming(true)}
          >
            {intl.formatMessage({ id: "settings.desktopPet.import.reviewSelection" })}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
