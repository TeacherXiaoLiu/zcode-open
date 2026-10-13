import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type {
  DesktopPetMarketItem,
  DesktopPetMarketPage,
  DesktopPetProvenance,
} from "@zcode/shared";
import {
  DesktopPetLibraryError,
  PET_JSON_LIMIT,
  PET_SHEET_LIMIT,
  packageFromFiles,
  petAssetHash,
  petIdSchema,
  readWebpSize,
  resolvePetLicense,
  type PetPackage,
} from "./desktopPetPackage.js";

const REPO = "legeling/awesome-codex-pet";
const API_ROOT = `https://api.github.com/repos/${REPO}`;
const RAW_ROOT = `https://raw.githubusercontent.com/${REPO}`;
const CATALOG_LIMIT = 4 * 1024 * 1024;
const PREVIEW_LIMIT = 600 * 1024;
const CACHE_AGE_MS = 5 * 60 * 1000;
const catalogPetSchema = z.object({
  slug: petIdSchema,
  name: z.string().min(1).max(256),
  localized_names: z.record(z.string(), z.string().max(256)).optional(),
  author: z.string().max(256).optional(),
  author_handle: z.string().max(256).optional(),
  author_url: z.string().max(2048).optional(),
  primary_category: z.string().max(128).optional(),
  collections: z.array(z.string().max(128)).max(100).optional(),
  license: z.string().max(8192).optional(),
  description: z.string().max(8192).optional(),
  spriteVersionNumber: z.union([z.literal(1), z.literal(2)]).optional(),
});
const integritySchema = z.object({
  petJsonSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  petJsonBytes: z.number().int().positive().max(PET_JSON_LIMIT),
  spritesheetSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  spritesheetBytes: z.number().int().positive().max(PET_SHEET_LIMIT),
  spritesheetWidth: z.literal(1536),
  spritesheetHeight: z.union([z.literal(1872), z.literal(2288)]),
  spriteVersionNumber: z.union([z.literal(1), z.literal(2)]).optional(),
});
type CatalogPet = z.infer<typeof catalogPetSchema>;
type Integrity = z.infer<typeof integritySchema>;
interface Snapshot {
  revision: string;
  pets: CatalogPet[];
  integrity: Record<string, Integrity>;
  at: number;
}

async function boundedResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok)
    throw new DesktopPetLibraryError("DOWNLOAD_FAILED", `下载失败（HTTP ${response.status}）`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw new DesktopPetLibraryError("SIZE_LIMIT", "下载内容超过大小限制");
  const reader = response.body?.getReader();
  if (!reader) throw new DesktopPetLibraryError("DOWNLOAD_FAILED", "下载响应缺少数据");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new DesktopPetLibraryError("SIZE_LIMIT", "下载内容超过大小限制");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function createDesktopPetMarket(options: {
  previewRootDir: string;
  fetcher?: typeof fetch;
  decodeImageSize?: (
    bytes: Buffer,
  ) => { width: number; height: number } | null | Promise<{ width: number; height: number } | null>;
}) {
  const fetcher = options.fetcher ?? fetch;
  let snapshot: Snapshot | undefined;
  let inflight: Promise<Snapshot> | undefined;
  const previewRequests = new Map<string, Promise<string | undefined>>();

  async function request(url: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
    const expected = new URL(url);
    if (
      !["api.github.com", "raw.githubusercontent.com", "codexpet.top"].includes(
        expected.hostname,
      ) ||
      expected.protocol !== "https:"
    )
      throw new DesktopPetLibraryError("DOWNLOAD_FAILED", "下载来源不受信任");
    const timeout = expected.hostname === "codexpet.top" ? 3_000 : 8_000;
    const combined = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout);
    const response = await fetcher(url, {
      signal: combined,
      redirect: "error",
      headers: { Accept: "application/vnd.github+json" },
    });
    if (response.url && new URL(response.url).origin !== expected.origin)
      throw new DesktopPetLibraryError("DOWNLOAD_FAILED", "下载来源发生重定向");
    return boundedResponse(response, limit);
  }

  async function githubFile(
    revision: string,
    path: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    try {
      return await request(`${RAW_ROOT}/${revision}/${path}`, limit, signal);
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof DesktopPetLibraryError && error.code === "SIZE_LIMIT")
      )
        throw error;
      // 同一提交的 GitHub 内容/Blob API 只用于 raw 域不可达；不改变来源和完整性要求。
      const info = JSON.parse(
        (
          await request(
            `${API_ROOT}/contents/${path}?ref=${revision}`,
            Math.max(2 * limit, 64 * 1024),
            signal,
          )
        ).toString("utf8"),
      ) as { content?: string; encoding?: string; sha?: string; size?: number };
      if (typeof info.size !== "number" || info.size > limit)
        throw new DesktopPetLibraryError("SIZE_LIMIT", "GitHub 文件超过大小限制");
      let content = info.content;
      if (!content) {
        if (!info.sha || !/^[a-f0-9]{40}$/i.test(info.sha))
          throw new DesktopPetLibraryError("DOWNLOAD_FAILED", "GitHub 文件响应无效");
        const blob = JSON.parse(
          (await request(`${API_ROOT}/git/blobs/${info.sha}`, 2 * limit, signal)).toString("utf8"),
        ) as { content?: string; encoding?: string };
        if (blob.encoding !== "base64")
          throw new DesktopPetLibraryError("DOWNLOAD_FAILED", "GitHub Blob 编码无效");
        content = blob.content;
      }
      if (!content) throw new DesktopPetLibraryError("DOWNLOAD_FAILED", "GitHub 文件缺少内容");
      const bytes = Buffer.from(content, "base64");
      if (bytes.length > limit)
        throw new DesktopPetLibraryError("SIZE_LIMIT", "GitHub 文件超过大小限制");
      return bytes;
    }
  }

  async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new DesktopPetLibraryError("CANCELLED", "已取消宠物操作");
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new DesktopPetLibraryError("CANCELLED", "已取消宠物操作"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  async function load(refresh = false): Promise<Snapshot> {
    if (!refresh && snapshot && Date.now() - snapshot.at < CACHE_AGE_MS) return snapshot;
    if (inflight) return inflight;
    inflight = (async () => {
      const ref = JSON.parse(
        (await request(`${API_ROOT}/git/ref/heads/main`, 64 * 1024)).toString("utf8"),
      ) as { object?: { sha?: unknown } };
      const revision = ref.object?.sha;
      if (typeof revision !== "string" || !/^[a-f0-9]{40}$/i.test(revision))
        throw new DesktopPetLibraryError("DOWNLOAD_FAILED", "无法确定市场目录版本");
      const [catalogBytes, manifestBytes] = await Promise.all([
        githubFile(revision, "pets.json", CATALOG_LIMIT),
        githubFile(revision, "install-manifest.json", CATALOG_LIMIT),
      ]);
      const rawCatalog: unknown = JSON.parse(catalogBytes.toString("utf8"));
      const rawManifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
      const manifest = z
        .object({
          schemaVersion: z.literal(1),
          repository: z.literal(REPO),
          ref: z.string(),
          pets: z.record(z.string(), z.unknown()),
        })
        .parse(rawManifest);
      if (!Array.isArray(rawCatalog) || rawCatalog.length > 5000)
        throw new DesktopPetLibraryError("DOWNLOAD_FAILED", "市场目录格式无效");
      const integrity: Record<string, Integrity> = Object.create(null);
      const pets: CatalogPet[] = [];
      const seen = new Set<string>();
      for (const raw of rawCatalog) {
        const pet = catalogPetSchema.safeParse(raw);
        if (!pet.success || seen.has(pet.data.slug.toLowerCase())) continue;
        const checked = integritySchema.safeParse(manifest.pets[pet.data.slug]);
        if (!checked.success) continue;
        seen.add(pet.data.slug.toLowerCase());
        integrity[pet.data.slug] = checked.data;
        pets.push(pet.data);
      }
      if (!pets.length)
        throw new DesktopPetLibraryError("DOWNLOAD_FAILED", "市场目录没有可校验的宠物");
      snapshot = { revision, pets, integrity, at: Date.now() };
      return snapshot;
    })();
    try {
      return await inflight;
    } finally {
      inflight = undefined;
    }
  }

  async function preview(id: string): Promise<string | undefined> {
    const cachedPath = join(options.previewRootDir, `${id}.webp`);
    const cached = await lstat(cachedPath).catch(() => null);
    const url = `petpack://market-preview/${id}/idle.webp`;
    if (cached?.isFile() && !cached.isSymbolicLink() && cached.size <= PREVIEW_LIMIT) return url;
    if (previewRequests.has(id)) return previewRequests.get(id);
    const current = (async () => {
      let tempPath: string | undefined;
      try {
        const bytes = await request(
          `https://codexpet.top/assets/previews/${id}/webp/idle.webp`,
          PREVIEW_LIMIT,
        );
        const size = readWebpSize(bytes);
        if (!size || size.width > 1024 || size.height > 1024) return undefined;
        await mkdir(options.previewRootDir, { recursive: true });
        tempPath = `${cachedPath}.${randomUUID()}.tmp`;
        await writeFile(tempPath, bytes, { flag: "wx" });
        await rename(tempPath, cachedPath);
        return url;
      } catch {
        return undefined;
      } finally {
        if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined);
      }
    })();
    previewRequests.set(id, current);
    try {
      return await current;
    } finally {
      previewRequests.delete(id);
    }
  }

  return {
    async list(
      params: {
        query?: string;
        category?: string;
        cursor?: string;
        limit?: number;
        refresh?: boolean;
      },
      installedIds: Set<string>,
    ): Promise<DesktopPetMarketPage> {
      const current = await load(params.refresh);
      const query = params.query?.trim().toLocaleLowerCase() || "";
      const filtered = current.pets.filter((pet) => {
        if (params.category && (pet.primary_category ?? "Other") !== params.category) return false;
        const haystack =
          `${pet.slug} ${pet.name} ${Object.values(pet.localized_names ?? {}).join(" ")} ${pet.author ?? ""} ${(pet.collections ?? []).join(" ")} ${pet.description ?? ""}`.toLocaleLowerCase();
        return !query || query.split(/\s+/).every((term) => haystack.includes(term));
      });
      if (params.cursor && !/^\d{1,8}$/.test(params.cursor))
        throw new DesktopPetLibraryError("INVALID_SOURCE", "市场分页标识无效");
      const offset = Number(params.cursor || 0);
      const limit = Math.min(24, Math.max(1, params.limit ?? 16));
      const selected = filtered.slice(offset, offset + limit);
      const items: DesktopPetMarketItem[] = [];
      // 缩略图按小批次并发下载，避免浏览一页就占满网络；失败保留可安装卡片。
      for (let start = 0; start < selected.length; start += 4) {
        items.push(
          ...(await Promise.all(
            selected.slice(start, start + 4).map(async (pet) => {
              const previewUrl = await preview(pet.slug);
              return {
                id: pet.slug,
                displayName: pet.name,
                ...(pet.localized_names ? { localizedNames: pet.localized_names } : {}),
                ...(pet.description ? { description: pet.description } : {}),
                spriteVersionNumber:
                  pet.spriteVersionNumber ?? current.integrity[pet.slug]?.spriteVersionNumber ?? 1,
                ...(previewUrl ? { previewUrl } : {}),
                author: pet.author ?? pet.author_handle ?? "Unknown author",
                ...(pet.author_url?.startsWith("https://") ? { authorUrl: pet.author_url } : {}),
                category: pet.primary_category ?? "Other",
                collections: pet.collections ?? [],
                license: resolvePetLicense(pet.license, pet.author ?? pet.author_handle),
                installed: installedIds.has(pet.slug),
              };
            }),
          )),
        );
      }
      const next = offset + selected.length;
      return {
        items,
        categories: [...new Set(current.pets.map((p) => p.primary_category ?? "Other"))].sort(),
        total: filtered.length,
        ...(next < filtered.length ? { nextCursor: String(next) } : {}),
      };
    },
    async download(
      id: string,
      signal: AbortSignal,
      reportDownloaded: () => void,
    ): Promise<{ pet: PetPackage; provenance: DesktopPetProvenance }> {
      const current = await awaitWithAbort(load(), signal);
      const item = current.pets.find((p) => p.slug === id);
      const integrity = current.integrity[id];
      if (!item || !integrity)
        throw new DesktopPetLibraryError("INVALID_PET", "宠物不在已校验的市场目录内", id);
      const path = `pets/${id}`;
      const json = await githubFile(current.revision, `${path}/pet.json`, PET_JSON_LIMIT, signal);
      reportDownloaded();
      const sheet = await githubFile(
        current.revision,
        `${path}/spritesheet.webp`,
        PET_SHEET_LIMIT,
        signal,
      );
      reportDownloaded();
      if (
        json.length !== integrity.petJsonBytes ||
        petAssetHash(json) !== integrity.petJsonSha256.toLowerCase() ||
        sheet.length !== integrity.spritesheetBytes ||
        petAssetHash(sheet) !== integrity.spritesheetSha256.toLowerCase()
      )
        throw new DesktopPetLibraryError(
          "HASH_MISMATCH",
          "市场文件的大小或 SHA-256 与安装清单不符",
          id,
        );
      const pet = packageFromFiles(id, { "pet.json": json, "spritesheet.webp": sheet });
      const size = readWebpSize(sheet);
      if (options.decodeImageSize) {
        const decoded = await options.decodeImageSize(sheet);
        if (!decoded || decoded.width !== size?.width || decoded.height !== size?.height)
          throw new DesktopPetLibraryError("INVALID_PET", "市场宠物图集无法解码", id);
      }
      if (
        !size ||
        size.width !== integrity.spritesheetWidth ||
        size.height !== integrity.spritesheetHeight ||
        pet.manifest.spriteVersionNumber !==
          (integrity.spriteVersionNumber ?? item.spriteVersionNumber ?? 1)
      )
        throw new DesktopPetLibraryError("INVALID_PET", "市场清单与图集版本不符", id);
      return {
        pet,
        provenance: {
          source: "market",
          importedAt: Date.now(),
          license: resolvePetLicense(item.license, item.author ?? item.author_handle),
          sourceUrl: `https://github.com/${REPO}/tree/${current.revision}/${path}`,
          sourceRef: current.revision,
          assetSha256: petAssetHash(sheet),
          ...(item.author ? { author: item.author } : {}),
          ...(item.author_url?.startsWith("https://") ? { authorUrl: item.author_url } : {}),
        },
      };
    },
  };
}
