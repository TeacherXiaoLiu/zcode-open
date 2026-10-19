import { type MessagePart } from "@zcode/contracts";
import { safeJson, truncateText } from "./utils.js";

const SYSTEM_REMINDER_PATTERN = /<\/?system-reminder\b/i;
const TOOL_INPUT_PREVIEW_CHARS = 900;
const TOOL_OUTPUT_PREVIEW_CHARS = 1600;
const TEXT_PART_PREVIEW_CHARS = 3000;
const FILE_PREVIEW_CHARS = 1600;

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

export function formatPartForContext(part: MessagePart): string | null {
  switch (part.type) {
    case "text": {
      const text = selectContextTextPart(part);
      return text === null ? null : truncateText(text, TEXT_PART_PREVIEW_CHARS);
    }
    case "file":
      return formatFilePart(part);
    case "agent":
      return `[Selected agent: ${part.name}]`;
    case "subtask":
      return [
        `[Subtask: ${part.description}]`,
        part.command ? `command: ${part.command}` : undefined,
        `prompt: ${truncateText(part.prompt, TEXT_PART_PREVIEW_CHARS)}`,
      ]
        .filter(Boolean)
        .join("\n");
    case "tool":
      return formatToolPart(part);
    case "patch":
      return `Patch files: ${part.files.join(", ")}`;
    case "compaction":
      return part.timelineText ?? part.reason ?? null;
    case "retry":
      return `Retry ${part.attempt}: ${part.error.name}`;
    case "step-finish":
      return `Step finished: ${part.reason}`;
    case "reasoning":
    case "snapshot":
    case "step-start":
    case "timeline":
      return null;
  }
}

/**
 * text part 是否可作为「会话正文」参与上下文，返回**未截断**原文。
 * 判定与 formatPartForContext 的 text 分支共用同一份规则（忽略 ignored、system-reminder、
 * 指定来源的合成文本），供需要自行控制预算的调用方（如会话交接摘录）复用，避免规则分叉。
 */
export function selectContextTextPart(part: MessagePart): string | null {
  if (part.type !== "text") return null;
  if (part.ignored) return null;
  if (SYSTEM_REMINDER_PATTERN.test(part.text)) return null;
  if (part.synthetic && shouldSkipSyntheticTextPart(part.metadata?.source)) return null;
  return part.text;
}

export function dedupeParts(parts: MessagePart[]): MessagePart[] {
  return [...new Map(parts.map((part) => [part.id, part])).values()];
}

function shouldSkipSyntheticTextPart(source: unknown): boolean {
  return typeof source === "string" && SKIPPED_SYNTHETIC_TEXT_SOURCES.has(source);
}

function formatFilePart(part: Extract<MessagePart, { type: "file" }>): string {
  const path = fileSourcePath(part);
  const preview = part.metadata?.preview?.text ?? part.source?.text.value;
  const header = [
    "File attachment",
    part.filename ? `filename=${part.filename}` : undefined,
    `mime=${part.mime}`,
    path ? `path=${path}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  if (!preview) return header;
  return [header, truncateText(preview, FILE_PREVIEW_CHARS)].join("\n");
}

function fileSourcePath(part: Extract<MessagePart, { type: "file" }>): string | undefined {
  if (!part.source) return undefined;
  if (part.source.type === "resource") return part.source.uri;
  return part.source.path;
}

function formatToolPart(part: Extract<MessagePart, { type: "tool" }>): string {
  const lines = [`Tool ${part.tool} ${part.state.status}`];
  if ("input" in part.state) {
    lines.push(`input: ${truncateText(safeJson(part.state.input), TOOL_INPUT_PREVIEW_CHARS)}`);
  }
  if (part.state.status === "completed") {
    lines.push(`output: ${truncateText(part.state.output, TOOL_OUTPUT_PREVIEW_CHARS)}`);
  } else if (part.state.status === "error") {
    lines.push(`error: ${truncateText(part.state.error, TOOL_OUTPUT_PREVIEW_CHARS)}`);
  } else if (part.state.status === "pending") {
    lines.push(`raw: ${truncateText(part.state.raw, TOOL_INPUT_PREVIEW_CHARS)}`);
  }
  return lines.join("\n");
}
