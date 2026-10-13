import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopPetProvenance } from "@zcode/shared";
import { DESKTOP_PET_PROVENANCE_FILE } from "./desktopPetCatalog.js";
import { assertPetId, DesktopPetLibraryError, type PetPackage } from "./desktopPetPackage.js";

/** 暂存目录与目标在同一根下；所有文件写入/检查成功后才 rename，失败恢复旧安装。 */
const MANAGED_PET_FILES = [
  "pet.json",
  "spritesheet.webp",
  "submission.json",
  DESKTOP_PET_PROVENANCE_FILE,
  ".install.json",
  "LICENSE",
  "LICENSE.md",
  "README.md",
];

export async function assertManagedPetDirectory(path: string, id: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new DesktopPetLibraryError("UNSAFE_PATH", "宠物目录不是普通目录", id);
  const entries = await readdir(path);
  if (entries.some((name) => !MANAGED_PET_FILES.includes(name)))
    throw new DesktopPetLibraryError("UNSAFE_PATH", "宠物目录包含额外文件，无法安全删除或覆盖", id);
}

export async function installPetPackage(options: {
  rootDir: string;
  pet: PetPackage;
  provenance: DesktopPetProvenance;
  replace: boolean;
  isActivePet: (id: string) => boolean;
  assertAccepted: () => void;
  renamePath?: typeof rename;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<void> {
  const { rootDir, pet, provenance, replace, isActivePet, assertAccepted } = options;
  const id = pet.manifest.id;
  assertPetId(id);
  const renamePath = options.renamePath ?? rename;
  await mkdir(rootDir, { recursive: true });
  const target = join(rootDir, id);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new DesktopPetLibraryError("UNSAFE_PATH", "目标宠物目录不是普通目录", id);
  if (existing && !replace)
    throw new DesktopPetLibraryError("ALREADY_INSTALLED", "同标识宠物已安装，覆盖需明确确认", id);
  if (existing && isActivePet(id))
    throw new DesktopPetLibraryError("PET_IN_USE", "请先切换当前宠物，再覆盖它", id);
  if (existing) await assertManagedPetDirectory(target, id);
  const staging = join(rootDir, `.staging-${randomUUID()}`);
  const backup = join(rootDir, `.backup-${randomUUID()}`);
  await mkdir(staging, { recursive: false });
  let backedUp = false;
  try {
    for (const name of ["pet.json", "spritesheet.webp", "submission.json"]) {
      if (pet.files[name])
        await writeFile(join(staging, name), pet.files[name], { flag: "wx", mode: 0o600 });
    }
    await writeFile(
      join(staging, DESKTOP_PET_PROVENANCE_FILE),
      JSON.stringify(provenance, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    assertAccepted();
    // 提交前重新检查活动标识，下载期间的选择变化不能被旧安装覆盖。
    if (existing && isActivePet(id))
      throw new DesktopPetLibraryError("PET_IN_USE", "请先切换当前宠物，再覆盖它", id);
    if (existing) {
      await renamePath(target, backup);
      backedUp = true;
    }
    try {
      await renamePath(staging, target);
    } catch (error) {
      if (backedUp) await renamePath(backup, target);
      backedUp = false;
      throw error;
    }
    if (backedUp)
      await rm(backup, { recursive: true, force: true }).catch((error) =>
        options.warn?.("[desktop-pet] 旧宠物备份清理失败", { error: String(error) }),
      );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
