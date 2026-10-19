/**
 * 会话交接（本地定制，specs/session-handoff.md）：首条消息的正文摘录。
 *
 * 只取「可见真实用户输入」与「可见助手答复」的 text part，排除 reasoning、工具调用与结果、
 * 系统消息、压缩标记、隐藏合成输入与引擎尾注。预算按 **Unicode 码位**计（不切断代理对），
 * 从最新往前累加后恢复时间顺序。
 *
 * 本模块是纯函数：不做 IO、不读存储、不调用模型。
 * 入参用最小结构化类型，CLI 的 MessageWithParts（@zcode/contracts）与 UI 的会话投影都直接可传，
 * shared 因此不依赖 contracts。
 */

/** 摘录部分的字符预算（spec 固定值；不含交接指令本体）。 */
export const HANDOFF_EXCERPT_BUDGET_CHARS = 8_000;

/** 最新一条自身就超预算时的截取标注（其长度计入预算）。 */
export const HANDOFF_EXCERPT_TRUNCATION_NOTICE = "…（此条过长，仅保留尾部）";

/** 消息 part 的最小结构（只声明本模块读取的字段）。 */
export interface HandoffSourcePart {
  type: string;
  text?: string;
  ignored?: boolean;
  synthetic?: boolean;
  metadata?: { source?: unknown } | null;
}

/** 消息的最小结构（info 平铺在顶层，便于 UI 直接构造投影）。 */
export interface HandoffSourceMessage {
  role?: string;
  synthetic?: boolean;
  visibility?: string;
  parts: readonly HandoffSourcePart[];
}

export interface HandoffExcerptEntry {
  role: "user" | "assistant";
  text: string;
}

export interface HandoffExcerpt {
  /** 组装好的摘录（含角色标签与分隔符）；无可用正文时为空字符串。 */
  text: string;
  /** 实际占用的码位数（≤ 预算）。 */
  chars: number;
  /** 进入摘录的条目数。 */
  entryCount: number;
  /** 是否发生截断：丢掉了更早的条目，或最新一条被截去头部。 */
  truncated: boolean;
}

const ENTRY_SEPARATOR = "\n\n";
const SYSTEM_REMINDER_PATTERN = /<\/?system-reminder\b/i;

/** 与 CLI session-context 正文筛选同源：这些来源的合成 text part 不是会话正文。 */
const SKIPPED_SYNTHETIC_TEXT_SOURCES = new Set([
  "background_task",
  "subagent_message",
  "diagnostics",
  "goal_state_change",
  "hook_context",
  "memory_update",
  "model_anomaly",
  "queued_system_notification",
  "relevant_memory",
  "runtime_mode",
  "todo_reminder",
]);

/** 该消息是否可作为交接正文来源（可见、非合成、非 model-only）。 */
export function isHandoffEligibleMessage(info: {
  role?: string;
  synthetic?: boolean;
  visibility?: string;
}): boolean {
  if (info.role !== "user" && info.role !== "assistant") return false;
  return info.synthetic !== true && info.visibility !== "model-only";
}

/**
 * text part 是否可作为「会话正文」参与摘录，返回**未截断**原文。
 * 规则与 CLI 的 selectContextTextPart 一致（忽略 ignored、system-reminder、指定来源的合成文本）。
 */
export function selectHandoffTextPart(part: HandoffSourcePart): string | null {
  if (part.type !== "text") return null;
  if (part.ignored) return null;
  const text = part.text;
  if (typeof text !== "string") return null;
  if (SYSTEM_REMINDER_PATTERN.test(text)) return null;
  if (part.synthetic && shouldSkipSyntheticTextPart(part.metadata?.source)) return null;
  return text;
}

/** 从已保存消息里按发生序抽出可交接的正文条目（角色 + 正文）。 */
export function collectHandoffEntries(
  messages: readonly HandoffSourceMessage[],
): HandoffExcerptEntry[] {
  const entries: HandoffExcerptEntry[] = [];
  for (const message of messages) {
    if (!isHandoffEligibleMessage(message)) continue;
    const role = message.role as "user" | "assistant";
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => selectHandoffTextPart(part))
      .filter((part): part is string => part !== null)
      .join("\n")
      .trim();
    if (text.length === 0) continue;
    entries.push({ role, text });
  }
  return entries;
}

/** 按预算组装摘录。条目不足预算时全部保留；超预算时丢最旧的。 */
export function buildHandoffExcerpt(
  entries: readonly HandoffExcerptEntry[],
  budgetChars: number = HANDOFF_EXCERPT_BUDGET_CHARS,
): HandoffExcerpt {
  const budget = Math.max(0, Math.floor(budgetChars));
  const selected: string[] = [];
  let used = 0;
  let truncated = false;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const rendered = formatEntry(entry);
    const separatorCost = selected.length === 0 ? 0 : codePointLength(ENTRY_SEPARATOR);
    const cost = codePointLength(rendered) + separatorCost;
    if (used + cost <= budget) {
      selected.push(rendered);
      used += cost;
      continue;
    }
    // 放不下：最新一条就地截尾（否则会得到空摘录）；更早的条目直接丢弃并停止。
    if (selected.length === 0) {
      const truncatedEntry = buildTruncatedEntry(entry, budget);
      if (truncatedEntry !== null) {
        selected.push(truncatedEntry);
        used = codePointLength(truncatedEntry);
      }
    }
    truncated = true;
    break;
  }

  const ordered = selected.reverse();
  return {
    text: ordered.join(ENTRY_SEPARATOR),
    chars: used,
    entryCount: ordered.length,
    truncated,
  };
}

function shouldSkipSyntheticTextPart(source: unknown): boolean {
  return typeof source === "string" && SKIPPED_SYNTHETIC_TEXT_SOURCES.has(source);
}

function entryLabel(role: "user" | "assistant"): string {
  return role === "user" ? "用户" : "助手";
}

function formatEntry(entry: HandoffExcerptEntry): string {
  return `${entryLabel(entry.role)}：${entry.text}`;
}

/** 保留尾部并加截取标注；预算连标注都放不下时返回 null（调用方得到空摘录）。 */
function buildTruncatedEntry(entry: HandoffExcerptEntry, budget: number): string | null {
  const prefix = `${entryLabel(entry.role)}：${HANDOFF_EXCERPT_TRUNCATION_NOTICE}\n`;
  const overhead = codePointLength(prefix);
  if (budget <= overhead) return null;
  const tail = truncateHead(entry.text, budget - overhead);
  return tail.length === 0 ? null : `${prefix}${tail}`;
}

/** 按 Unicode 码位计长（代理对按 1 计）。 */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** 截去头部、保留尾部，且不切断代理对。 */
function truncateHead(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(chars.length - maxChars).join("");
}
