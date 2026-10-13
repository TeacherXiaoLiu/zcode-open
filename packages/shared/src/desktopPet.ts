/**
 * 桌面宠物（本地定制）共享类型与常量 —— specs/desktop/desktop-pet.md。
 *
 * 格式契约跟随 Codex pet packs 公开标准（8 列网格图集 + pet.json），
 * 与 Mikiko / Codex 生态互通：宠物目录可互相拷贝。
 */
import type { Locale } from "./protocol.js";

/** 图集动画名（默认表；v2 图集才有 look）。 */
export type DesktopPetAnimationName =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review"
  | "look";

/** 会话聚合状态 → 宠物动画（waving 仅由交互/一次性事件触发，不来自状态聚合）。 */
export type DesktopPetState = "idle" | "running" | "waiting" | "failed" | "review";

/** 拖动方向动画名。 */
export type DesktopPetDragDirection = "running-left" | "running-right" | "running";

/** 图集几何常量：版本 → 网格（网格必须精确覆盖图集，否则拒绝加载）。 */
export const DESKTOP_PET_ATLAS = {
  1: {
    columns: 8,
    rows: 9,
    frameWidth: 192,
    frameHeight: 208,
    sheetWidth: 1536,
    sheetHeight: 1872,
  },
  2: {
    columns: 8,
    rows: 11,
    frameWidth: 192,
    frameHeight: 208,
    sheetWidth: 1536,
    sheetHeight: 2288,
  },
} as const;

/** 默认动画表：动画名 → 所在行 + 实际使用帧数 + 每帧节拍（ms）+ 是否一次性。 */
export const DESKTOP_PET_DEFAULT_ANIMATIONS: Record<
  string,
  { row: number; frames: number; frameMs: number; oneShot?: boolean; v2Only?: boolean }
> = {
  idle: { row: 0, frames: 6, frameMs: 220 },
  "running-right": { row: 1, frames: 8, frameMs: 120 },
  "running-left": { row: 2, frames: 8, frameMs: 120 },
  waving: { row: 3, frames: 4, frameMs: 140, oneShot: true },
  jumping: { row: 4, frames: 5, frameMs: 140, oneShot: true },
  failed: { row: 5, frames: 8, frameMs: 140 },
  waiting: { row: 6, frames: 6, frameMs: 150 },
  running: { row: 7, frames: 6, frameMs: 120 },
  review: { row: 8, frames: 6, frameMs: 140 },
  look: { row: 9, frames: 16, frameMs: 120, oneShot: true, v2Only: true },
};

/** 宠物窗口缩放（192×208 格 × scale）。默认 1.0 = 原始帧尺寸；三期起用户可调。 */
export const DESKTOP_PET_SCALE_DEFAULT = 1;
export const DESKTOP_PET_SCALE_MIN = 0.5;
export const DESKTOP_PET_SCALE_MAX = 2;

/** 归一缩放值：非有限值回落默认，越界夹取，保留两位小数避免滑条浮点噪声写盘。 */
export function normalizeDesktopPetScale(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DESKTOP_PET_SCALE_DEFAULT;
  const clamped = Math.min(DESKTOP_PET_SCALE_MAX, Math.max(DESKTOP_PET_SCALE_MIN, numeric));
  return Math.round(clamped * 100) / 100;
}

/** 单条会话汇报（气泡列表项）。 */
export interface DesktopPetSessionActivity {
  sessionId: string;
  title: string;
  state: DesktopPetState;
  /** 最新助手回复摘要（sessions-index 的 lastAssistantPreview，约 120 字）；尚无回复时缺省。 */
  detail?: string;
}

/** renderer 上报 / main 汇总的会话活动：动画汇总状态 + 气泡列表。 */
export interface DesktopPetActivity {
  /** 宠物动画的汇总状态：所有会话取最高优先级（DESKTOP_PET_STATE_PRIORITY 顺序）。 */
  state: DesktopPetState;
  /** 气泡会话列表：running 优先、同优先级按活动时间倒序；renderer 截断到 3 条。 */
  sessions: DesktopPetSessionActivity[];
}

/** Bubble ← main 的活动载荷：汇总活动 + 主进程 locale（气泡内置文案映射用，不引入完整 i18n）。 */
export interface DesktopPetBubblePayload {
  activity: DesktopPetActivity;
  locale: Locale;
}

/** 会话聚合状态 → 宠物状态的全序（多窗口汇总时取更高优先级）。 */
export const DESKTOP_PET_STATE_PRIORITY: DesktopPetState[] = [
  "running",
  "failed",
  "review",
  "waiting",
  "idle",
];

/** 归一后的宠物清单（main 校验通过后发给 pet 窗口的载荷）。 */
export interface DesktopPetManifest {
  id: string;
  displayName: string;
  description?: string;
  spriteVersionNumber: 1 | 2;
  columns: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
}

/** 来源与逐宠物许可证。market 条目以 catalog/submission 的许可为准，不能继承仓库代码许可证。 */
export type DesktopPetSourceKind = "bundled" | "market" | "codex" | "zcode" | "mikiko" | "local";
export type DesktopPetCommercialUse = "allowed" | "nonCommercial" | "unknown";

export interface DesktopPetLicenseInfo {
  /** 原始许可证说明；缺失或无法确认时使用“Unknown license”。 */
  text: string;
  commercialUse: DesktopPetCommercialUse;
  url?: string;
  attribution?: string;
}

export interface DesktopPetProvenance {
  source: DesktopPetSourceKind;
  importedAt: number;
  license: DesktopPetLicenseInfo;
  author?: string;
  authorUrl?: string;
  sourceUrl?: string;
  sourceRef?: string;
  assetSha256?: string;
}

/** 已安装宠物（设置页卡片）。 */
export interface DesktopPetInstalledInfo {
  id: string;
  displayName: string;
  description?: string;
  spriteVersionNumber: number;
  previewUrl: string;
  source: DesktopPetSourceKind;
  license: DesktopPetLicenseInfo;
}

/** 市场宠物（只包含 main 已校验的 catalog 元数据，安装仍需按 manifest 校验文件）。 */
export interface DesktopPetMarketItem {
  id: string;
  displayName: string;
  localizedNames?: Record<string, string>;
  description?: string;
  spriteVersionNumber: number;
  previewUrl?: string;
  author: string;
  authorUrl?: string;
  category: string;
  collections: string[];
  license: DesktopPetLicenseInfo;
  installed: boolean;
}

export interface DesktopPetMarketPage {
  items: DesktopPetMarketItem[];
  categories: string[];
  nextCursor?: string;
  total: number;
}

export type DesktopPetImportSource = "codex" | "zcode" | "mikiko" | "directory" | "archive";

/** main 扫描导入源后的预览候选；reviewId 绑定 main 内的来源快照，不暴露任意路径。 */
export interface DesktopPetImportCandidate {
  id: string;
  displayName: string;
  description?: string;
  spriteVersionNumber: number;
  previewUrl?: string;
  source: DesktopPetImportSource;
  license: DesktopPetLicenseInfo;
  alreadyInstalled: boolean;
}

export interface DesktopPetImportReview {
  reviewId: string;
  candidates: DesktopPetImportCandidate[];
  warnings: string[];
  expiresAt: number;
}

export type DesktopPetOperationPhase =
  | "scanning"
  | "downloading"
  | "verifying"
  | "staging"
  | "installing"
  | "deleting"
  | "completed";

export interface DesktopPetOperationProgress {
  operationId: string;
  phase: DesktopPetOperationPhase;
  completed: number;
  total: number;
  petId?: string;
  message?: string;
}

export type DesktopPetOperationErrorCode =
  | "CANCELLED"
  | "INVALID_SOURCE"
  | "INVALID_PET"
  | "UNSAFE_PATH"
  | "SIZE_LIMIT"
  | "HASH_MISMATCH"
  | "ALREADY_INSTALLED"
  | "PET_IN_USE"
  | "DOWNLOAD_FAILED"
  | "IO_ERROR";

export interface DesktopPetOperationError {
  code: DesktopPetOperationErrorCode;
  message: string;
  petId?: string;
}

/** Pet → main「当前宠物」应答：清单 + 精灵表 URL（petpack://）+ 初始状态。 */
export interface DesktopPetActivePayload {
  pet: DesktopPetManifest;
  spritesheetUrl: string;
  state: DesktopPetState;
}
