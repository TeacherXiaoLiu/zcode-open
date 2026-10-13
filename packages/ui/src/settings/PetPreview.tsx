import { useState } from "react";
import { Cat, LoaderCircle } from "lucide-react";
import { DESKTOP_PET_ATLAS } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface PetPreviewProps {
  src?: string;
  name: string;
  spriteVersionNumber?: number;
  kind: "atlas" | "image";
  className?: string;
}

/** 预览 URL 变化时重建加载状态，避免上一只宠物的成功/失败状态污染下一张图。 */
export function PetPreview(props: PetPreviewProps) {
  return (
    <PetPreviewImage key={`${props.src}:${props.kind}:${props.spriteVersionNumber}`} {...props} />
  );
}

function PetPreviewImage({ src, name, spriteVersionNumber, kind, className }: PetPreviewProps) {
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(src ? "loading" : "error");
  const atlas = DESKTOP_PET_ATLAS[spriteVersionNumber === 2 ? 2 : 1];
  return (
    <div
      role="img"
      aria-label={name}
      data-testid="pet-preview"
      data-preview-kind={kind}
      className={cn(
        "relative flex aspect-[4/3] w-full min-w-0 items-center justify-center overflow-hidden rounded-lg bg-surface p-2",
        className,
      )}
    >
      {src ? (
        kind === "atlas" ? (
          <div
            className="relative aspect-[12/13] h-full max-w-full overflow-hidden"
            data-testid="pet-preview-first-frame"
          >
            {/* Installed URL 是完整精灵表；按首格尺寸放大并裁切，不能把整张表压进缩略图。 */}
            <img
              src={src}
              alt=""
              draggable={false}
              className={cn(
                "absolute left-0 top-0 max-w-none object-fill",
                status !== "loaded" && "invisible",
              )}
              style={{ width: `${atlas.columns * 100}%`, height: `${atlas.rows * 100}%` }}
              onLoad={(event) =>
                setStatus(event.currentTarget.naturalWidth > 0 ? "loaded" : "error")
              }
              onError={() => setStatus("error")}
            />
          </div>
        ) : (
          <img
            src={src}
            alt=""
            draggable={false}
            className={cn(
              "h-full max-h-full w-full object-contain",
              status !== "loaded" && "invisible",
            )}
            onLoad={() => setStatus("loaded")}
            onError={() => setStatus("error")}
          />
        )
      ) : null}
      {status !== "loaded" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-2 text-center text-ui-sm text-foreground-subtle">
          {status === "loading" ? (
            <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
          ) : (
            <Cat className="size-6" aria-hidden="true" />
          )}
          <span>{intl.formatMessage({ id: `settings.desktopPet.preview.${status}` })}</span>
        </div>
      ) : null}
    </div>
  );
}
