/**
 * 会话交接（本地定制，specs/session-handoff.md）的纯逻辑入口。
 *
 * 只包含摘录组装、固定提示词、续号标题与资格判定；会话创建、协议命令与持久化不在本目录。
 * UI 与 CLI 共用同一份规则（CLI 不得再实现一份）。
 */
export {
  HANDOFF_REJECTED,
  resolveHandoffEligibility,
  type HandoffEligibility,
  type HandoffEligibilityFacts,
  type HandoffRejectedReason,
} from "./handoff-eligibility.js";
export {
  HANDOFF_EXCERPT_BUDGET_CHARS,
  HANDOFF_EXCERPT_TRUNCATION_NOTICE,
  buildHandoffExcerpt,
  codePointLength,
  collectHandoffEntries,
  isHandoffEligibleMessage,
  selectHandoffTextPart,
  type HandoffExcerpt,
  type HandoffExcerptEntry,
  type HandoffSourceMessage,
  type HandoffSourcePart,
} from "./handoff-excerpt.js";
export {
  HANDOFF_READ_STRATEGY,
  HANDOFF_READ_TOOL_NAME,
  buildHandoffMessage,
  detectHandoffLanguage,
  handoffMessageLength,
  type HandoffLanguage,
  type HandoffMessageInput,
} from "./handoff-message.js";
export { handoffTitleSuffix, nextHandoffTitle } from "./handoff-title.js";
