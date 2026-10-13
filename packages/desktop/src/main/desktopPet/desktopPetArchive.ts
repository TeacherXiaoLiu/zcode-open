import { basename, dirname } from "node:path";
import * as yauzl from "yauzl";
import {
  DesktopPetLibraryError,
  PET_FILE_NAMES,
  PET_JSON_LIMIT,
  PET_PACKAGE_LIMIT,
  PET_SHEET_LIMIT,
  packageFromFiles,
  petIdSchema,
  readPetRegularFile,
  type PetPackage,
} from "./desktopPetPackage.js";

const MAX_ZIP_ENTRIES = 2000;

function validateArchivePath(raw: string, directory: boolean): string {
  const path = directory ? raw.slice(0, -1) : raw;
  if (
    !path ||
    path.length > 320 ||
    /[\\:]/.test(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32) ||
    path.startsWith("/")
  )
    throw new DesktopPetLibraryError("UNSAFE_PATH", "ZIP 中存在绝对路径或非便携路径");
  for (const segment of path.split("/")) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      /[. ]$/.test(segment) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    ) {
      throw new DesktopPetLibraryError("UNSAFE_PATH", "ZIP 中存在路径穿越或保留名称");
    }
  }
  return path;
}

async function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, limit: number): Promise<Buffer> {
  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zip.openReadStream(entry, (error, result) =>
      error || !result ? reject(error ?? new Error("缺少 ZIP 数据流")) : resolve(result),
    );
  });
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) throw new DesktopPetLibraryError("SIZE_LIMIT", "ZIP 宠物文件超过大小限制");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** 仅在内存中解出宠物允许文件；从不按 ZIP 提供的路径写磁盘。 */
export async function readPetArchive(
  path: string,
  decodeSize?: (bytes: Buffer) => { width: number; height: number } | null,
): Promise<PetPackage[]> {
  const archive = await readPetRegularFile(dirname(path), basename(path), PET_PACKAGE_LIMIT);
  if (!archive) throw new DesktopPetLibraryError("INVALID_SOURCE", "ZIP 文件不存在");
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(
      archive,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, result) =>
        error || !result ? reject(error ?? new Error("无法打开 ZIP")) : resolve(result),
    );
  });
  const groups = new Map<string, Record<string, Buffer>>();
  const seen = new Set<string>();
  let expanded = 0;
  let count = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          if (++count > MAX_ZIP_ENTRIES || entry.generalPurposeBitFlag & 1)
            throw new DesktopPetLibraryError("SIZE_LIMIT", "ZIP 文件数过多或采用加密格式");
          const isDirectory = entry.fileName.endsWith("/");
          const name = validateArchivePath(entry.fileName, isDirectory);
          const canonical = name.toLowerCase();
          if (seen.has(canonical))
            throw new DesktopPetLibraryError("UNSAFE_PATH", "ZIP 中存在重复路径");
          seen.add(canonical);
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode && mode !== (isDirectory ? 0o040000 : 0o100000))
            throw new DesktopPetLibraryError("UNSAFE_PATH", "ZIP 不能包含链接或特殊文件");
          expanded += entry.uncompressedSize;
          if (entry.uncompressedSize > PET_SHEET_LIMIT || expanded > PET_PACKAGE_LIMIT)
            throw new DesktopPetLibraryError("SIZE_LIMIT", "ZIP 展开大小超过限制");
          if (!isDirectory) {
            const slash = name.lastIndexOf("/");
            const file = name.slice(slash + 1);
            if ((PET_FILE_NAMES as readonly string[]).includes(file)) {
              const parent = name.slice(0, Math.max(0, slash));
              const group = groups.get(parent) ?? (Object.create(null) as Record<string, Buffer>);
              group[file] = await readEntry(
                zip,
                entry,
                file === "spritesheet.webp" ? PET_SHEET_LIMIT : PET_JSON_LIMIT,
              );
              groups.set(parent, group);
            }
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  const packages: PetPackage[] = [];
  const ids = new Set<string>();
  for (const [parent, files] of groups) {
    if (!files["pet.json"] || !files["spritesheet.webp"]) continue;
    let json: unknown;
    try {
      json = JSON.parse(files["pet.json"].toString("utf8"));
    } catch {
      throw new DesktopPetLibraryError("INVALID_PET", "ZIP 中的宠物清单无效");
    }
    const declared = json && typeof json === "object" ? (json as { id?: unknown }).id : undefined;
    const folderId = parent.split("/").at(-1);
    const id = parent ? folderId : declared;
    if (typeof id !== "string" || !petIdSchema.safeParse(id).success || ids.has(id.toLowerCase()))
      throw new DesktopPetLibraryError("INVALID_PET", "ZIP 中的宠物标识缺失或重复");
    const pet = packageFromFiles(id, files, decodeSize);
    ids.add(id.toLowerCase());
    packages.push(pet);
  }
  if (!packages.length) throw new DesktopPetLibraryError("INVALID_PET", "ZIP 中没有完整宠物包");
  return packages;
}
