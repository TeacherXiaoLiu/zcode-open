/**
 * 会话交接（本地定制，specs/session-handoff.md）：可用性判定。
 *
 * 纯函数：调用方把事实查好传进来，这里只做裁决。同一份规则同时供
 * UI（按钮可用性）与服务端复检使用——**服务端必须复检**，不能只信 UI 传入的意图。
 */

/** guard 命名空间下的拒绝原因码（供 UI 做禁用态 tooltip）。 */
export const HANDOFF_REJECTED = {
  /** 非交互式根会话（子代理 / 后台 / 自动化会话）。 */
  notInteractive: "guard.handoff.notInteractive",
  /** 有运行中的 turn、启动预约或排队输入。 */
  busy: "guard.handoff.busy",
  /** 有等待用户处理的阻塞交互（权限 / 提问）。 */
  pendingInteraction: "guard.handoff.pendingInteraction",
  /** 读取工具不可用（被显式禁用或环境不具备）。 */
  readToolUnavailable: "guard.handoff.readToolUnavailable",
  /** 旧会话没有可用于摘录的正文。 */
  noSourceText: "guard.handoff.noSourceText",
  /** 对端 CLI 不认识该命令（版本过旧）。 */
  unsupported: "guard.handoff.unsupported",
} as const;

export type HandoffRejectedReason = (typeof HANDOFF_REJECTED)[keyof typeof HANDOFF_REJECTED];

export type HandoffEligibility = { allowed: true } | { allowed: false; reasonCode: string };

const ALLOWED: HandoffEligibility = { allowed: true };

export interface HandoffEligibilityFacts {
  /** 会话的父会话 ID；非空 = 子代理/派生会话。 */
  parentSessionId?: string | null;
  /** 持久化的会话种类；非 "interactive" 不参与交接。 */
  taskType?: string | null;
  /** 运行中 turn / 启动预约 / 命令队列有待处理（见 hasActiveOrQueuedTurnWork）。 */
  busy: boolean;
  /** 存在 pending 的权限或提问交互。 */
  hasPendingInteraction: boolean;
  /** ReadSessionContext 在当前 runtime 实际可用（未被 allow/disallow 或权限规则挡住）。 */
  readToolAvailable: boolean;
  /** 旧会话存在至少一条可摘录的正文。 */
  hasSourceText: boolean;
  /** 对端是否声明支持 createSession 的初始标题/关闭首轮命名扩展（旧 CLI 为 false）。 */
  capabilitySupported: boolean;
}

/** 按固定优先级裁决；返回第一个命中的拒绝原因。 */
export function resolveHandoffEligibility(
  facts: HandoffEligibilityFacts,
): HandoffEligibility {
  if (!facts.capabilitySupported) return reject(HANDOFF_REJECTED.unsupported);
  if (facts.parentSessionId) return reject(HANDOFF_REJECTED.notInteractive);
  if (facts.taskType && facts.taskType !== "interactive") {
    return reject(HANDOFF_REJECTED.notInteractive);
  }
  if (facts.busy) return reject(HANDOFF_REJECTED.busy);
  if (facts.hasPendingInteraction) return reject(HANDOFF_REJECTED.pendingInteraction);
  if (!facts.readToolAvailable) return reject(HANDOFF_REJECTED.readToolUnavailable);
  if (!facts.hasSourceText) return reject(HANDOFF_REJECTED.noSourceText);
  return ALLOWED;
}

function reject(reasonCode: HandoffRejectedReason): HandoffEligibility {
  return { allowed: false, reasonCode };
}
