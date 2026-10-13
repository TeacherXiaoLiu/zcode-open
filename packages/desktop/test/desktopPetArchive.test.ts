import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import { readPetArchive } from "../src/main/desktopPet/desktopPetArchive.js";
import {
  PET_JSON_LIMIT,
  PET_PACKAGE_LIMIT,
  PET_SHEET_LIMIT,
} from "../src/main/desktopPet/desktopPetPackage.js";

let root: string;
let sheet: Buffer;
const decodeSize = () => ({ width: 1536, height: 1872 });
beforeAll(async () => {
  sheet = await readFile(
    fileURLToPath(
      new URL("../resources/pets/desk-otter--zihualiu1997/spritesheet.webp", import.meta.url),
    ),
  );
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-pet-archive-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

type Entry = { name: string; bytes: Buffer; mode?: number };
function petEntries(id: string, parent = ""): Entry[] {
  const prefix = parent ? `${parent}/` : "";
  return [
    {
      name: `${prefix}pet.json`,
      bytes: Buffer.from(JSON.stringify({ id, displayName: `宠物 ${id}` })),
    },
    { name: `${prefix}spritesheet.webp`, bytes: sheet },
  ];
}

async function zipBytes(entries: Entry[]) {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", resolve);
    zip.outputStream.on("error", reject);
  });
  for (const entry of entries) zip.addBuffer(entry.bytes, entry.name, { mode: entry.mode });
  zip.end();
  await done;
  return Buffer.concat(chunks);
}

async function saveArchive(entries: Entry[], mutate?: (bytes: Buffer) => void) {
  const bytes = await zipBytes(entries);
  mutate?.(bytes);
  const path = join(root, "pets.zip");
  await writeFile(path, bytes);
  return path;
}

function renameZipEntry(bytes: Buffer, original: string, replacement: string) {
  // yazl 不允许危险路径；只等长改写本地头和 central directory 的条目名，保留真实 ZIP 结构。
  const from = Buffer.from(original);
  const to = Buffer.from(replacement);
  if (from.length !== to.length) throw new Error("ZIP 名称改写必须等长");
  let offset = 0;
  let replacements = 0;
  while ((offset = bytes.indexOf(from, offset)) !== -1) {
    to.copy(bytes, offset);
    offset += to.length;
    replacements++;
  }
  expect(replacements).toBe(2);
}

describe("桌宠 ZIP 包格式与允许文件", () => {
  it("接受 root 单包，id 来自 pet.json，保留可选 submission 但不解出额外文件", async () => {
    const path = await saveArchive([
      ...petEntries("otter"),
      {
        name: "submission.json",
        bytes: Buffer.from(JSON.stringify({ author: "作者", license: "MIT License" })),
      },
      { name: "README.md", bytes: Buffer.from("不安装此文件") },
    ]);
    const decoder = vi.fn<(bytes: Buffer) => { width: number; height: number }>(decodeSize);
    const packages = await readPetArchive(path, decoder);
    expect(packages).toHaveLength(1);
    expect(packages[0]?.manifest).toMatchObject({
      id: "otter",
      displayName: "宠物 otter",
      spriteVersionNumber: 1,
    });
    expect(packages[0]?.license).toEqual({
      text: "MIT License",
      commercialUse: "allowed",
      attribution: "作者",
    });
    expect(Object.keys(packages[0]!.files).sort()).toEqual([
      "pet.json",
      "spritesheet.webp",
      "submission.json",
    ]);
    expect(decoder.mock.calls[0]?.[0].equals(sheet)).toBe(true);
    expect(await readdir(root)).toEqual(["pets.zip"]);
  });

  it("接受 nested folder 多包，使用最末级目录作为 id", async () => {
    const path = await saveArchive([
      ...petEntries("otter", "export/pets/otter"),
      ...petEntries("luna", "export/pets/luna"),
    ]);
    const packages = await readPetArchive(path, decodeSize);
    expect(packages.map((pet) => pet.manifest.id)).toEqual(["otter", "luna"]);
    expect(packages.every((pet) => pet.files["spritesheet.webp"]!.equals(sheet))).toBe(true);
  });

  it("nested 包允许清单省略 id，但 root 包不可缺失 id", async () => {
    const manifest = Buffer.from(JSON.stringify({ displayName: "省略 id" }));
    const nested = await saveArchive([
      { name: "pets/otter/pet.json", bytes: manifest },
      { name: "pets/otter/spritesheet.webp", bytes: sheet },
    ]);
    expect((await readPetArchive(nested, decodeSize))[0]?.manifest.id).toBe("otter");
    const flat = await saveArchive([
      { name: "pet.json", bytes: manifest },
      { name: "spritesheet.webp", bytes: sheet },
    ]);
    await expect(readPetArchive(flat, decodeSize)).rejects.toMatchObject({ code: "INVALID_PET" });
  });

  it.each([
    ["坏 JSON", Buffer.from("{invalid")],
    ["ID 与目录不符", Buffer.from(JSON.stringify({ id: "other" }))],
    [
      "spritesheetPath 越界",
      Buffer.from(JSON.stringify({ id: "otter", spritesheetPath: "../sheet.webp" })),
    ],
    ["v2 与 v1 图集不符", Buffer.from(JSON.stringify({ id: "otter", spriteVersionNumber: 2 }))],
  ])("拒绝%s", async (_label, manifest) => {
    const path = await saveArchive([
      { name: "otter/pet.json", bytes: manifest },
      { name: "otter/spritesheet.webp", bytes: sheet },
    ]);
    await expect(readPetArchive(path, decodeSize)).rejects.toMatchObject({ code: "INVALID_PET" });
  });

  it("无完整宠物包、坏 ZIP 或缺失 ZIP 都拒绝", async () => {
    const incomplete = await saveArchive([{ name: "otter/pet.json", bytes: Buffer.from("{}") }]);
    await expect(readPetArchive(incomplete, decodeSize)).rejects.toMatchObject({
      code: "INVALID_PET",
    });
    await writeFile(incomplete, "不是 ZIP");
    await expect(readPetArchive(incomplete, decodeSize)).rejects.toThrow();
    await expect(readPetArchive(join(root, "missing.zip"), decodeSize)).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
  });

  it("注入解码失败时拒绝真实资产，不把头部几何校验当成原生解码", async () => {
    const path = await saveArchive(petEntries("otter"));
    await expect(readPetArchive(path, () => null)).rejects.toMatchObject({ code: "INVALID_PET" });
  });
});

describe("桌宠 ZIP 不可信路径与资源限制", () => {
  it.each([
    "../evil",
    "/evil",
    "a\\evil",
    "a/../evil",
    "a//evil",
    "a/./evil",
    "C:/evil",
    "CON/evil",
    "a./evil",
    "a /evil",
    "a\u0000evil",
  ])("拒绝路径 %j，额外非宠物文件也不能绕过", async (dangerous) => {
    const placeholder = "x".repeat(Buffer.byteLength(dangerous));
    const path = await saveArchive(
      [...petEntries("otter"), { name: placeholder, bytes: Buffer.from("不可信文件") }],
      (bytes) => renameZipEntry(bytes, placeholder, dangerous),
    );
    // yauzl 会先拒绝一部分穿越名称，因此只要求拒绝，不假称所有拒绝均由本模块错误码产生。
    await expect(readPetArchive(path, decodeSize)).rejects.toThrow();
    expect(await readdir(root)).toEqual(["pets.zip"]);
  });

  it.each(["otter/pet.json", "OTTER/PET.JSON"])(
    "拒绝重复或仅大小写不同的路径 %s",
    async (duplicate) => {
      const path = await saveArchive([
        ...petEntries("otter", "otter"),
        { name: duplicate, bytes: Buffer.from("{}") },
      ]);
      await expect(readPetArchive(path, decodeSize)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    },
  );

  it("不同父目录中同 id 或仅大小写不同的 id 不可同时导入", async () => {
    const path = await saveArchive([
      ...petEntries("otter", "a/otter"),
      ...petEntries("Otter", "b/Otter"),
    ]);
    await expect(readPetArchive(path, decodeSize)).rejects.toMatchObject({ code: "INVALID_PET" });
  });

  it.each([0o120777, 0o010644, 0o020644])("拒绝链接、FIFO 和特殊文件 mode=%s", async (mode) => {
    const path = await saveArchive([
      ...petEntries("otter"),
      { name: "link", bytes: Buffer.from("../outside"), mode },
    ]);
    await expect(readPetArchive(path, decodeSize)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });

  it("拒绝加密 flag，即使条目内容未真正加密也不能被当普通 ZIP 接受", async () => {
    const path = await saveArchive(petEntries("otter"), (bytes) => {
      const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      expect(central).toBeGreaterThanOrEqual(0);
      bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8);
      const local = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      bytes.writeUInt16LE(bytes.readUInt16LE(local + 6) | 1, local + 6);
    });
    await expect(readPetArchive(path, decodeSize)).rejects.toMatchObject({ code: "SIZE_LIMIT" });
  });

  it("pet.json 解压超过 64 KiB 拒绝", async () => {
    const path = await saveArchive([
      { name: "otter/pet.json", bytes: Buffer.alloc(PET_JSON_LIMIT + 1) },
      { name: "otter/spritesheet.webp", bytes: sheet },
    ]);
    await expect(readPetArchive(path, decodeSize)).rejects.toMatchObject({ code: "SIZE_LIMIT" });
  });

  it("单文件真实解压超过 5 MiB 拒绝，非宠物文件同样受限", async () => {
    const path = await saveArchive([
      ...petEntries("otter"),
      { name: "unrelated.bin", bytes: Buffer.alloc(PET_SHEET_LIMIT + 1) },
    ]);
    await expect(readPetArchive(path, decodeSize)).rejects.toMatchObject({ code: "SIZE_LIMIT" });
  });

  it("累计真实展开量超过 40 MiB 拒绝", async () => {
    const repeated = Buffer.alloc(PET_SHEET_LIMIT);
    const entries = Array.from({ length: 9 }, (_unused, index) => ({
      name: `extra-${index}.bin`,
      bytes: repeated,
    }));
    const path = await saveArchive([...petEntries("otter"), ...entries]);
    await expect(readPetArchive(path, decodeSize)).rejects.toMatchObject({ code: "SIZE_LIMIT" });
  });

  it("超过 2000 个 ZIP 条目拒绝", async () => {
    const entries = Array.from({ length: 2001 }, (_unused, index) => ({
      name: `file-${index}`,
      bytes: Buffer.alloc(0),
    }));
    const path = await saveArchive(entries);
    await expect(readPetArchive(path, decodeSize)).rejects.toMatchObject({ code: "SIZE_LIMIT" });
  });

  it("ZIP 源文件自身超过 40 MiB 在解析前拒绝", async () => {
    const path = join(root, "too-large.zip");
    await writeFile(path, Buffer.alloc(PET_PACKAGE_LIMIT + 1));
    await expect(readPetArchive(path, decodeSize)).rejects.toMatchObject({ code: "SIZE_LIMIT" });
  });

  it("ZIP 来源为命名 junction 而非普通文件时拒绝", async () => {
    const directory = join(root, "outside");
    await mkdir(directory);
    const path = join(root, "linked.zip");
    await symlink(directory, path, process.platform === "win32" ? "junction" : "dir");
    await expect(readPetArchive(path, decodeSize)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });
});
