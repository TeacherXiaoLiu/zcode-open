/**
 * 桌面宠物（本地定制）共享类型与常量 —— specs/desktop/desktop-pet.md。
 *
 * 格式契约跟随 Codex pet packs 公开标准（8 列网格图集 + pet.json），
 * 与 Mikiko / Codex 生态互通：宠物目录可互相拷贝。
 */

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
  1: { columns: 8, rows: 9, frameWidth: 192, frameHeight: 208, sheetWidth: 1536, sheetHeight: 1872 },
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

/** 宠物窗口绘制缩放（192×208 格 → 288×312 窗）。 */
export const DESKTOP_PET_WINDOW_SCALE = 1.5;

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

/** 已安装宠物（设置页列表项）。 */
export interface DesktopPetInstalledInfo {
  id: string;
  displayName: string;
  description?: string;
  spriteVersionNumber: number;
}

/** Pet → main「当前宠物」应答：清单 + 精灵表 URL（petpack://）+ 初始状态。 */
export interface DesktopPetActivePayload {
  pet: DesktopPetManifest;
  spritesheetUrl: string;
  state: DesktopPetState;
}