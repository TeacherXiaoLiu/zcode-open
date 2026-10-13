import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { DesktopPetUiError, DesktopPetUiOperation } from "@/hooks/useDesktopPets.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function PetErrorNotice({
  error,
  onRetry,
}: {
  error: DesktopPetUiError | null;
  onRetry?: () => void;
}) {
  const { intl } = useZCodeIntl();
  if (!error) return null;
  return (
    <div
      role="alert"
      className="min-w-0 space-y-2 rounded-xl border border-destructive/30 bg-card p-3 text-ui-base"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="break-words text-destructive">
          {intl.formatMessage({ id: error.messageId })}
        </span>
        {onRetry ? (
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            {intl.formatMessage({ id: "settings.desktopPet.retry" })}
          </Button>
        ) : null}
      </div>
      {error.details ? (
        <details className="text-ui-sm text-foreground-subtle">
          <summary className="cursor-pointer">
            {intl.formatMessage({ id: "settings.desktopPet.error.details" })}
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-all">{error.details}</p>
        </details>
      ) : null}
    </div>
  );
}

export function PetLoadingNotice({ messageId }: { messageId: string }) {
  const { intl } = useZCodeIntl();
  return (
    <div role="status" className="flex items-center gap-2 py-3 text-ui-base text-foreground-subtle">
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      {intl.formatMessage({ id: messageId })}
    </div>
  );
}

export function PetOperationStatus({
  operation,
  noticeId,
  onCancel,
}: {
  operation: DesktopPetUiOperation | null;
  noticeId: string | null;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  if (!operation)
    return noticeId ? (
      <p role="status" className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: noticeId })}
      </p>
    ) : null;
  const { progress, cancelling } = operation;
  const completed = Math.max(0, Math.min(progress.completed, progress.total));
  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-2 rounded-xl border border-border bg-card p-3 text-ui-base"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          {intl.formatMessage({
            id: cancelling
              ? "settings.desktopPet.operation.cancelling"
              : `settings.desktopPet.phase.${progress.phase}`,
          })}
          {progress.total > 0 ? (
            <span className="text-ui-sm tabular-nums text-foreground-subtle">
              {completed} / {progress.total}
            </span>
          ) : null}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={cancelling || progress.phase === "completed"}
          onClick={onCancel}
        >
          {intl.formatMessage({ id: "settings.desktopPet.operation.cancel" })}
        </Button>
      </div>
      {progress.total > 0 ? (
        <progress
          className="h-1.5 w-full accent-primary"
          max={progress.total}
          value={completed}
          aria-label={intl.formatMessage({ id: "settings.desktopPet.operation.progress" })}
        />
      ) : null}
      {progress.message ? (
        <details className="text-ui-sm text-foreground-subtle">
          <summary>{intl.formatMessage({ id: "settings.desktopPet.error.details" })}</summary>
          <p className="mt-1 break-all">{progress.message}</p>
        </details>
      ) : null}
    </div>
  );
}
