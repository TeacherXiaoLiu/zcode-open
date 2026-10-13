import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import {
  DESKTOP_PET_ATLAS,
  type DesktopPetLicenseInfo,
  type DesktopPetManifest,
  type DesktopPetOperationErrorCode,
  type DesktopPetProvenance,
} from "@zcode/shared";

export const PET_JSON_LIMIT = 64 * 1024;
export const PET_SHEET_LIMIT = 5 * 1024 * 1024;
export const PET_PACKAGE_LIMIT = 40 * 1024 * 1024;
export const PET_FILE_NAMES = [
  "pet.json",
  "spritesheet.webp",
  "submission.json",
  ".zcode-provenance.json",
] as const;

export const petIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .refine((id) => !/[. ]$/.test(id) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id));
const licenseSchema = z.object({
  text: z.string().min(1).max(8192),
  commercialUse: z.enum(["allowed", "nonCommercial", "unknown"]),
  url: z.string().max(2048).optional(),
  attribution: z.string().max(256).optional(),
});
export const petProvenanceSchema = z.object({
  source: z.enum(["bundled", "market", "codex", "zcode", "mikiko", "local"]),
  importedAt: z.number().finite(),
  license: licenseSchema,
  author: z.string().max(256).optional(),
  authorUrl: z.string().max(2048).optional(),
  sourceUrl: z.string().max(2048).optional(),
  sourceRef: z.string().max(128).optional(),
  assetSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export class DesktopPetLibraryError extends Error {
  constructor(
    readonly code: DesktopPetOperationErrorCode,
    message: string,
    readonly petId?: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DesktopPetLibraryError";
  }
}

export function assertPetId(id: string): void {
  if (!petIdSchema.safeParse(id).success)
    throw new DesktopPetLibraryError("INVALID_PET", "宠物标识无效", id);
}

export function petAssetHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function resolvePetLicense(value: unknown, attribution?: string): DesktopPetLicenseInfo {
  const text =
    typeof value === "string" && value.trim() ? value.trim().slice(0, 8192) : "Unknown license";
  const nonCommercial =
    /non[ -]?commercial|cc\s*by[ -]nc|非商[业業]|禁止商用|仅限个人|僅限個人/i.test(text);
  // 只识别明确的许可声明，避免把 submitter 等普通英文词误判为 MIT。
  const permitted = /^(MIT(?: License)?|CC0|CC BY 4\.0|Apache[- ]2\.0)(?:[.;\s]|$)/i.test(text);
  return {
    text,
    commercialUse: nonCommercial ? "nonCommercial" : permitted ? "allowed" : "unknown",
    ...(attribution ? { attribution: attribution.slice(0, 256) } : {}),
  };
}

export function decodePetManifest(bytes: Buffer, id: string): DesktopPetManifest {
  assertPetId(id);
  if (bytes.length > PET_JSON_LIMIT)
    throw new DesktopPetLibraryError("SIZE_LIMIT", "宠物清单超过大小限制", id);
  let input: unknown;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new DesktopPetLibraryError("INVALID_PET", "宠物清单不是有效 JSON", id);
  }
  const parsed = z
    .object({
      id: z.string().optional(),
      displayName: z.string().max(256).optional(),
      description: z.string().max(8192).optional(),
      spritesheetPath: z.literal("spritesheet.webp").optional(),
      spriteVersionNumber: z.union([z.literal(1), z.literal(2)]).optional(),
    })
    .safeParse(input);
  if (!parsed.success || (parsed.data.id !== undefined && parsed.data.id !== id)) {
    throw new DesktopPetLibraryError("INVALID_PET", "清单标识、图集路径或版本不符合宠物格式", id);
  }
  const version = parsed.data.spriteVersionNumber ?? 1;
  const atlas = DESKTOP_PET_ATLAS[version];
  return {
    id,
    displayName: parsed.data.displayName?.trim() || id,
    ...(parsed.data.description?.trim() ? { description: parsed.data.description.trim() } : {}),
    spriteVersionNumber: version,
    columns: atlas.columns,
    rows: atlas.rows,
    frameWidth: atlas.frameWidth,
    frameHeight: atlas.frameHeight,
    frameCount: atlas.columns * atlas.rows,
  };
}

export function readWebpSize(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    return null;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const kind = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (payload + length > bytes.length) return null;
    if (kind === "VP8X" && length >= 10)
      return {
        width: 1 + bytes.readUIntLE(payload + 4, 3),
        height: 1 + bytes.readUIntLE(payload + 7, 3),
      };
    if (kind === "VP8L" && length >= 5 && bytes[payload] === 0x2f) {
      const bits = bytes.readUInt32LE(payload + 1);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    if (
      kind === "VP8 " &&
      length >= 10 &&
      bytes[payload + 3] === 0x9d &&
      bytes[payload + 4] === 1 &&
      bytes[payload + 5] === 0x2a
    ) {
      return {
        width: bytes.readUInt16LE(payload + 6) & 0x3fff,
        height: bytes.readUInt16LE(payload + 8) & 0x3fff,
      };
    }
    offset = payload + length + (length & 1);
  }
  return null;
}

export function validatePetSheet(
  manifest: DesktopPetManifest,
  bytes: Buffer,
  decodeSize?: (bytes: Buffer) => { width: number; height: number } | null,
): void {
  if (bytes.length > PET_SHEET_LIMIT)
    throw new DesktopPetLibraryError("SIZE_LIMIT", "宠物图集超过大小限制", manifest.id);
  const headerSize = readWebpSize(bytes);
  const size = decodeSize ? decodeSize(bytes) : headerSize;
  const atlas = DESKTOP_PET_ATLAS[manifest.spriteVersionNumber];
  if (
    !headerSize ||
    !size ||
    headerSize.width !== atlas.sheetWidth ||
    headerSize.height !== atlas.sheetHeight ||
    size.width !== atlas.sheetWidth ||
    size.height !== atlas.sheetHeight
  ) {
    throw new DesktopPetLibraryError(
      "INVALID_PET",
      "图集无法解码或尺寸与 v1/v2 格式不符",
      manifest.id,
    );
  }
}

export async function readPetRegularFile(
  directory: string,
  name: string,
  limit: number,
): Promise<Buffer | undefined> {
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new DesktopPetLibraryError("UNSAFE_PATH", "宠物目录不能是符号链接");
  const path = join(directory, name);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink())
    throw new DesktopPetLibraryError("UNSAFE_PATH", "宠物文件不能是符号链接或特殊文件");
  if (info.size > limit) throw new DesktopPetLibraryError("SIZE_LIMIT", "宠物文件超过大小限制");
  const root = await realpath(directory);
  const target = await realpath(path);
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
    throw new DesktopPetLibraryError("UNSAFE_PATH", "宠物文件越过来源目录");
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit || (info.ino !== 0 && opened.ino !== info.ino))
      throw new DesktopPetLibraryError("UNSAFE_PATH", "宠物文件在读取时已变化");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const read = await handle.read(bytes, length, limit + 1 - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > limit) throw new DesktopPetLibraryError("SIZE_LIMIT", "宠物文件超过大小限制");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export interface PetPackage {
  manifest: DesktopPetManifest;
  files: Record<string, Buffer>;
  license: DesktopPetLicenseInfo;
  provenance?: DesktopPetProvenance;
}

export function packageFromFiles(
  id: string,
  files: Record<string, Buffer>,
  decodeSize?: (bytes: Buffer) => { width: number; height: number } | null,
): PetPackage {
  const json = files["pet.json"];
  const sheet = files["spritesheet.webp"];
  if (!json || !sheet)
    throw new DesktopPetLibraryError("INVALID_PET", "缺少 pet.json 或 spritesheet.webp", id);
  const manifest = decodePetManifest(json, id);
  validatePetSheet(manifest, sheet, decodeSize);
  let submission: Record<string, unknown> = {};
  if (files["submission.json"]) {
    try {
      submission = JSON.parse(files["submission.json"].toString("utf8")) as Record<string, unknown>;
    } catch {}
  }
  let provenance: DesktopPetProvenance | undefined;
  if (files[".zcode-provenance.json"]) {
    try {
      const parsed = petProvenanceSchema.safeParse(
        JSON.parse(files[".zcode-provenance.json"].toString("utf8")),
      );
      if (parsed.success) provenance = parsed.data;
    } catch {}
  }
  const license =
    provenance?.license ??
    resolvePetLicense(
      submission?.license,
      typeof submission?.author === "string" ? submission.author : undefined,
    );
  return { manifest, files, license, ...(provenance ? { provenance } : {}) };
}

export async function assertPetDecoded(
  pet: PetPackage,
  decode: (
    bytes: Buffer,
  ) => { width: number; height: number } | null | Promise<{ width: number; height: number } | null>,
): Promise<void> {
  const bytes = pet.files["spritesheet.webp"]!;
  const expected = readWebpSize(bytes);
  const actual = await decode(bytes);
  if (!expected || !actual || actual.width !== expected.width || actual.height !== expected.height)
    throw new DesktopPetLibraryError(
      "INVALID_PET",
      "宠物图集不能被图像解码器正确读取",
      pet.manifest.id,
    );
}

export async function readPetPackage(
  directory: string,
  id: string,
  decodeSize?: (bytes: Buffer) => { width: number; height: number } | null,
): Promise<PetPackage> {
  const files: Record<string, Buffer> = Object.create(null);
  for (const name of PET_FILE_NAMES) {
    const bytes = await readPetRegularFile(
      directory,
      name,
      name === "spritesheet.webp" ? PET_SHEET_LIMIT : PET_JSON_LIMIT,
    );
    if (bytes) files[name] = bytes;
  }
  return packageFromFiles(id, files, decodeSize);
}
