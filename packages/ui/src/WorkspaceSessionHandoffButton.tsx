// 会话交接（specs/session-handoff.md）的常驻顶栏入口。
//
// 只做呈现与路由：资格状态与发起函数由已挂载的 SessionPane 注册在
// v4/sessionHandoffController 上。按钮**仅交互式根会话**显示（子代理/后台/只读 pane 不显示），
// 会话忙或有阻塞交互时禁用并给出原因；点击后由 pane 侧编排完成建会话 + 首发 + 导航。
import { TID_SESSION_HANDOFF } from "@zcode/shared";
import { HANDOFF_REJECTED } from "@zcode/shared/session-handoff";
import { CopyPlusIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildSessionHandoffScopeKey,
  requestSessionHandoff,
  useSessionHandoffActionState,
} from "@/v4/sessionHandoffController.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";

export function WorkspaceSessionHandoffButton({
  activeSessionId,
  workspaceAbsPath,
  workspaceIdentity,
  useWindowsCaptionSpacing = false,
}: {
  activeSessionId: string | null;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const scopeKey = activeSessionId
    ? buildSessionHandoffScopeKey(workspaceKey, activeSessionId)
    : null;
  const actionState = useSessionHandoffActionState(scopeKey);

  // 无活动会话（草稿）或 pane 未挂载：没有可交接的会话。
  if (!scopeKey || !actionState) return null;
  // 子代理 / 后台 / 只读观察视图不是交互式根会话：没有入口，而不是给一个禁用的按钮。
  if (!actionState.eligibility.allowed && actionState.eligibility.reasonCode === HANDOFF_REJECTED.notInteractive) {
    return null;
  }

  const label = intl.formatMessage({ id: "chat.handoff.button" });
  const disabledReason = actionState.pending
    ? intl.formatMessage({ id: "chat.handoff.pending" })
    : actionState.eligibility.allowed
      ? undefined
      : intl.formatMessage({ id: handoffDisabledReasonMessageId(actionState.eligibility.reasonCode) });

  return (
    <ControlHintTooltip title={disabledReason ?? label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-testid={TID_SESSION_HANDOFF}
        className={cn(
          "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
          useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
        )}
        aria-label={label}
        disabled={Boolean(disabledReason)}
        onClick={() => {
          requestSessionHandoff(scopeKey);
        }}
      >
        <CopyPlusIcon className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
}

/** guard.handoff.* 原因码 → 禁用态文案（未登记的原因码退回通用不可用文案）。 */
function handoffDisabledReasonMessageId(reasonCode: string): string {
  switch (reasonCode) {
    case HANDOFF_REJECTED.notInteractive:
      return "chat.handoff.disabled.notInteractive";
    case HANDOFF_REJECTED.busy:
      return "chat.handoff.disabled.busy";
    case HANDOFF_REJECTED.pendingInteraction:
      return "chat.handoff.disabled.pendingInteraction";
    case HANDOFF_REJECTED.readToolUnavailable:
      return "chat.handoff.disabled.readToolUnavailable";
    case HANDOFF_REJECTED.noSourceText:
      return "chat.handoff.disabled.noSourceText";
    case HANDOFF_REJECTED.unsupported:
      return "chat.handoff.disabled.unsupported";
    default:
      return "chat.handoff.disabled.notInteractive";
  }
}
