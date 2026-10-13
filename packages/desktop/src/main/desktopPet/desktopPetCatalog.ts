import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAppConfigDir } from "@zcode/services/node";
import {
  DESKTOP_PET_ATLAS,
  type DesktopPetInstalledInfo,
  type DesktopPetManifest,
} from "@zcode/shared";

/**
 * 桌面宠物的本地目录服务（本地定制，specs/desktop/desktop-pet.md）。
 * 格式契约跟随 Codex pet packs：目录 <id>/ 内固定 pet.json + spritesheet.webp，
 * 可直接放入 Mikiko ~/.mikiko/v2/pets/ 拷来的宠物。
 */

/** 宠物 id 形状（与目录名共用；市场 slug 同样满足）。 */
export const DESKTOP_PET_ID_PATTERN = /^[\w.-]+$/;
export const DESKTOP_PET_MANIFEST_FILE = "pet.json";
export const DESKTOP_PET_SPRITESHEET_FILE = "spritesheet.webp";
const MAX_MANIFEST_FILE_BYTES = 64 * 1024;

/** ~/.zcode/v2/pets —— 与 setting.json 同根，跟随数据目录设置/环境变量。 */
export function resolveDesktopPetsRootDir(): string {
  return join(getAppConfigDir(), "pets");
}

function isPlainDirectory(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function isPlainFile(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 读取并校验单个宠物清单；任一条件不满足返回 null（调用方记日志即可，不抛）。
 * 校验（对齐 pet-format.md 的加载期规则）：id 必须等于目录名、精灵表固定相对名、
 * v2 必须显式声明版本；图集实际尺寸由渲染器加载时再校验（不符则不播放）。
 */
export function readDesktopPetManifest(
  petId: string,
  petsRootDir: string = resolveDesktopPetsRootDir(),
): DesktopPetManifest | null {
  if (!DESKTOP_PET_ID_PATTERN.test(petId)) {
    return null;
  }
  const petDir = join(petsRootDir, petId);
  if (!isPlainDirectory(petDir)) {
    return null;
  }
  const manifestPath = join(petDir, DESKTOP_PET_MANIFEST_FILE);
  const spritesheetPath = join(petDir, DESKTOP_PET_SPRITESHEET_FILE);
  if (!isPlainFile(manifestPath) || !isPlainFile(spritesheetPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(manifestPath, "utf8");
    if (raw.length > MAX_MANIFEST_FILE_BYTES) {
      return null;
    }
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  // 兼容缺省 id：目录名即身份；声明了就必须一致。
  if (record.id !== undefined && record.id !== petId) {
    return null;
  }
  const displayName =
    typeof record.displayName === "string" && record.displayName.trim()
      ? record.displayName.trim()
      : petId;
  const description =
    typeof record.description === "string" && record.description.trim()
      ? record.description.trim()
      : undefined;
  // spritesheetPath 固定相对名：必须等于 spritesheet.webp（拒绝绝对路径 / .. / 反斜杠）。
  if (
    record.spritesheetPath !== undefined &&
    record.spritesheetPath !== DESKTOP_PET_SPRITESHEET_FILE
  ) {
    return null;
  }
  // v2 必须显式 spriteVersionNumber: 2；v1 可以省略或为 1。
  const versionRaw = record.spriteVersionNumber;
  if (versionRaw !== undefined && versionRaw !== 1 && versionRaw !== 2) {
    return null;
  }
  const spriteVersionNumber: 1 | 2 = versionRaw === 2 ? 2 : 1;
  const atlas = DESKTOP_PET_ATLAS[spriteVersionNumber];
  return {
    id: petId,
    displayName,
    ...(description ? { description } : {}),
    spriteVersionNumber,
    columns: atlas.columns,
    rows: atlas.rows,
    frameWidth: atlas.frameWidth,
    frameHeight: atlas.frameHeight,
    frameCount: atlas.columns * atlas.rows,
  };
}

/** 列出目录内全部合法宠物（设置页列表 / 切换菜单）。 */
export function listInstalledDesktopPets(
  petsRootDir: string = resolveDesktopPetsRootDir(),
): DesktopPetInstalledInfo[] {
  if (!isPlainDirectory(petsRootDir)) {
    return [];
  }
  let entries: string[];
  try {
    entries = readdirSync(petsRootDir);
  } catch {
    return [];
  }
  const result: DesktopPetInstalledInfo[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) {
      continue;
    }
    const manifest = readDesktopPetManifest(entry, petsRootDir);
    if (!manifest) {
      continue;
    }
    result.push({
      id: manifest.id,
      displayName: manifest.displayName,
      ...(manifest.description ? { description: manifest.description } : {}),
      spriteVersionNumber: manifest.spriteVersionNumber,
    });
  }
  return result;
}

/**
 * 把随包分发的内置宠物（MIT 资产，packages/desktop/resources/pets）复制到用户目录；
 * 目标目录已存在则跳过（不覆盖用户修改）。失败静默跳过：只影响默认宠物体验。
 */
export function ensureBundledDesktopPetsInstalled(
  bundledPetsDir: string,
  petsRootDir: string = resolveDesktopPetsRootDir(),
): void {
  if (!isPlainDirectory(bundledPetsDir)) {
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(bundledPetsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }
    const sourceDir = join(bundledPetsDir, entry);
    if (!isPlainDirectory(sourceDir)) {
      continue;
    }
    const targetDir = join(petsRootDir, entry);
    if (existsSync(targetDir)) {
      continue;
    }
    try {
      mkdirSync(petsRootDir, { recursive: true });
      cpSync(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: false });
    } catch {
      // 单个内置宠物复制失败不影响其他宠物与整体启用。
    }
  }
}