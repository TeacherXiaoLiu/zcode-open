/**
 * 会话交接（本地定制，specs/session-handoff.md）：新会话的初始标题。
 *
 * 沿用旧标题并递增续号：`X` → `X（续 2）`；`X（续 k）` → `X（续 k+1）`。
 * 过长的标题按码位截断到 MAX_TITLE_CHARS 以内（与标题生成链路的上限保持一致量级）。
 */

/** 与标题生成链路同量级的标题长度上限（码位）。 */
const MAX_TITLE_CHARS = 100;

/** 匹配结尾的续号（全角/半角括号都接受），仅用于递增，输出统一用全角。 */
const TRAILING_SUFFIX_PATTERN = /[（(]续\s*(\d+)[）)]\s*$/;

export function handoffTitleSuffix(sequence: number): string {
  return `（续 ${sequence}）`;
}

/**
 * 由旧标题推出新会话的初始标题。
 * 旧标题为空（或只有空白）时返回空字符串：调用方应视为「无初始标题」，走既有默认命名。
 */
export function nextHandoffTitle(previousTitle: string | null | undefined): string {
  const base = (previousTitle ?? "").trim();
  if (base.length === 0) return "";

  const match = TRAILING_SUFFIX_PATTERN.exec(base);
  if (match === null) {
    return clampTitle(`${base}${handoffTitleSuffix(2)}`);
  }

  const stripped = base.slice(0, match.index).trim();
  const next = Number.parseInt(match[1]!, 10);
  const sequence = Number.isFinite(next) && next >= 1 ? next + 1 : 2;
  // 旧标题本身只有续号（例如 "（续 2）"）时，基名取空，只保留新续号。
  return clampTitle(`${stripped}${handoffTitleSuffix(sequence)}`);
}

function clampTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length <= MAX_TITLE_CHARS ? title : chars.slice(0, MAX_TITLE_CHARS).join("");
}
