import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getAppConfigDir } from "@zcode/services/node";
import type {
  DesktopPetImportCandidate,
  DesktopPetImportReview,
  DesktopPetImportSource,
  DesktopPetInstalledInfo,
  DesktopPetMarketPage,
  DesktopPetOperationProgress,
  DesktopPetProvenance,
} from "@zcode/shared";
import { listInstalledDesktopPets, resolveDesktopPetsRootDir } from "./desktopPetCatalog.js";
import { readPetArchive } from "./desktopPetArchive.js";
import { assertManagedPetDirectory, installPetPackage } from "./desktopPetInstall.js";
import { createDesktopPetMarket } from "./desktopPetMarket.js";
import {
  assertPetId,
  DesktopPetLibraryError,
  PET_PACKAGE_LIMIT,
  petAssetHash,
  readPetPackage,
  assertPetDecoded,
  type PetPackage,
} from "./desktopPetPackage.js";

const REVIEW_AGE_MS = 5 * 60 * 1000;
const MAX_SOURCE_ENTRIES = 2000;
const MAX_REVIEW_BYTES = 64 * 1024 * 1024;
interface Review {
  ownerId: number;
  source: DesktopPetImportSource;
  expiresAt: number;
  pets: Map<string, PetPackage>;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}
interface Operation {
  ownerId: number;
  abort: AbortController;
}
interface ProgressOperation {
  operationId: string;
  ownerId: number;
  reportProgress: (progress: DesktopPetOperationProgress) => void;
}

export interface DesktopPetLibrary {
  listInstalled(): Promise<DesktopPetInstalledInfo[]>;
  listMarket(params?: {
    query?: string;
    category?: string;
    cursor?: string;
    limit?: number;
    refresh?: boolean;
  }): Promise<DesktopPetMarketPage>;
  prepareImport(
    source: DesktopPetImportSource,
    ownerId: number,
  ): Promise<DesktopPetImportReview | null>;
  setActive(petId: string, apply: () => Promise<void>): Promise<void>;
  installImport(
    params: ProgressOperation & { reviewId: string; petIds: string[]; replacePetIds?: string[] },
  ): Promise<void>;
  installMarketPet(
    params: ProgressOperation & { petId: string; replaceExisting?: boolean },
  ): Promise<void>;
  deleteInstalled(params: ProgressOperation & { petId: string }): Promise<void>;
  cancelOperation(operationId: string, ownerId: number): void;
  dispose(): void;
}

export function createDesktopPetLibrary(options: {
  petsRootDir?: string;
  marketPreviewRootDir?: string;
  homeDir?: string;
  codexHome?: string;
  now?: () => number;
  fetcher?: typeof fetch;
  decodeImageSize: (
    bytes: Buffer,
  ) => { width: number; height: number } | null | Promise<{ width: number; height: number } | null>;
  selectPath: (source: DesktopPetImportSource, defaultPath?: string) => Promise<string | null>;
  getActivePetId: () => string | undefined;
  /** 成功切换后 UI 的设置快照可读取最新 ID；目录提交仍只由库 owner 执行。 */
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
  filesystem?: { rename: typeof rename };
}): DesktopPetLibrary {
  const petsRootDir = options.petsRootDir ?? resolveDesktopPetsRootDir();
  const marketPreviewRootDir =
    options.marketPreviewRootDir ?? join(getAppConfigDir(), "pet-market-previews");
  const home = options.homeDir ?? homedir();
  const now = options.now ?? Date.now;
  const renamePath = options.filesystem?.rename ?? rename;
  const market = createDesktopPetMarket({
    previewRootDir: marketPreviewRootDir,
    fetcher: options.fetcher,
    decodeImageSize: options.decodeImageSize,
  });
  const reviews = new Map<string, Review>();
  const operations = new Map<string, Operation>();
  let mutationTail = Promise.resolve();
  let disposed = false;

  function isActivePet(id: string): boolean {
    const active = options.getActivePetId();
    // Windows 文件系统不区分大小写，不能让路径别名绕过活动宠物保护。
    return (
      active !== undefined &&
      (process.platform === "win32" ? active.toLowerCase() === id.toLowerCase() : active === id)
    );
  }

  function dropReview(id: string): void {
    const review = reviews.get(id);
    if (review) clearTimeout(review.timer);
    reviews.delete(id);
  }

  function assertServing(): void {
    if (disposed) throw new DesktopPetLibraryError("CANCELLED", "宠物管理服务已关闭");
  }

  function throwIfCancelled(signal: AbortSignal): void {
    assertServing();
    if (signal.aborted) throw new DesktopPetLibraryError("CANCELLED", "已取消宠物操作");
  }

  function progress(
    params: ProgressOperation,
    phase: DesktopPetOperationProgress["phase"],
    completed: number,
    total: number,
    petId?: string,
  ): void {
    params.reportProgress({
      operationId: params.operationId,
      phase,
      completed,
      total,
      ...(petId ? { petId } : {}),
    });
  }

  async function runOperation(
    params: ProgressOperation,
    run: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    assertServing();
    if (operations.has(params.operationId))
      throw new DesktopPetLibraryError("INVALID_SOURCE", "操作标识已被使用");
    const operation: Operation = { ownerId: params.ownerId, abort: new AbortController() };
    operations.set(params.operationId, operation);
    const current = mutationTail
      .catch(() => undefined)
      .then(async () => {
        throwIfCancelled(operation.abort.signal);
        await run(operation.abort.signal);
      });
    mutationTail = current.catch(() => undefined);
    try {
      await current;
    } catch (error) {
      if (operation.abort.signal.aborted)
        throw new DesktopPetLibraryError("CANCELLED", "已取消宠物操作");
      throw error;
    } finally {
      operations.delete(params.operationId);
    }
  }

  async function installed(): Promise<DesktopPetInstalledInfo[]> {
    assertServing();
    await mutationTail;
    return listInstalledDesktopPets(petsRootDir);
  }

  async function sourcePackages(root: string, warnings: string[]): Promise<PetPackage[]> {
    const rootInfo = await lstat(root).catch(() => null);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink())
      throw new DesktopPetLibraryError("INVALID_SOURCE", "来源不是普通文件夹");
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length > MAX_SOURCE_ENTRIES)
      throw new DesktopPetLibraryError("SIZE_LIMIT", "来源文件夹条目过多，请直接选择 pets 文件夹");
    const single = entries.some((entry) => entry.name === "pet.json");
    const dirs = single
      ? [{ id: basename(root), path: root }]
      : entries
          .filter(
            (entry) =>
              entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."),
          )
          .map((entry) => ({ id: entry.name, path: join(root, entry.name) }));
    const pets: PetPackage[] = [];
    let total = 0;
    for (const candidate of dirs) {
      try {
        const pet = await readPetPackage(candidate.path, candidate.id);
        await assertPetDecoded(pet, options.decodeImageSize);
        const size = Object.values(pet.files).reduce((sum, bytes) => sum + bytes.length, 0);
        total += size;
        if (total > PET_PACKAGE_LIMIT)
          throw new DesktopPetLibraryError(
            "SIZE_LIMIT",
            "一次导入的宠物总大小超过 40 MiB，请分批导入",
          );
        pets.push(pet);
      } catch (error) {
        if (error instanceof DesktopPetLibraryError && error.code === "SIZE_LIMIT") throw error;
        warnings.push(
          `${candidate.id}：${error instanceof Error ? error.message : "格式检查失败"}`,
        );
      }
    }
    return pets;
  }

  async function prepareImport(
    source: DesktopPetImportSource,
    ownerId: number,
  ): Promise<DesktopPetImportReview | null> {
    assertServing();
    for (const [id, review] of reviews) if (review.expiresAt <= now()) dropReview(id);
    const defaultPath =
      source === "codex"
        ? join(
            options.codexHome ?? (process.env.CODEX_HOME?.trim() || join(home, ".codex")),
            "pets",
          )
        : source === "mikiko"
          ? join(home, ".mikiko", "v2", "pets")
          : undefined;
    const defaultInfo = defaultPath ? await lstat(defaultPath).catch(() => null) : null;
    // 快捷来源先读取已知 pets 目录，其余来源与 ZIP 都由原生选择器授权，不递归搜索 home。
    const path =
      defaultPath && defaultInfo?.isDirectory() && !defaultInfo.isSymbolicLink()
        ? defaultPath
        : await options.selectPath(source, defaultPath);
    if (!path) return null;
    const warnings: string[] = [];
    const packages =
      source === "archive" ? await readPetArchive(path) : await sourcePackages(path, warnings);
    if (source === "archive")
      for (const pet of packages) await assertPetDecoded(pet, options.decodeImageSize);
    assertServing();
    const existing = new Set(listInstalledDesktopPets(petsRootDir).map((p) => p.id.toLowerCase()));
    const candidates: DesktopPetImportCandidate[] = packages.map((pet) => ({
      id: pet.manifest.id,
      displayName: pet.manifest.displayName,
      ...(pet.manifest.description ? { description: pet.manifest.description } : {}),
      spriteVersionNumber: pet.manifest.spriteVersionNumber,
      source,
      license: { ...pet.license },
      alreadyInstalled: existing.has(pet.manifest.id.toLowerCase()),
    }));
    const bytes = packages.reduce(
      (sum, pet) =>
        sum + Object.values(pet.files).reduce((subtotal, file) => subtotal + file.length, 0),
      0,
    );
    const used = [...reviews.values()].reduce((sum, review) => sum + review.bytes, 0);
    if (reviews.size >= 8 || used + bytes > MAX_REVIEW_BYTES)
      throw new DesktopPetLibraryError(
        "SIZE_LIMIT",
        "导入预览缓存已满，请完成当前导入或等待五分钟后重试",
      );
    const reviewId = randomUUID();
    const expiresAt = now() + REVIEW_AGE_MS;
    const timer = setTimeout(() => dropReview(reviewId), REVIEW_AGE_MS);
    timer.unref?.();
    reviews.set(reviewId, {
      ownerId,
      source,
      expiresAt,
      pets: new Map(packages.map((pet) => [pet.manifest.id, pet])),
      bytes,
      timer,
    });
    return { reviewId, candidates, warnings, expiresAt };
  }

  async function commitPet(
    pet: PetPackage,
    provenance: DesktopPetProvenance,
    replace: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    await installPetPackage({
      rootDir: petsRootDir,
      pet,
      provenance,
      replace,
      isActivePet,
      assertAccepted: () => throwIfCancelled(signal),
      renamePath,
      warn: options.logger?.warn,
    });
    options.logger?.info("[desktop-pet] 宠物安装完成", {
      petId: pet.manifest.id,
      source: provenance.source,
    });
  }

  return {
    listInstalled: installed,
    async listMarket(params = {}) {
      assertServing();
      return market.list(params, new Set((await installed()).map((pet) => pet.id)));
    },
    prepareImport,
    async setActive(petId, apply) {
      assertPetId(petId);
      assertServing();
      const current = mutationTail
        .catch(() => undefined)
        .then(async () => {
          if (!listInstalledDesktopPets(petsRootDir).some((pet) => pet.id === petId))
            throw new DesktopPetLibraryError("INVALID_PET", "宠物未安装或已失效", petId);
          await apply();
        });
      mutationTail = current.catch(() => undefined);
      await current;
    },
    async installImport(params) {
      const review = reviews.get(params.reviewId);
      if (!review || review.ownerId !== params.ownerId || review.expiresAt <= now())
        throw new DesktopPetLibraryError(
          "INVALID_SOURCE",
          "导入预览已过期或属于其他窗口，请重新扫描",
        );
      const ids = [...new Set(params.petIds)];
      const replace = new Set(params.replacePetIds ?? []);
      if (
        !ids.length ||
        ids.some((id) => !review.pets.has(id)) ||
        [...replace].some((id) => !ids.includes(id))
      )
        throw new DesktopPetLibraryError("INVALID_SOURCE", "选择内容与导入预览不一致");
      // token 在命令接受时消费，候选字节在预检时已冻结，源文件后续变动不会改变安装内容。
      dropReview(params.reviewId);
      await runOperation(params, async (signal) => {
        for (let index = 0; index < ids.length; index++) {
          throwIfCancelled(signal);
          const id = ids[index]!;
          const pet = review.pets.get(id)!;
          const source =
            review.source === "directory" || review.source === "archive" ? "local" : review.source;
          const provenance: DesktopPetProvenance = {
            ...pet.provenance,
            source,
            importedAt: now(),
            license: pet.license,
            assetSha256: petAssetHash(pet.files["spritesheet.webp"]!),
          };
          progress(params, "installing", index, ids.length, id);
          await commitPet(pet, provenance, replace.has(id), signal);
          progress(params, "installing", index + 1, ids.length, id);
        }
        progress(params, "completed", ids.length, ids.length);
      });
    },
    async installMarketPet(params) {
      assertPetId(params.petId);
      await runOperation(params, async (signal) => {
        let downloaded = 0;
        progress(params, "downloading", 0, 2, params.petId);
        const { pet, provenance } = await market.download(params.petId, signal, () =>
          progress(params, "downloading", ++downloaded, 2, params.petId),
        );
        throwIfCancelled(signal);
        progress(params, "verifying", 2, 2, params.petId);
        progress(params, "installing", 0, 1, params.petId);
        await commitPet(pet, provenance, params.replaceExisting === true, signal);
        progress(params, "completed", 1, 1, params.petId);
      });
    },
    async deleteInstalled(params) {
      assertPetId(params.petId);
      await runOperation(params, async (signal) => {
        const target = join(petsRootDir, params.petId);
        await assertManagedPetDirectory(target, params.petId);
        throwIfCancelled(signal);
        if (isActivePet(params.petId))
          throw new DesktopPetLibraryError(
            "PET_IN_USE",
            "请先切换当前宠物，再删除它",
            params.petId,
          );
        progress(params, "deleting", 0, 1, params.petId);
        const tombstone = join(petsRootDir, `.deleting-${randomUUID()}`);
        await renamePath(target, tombstone);
        try {
          await rm(tombstone, { recursive: true, force: false });
        } catch (error) {
          await renamePath(tombstone, target);
          throw error;
        }
        progress(params, "completed", 1, 1, params.petId);
      });
    },
    cancelOperation(id, ownerId) {
      const operation = operations.get(id);
      if (operation?.ownerId === ownerId) operation.abort.abort();
    },
    dispose() {
      disposed = true;
      for (const operation of operations.values()) operation.abort.abort();
      for (const id of reviews.keys()) dropReview(id);
    },
  };
}
