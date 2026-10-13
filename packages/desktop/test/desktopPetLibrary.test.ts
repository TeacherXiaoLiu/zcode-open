import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import {
  createDesktopPetLibrary,
  type DesktopPetLibrary,
} from "../src/main/desktopPet/desktopPetLibrary.js";
import {
  assertPetId,
  PET_JSON_LIMIT,
  PET_SHEET_LIMIT,
  petAssetHash,
} from "../src/main/desktopPet/desktopPetPackage.js";

const assetPath = fileURLToPath(
  new URL("../resources/pets/desk-otter--zihualiu1997/spritesheet.webp", import.meta.url),
);
let sheet: Buffer;
let root: string;
let activePetId: string | undefined;
const libraries: DesktopPetLibrary[] = [];

beforeAll(async () => {
  sheet = await readFile(assetPath);
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-pet-library-"));
  activePetId = undefined;
});
afterEach(async () => {
  for (const library of libraries.splice(0)) library.dispose();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function makeLibrary(overrides: Partial<Parameters<typeof createDesktopPetLibrary>[0]> = {}) {
  // 使用真实图集资产，但 Electron 解码器通过尺寸回调注入；本套测试不声称实际执行原生解码。
  const decodeImageSize = vi.fn<(bytes: Buffer) => { width: number; height: number }>(() => ({
    width: 1536,
    height: 1872,
  }));
  const selectPath = vi.fn(async () => join(root, "source"));
  const library = createDesktopPetLibrary({
    petsRootDir: join(root, "installed"),
    marketPreviewRootDir: join(root, "previews"),
    homeDir: join(root, "home"),
    decodeImageSize,
    selectPath,
    getActivePetId: () => activePetId,
    ...overrides,
  });
  libraries.push(library);
  return { library, decodeImageSize, selectPath };
}

async function writePet(parent: string, id: string, displayName = "原始宠物") {
  const directory = join(parent, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "pet.json"),
    JSON.stringify({ id, displayName, spritesheetPath: "spritesheet.webp" }),
  );
  await writeFile(join(directory, "spritesheet.webp"), sheet);
  return directory;
}

function operation(ownerId = 11) {
  return { operationId: randomUUID(), ownerId, reportProgress: vi.fn() };
}

function mockMarketFetcher(
  override?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
  const revision = "a".repeat(40);
  const repository = "legeling/awesome-codex-pet";
  const api = `https://api.github.com/repos/${repository}`;
  const raw = `https://raw.githubusercontent.com/${repository}/${revision}`;
  const json = Buffer.from(JSON.stringify({ id: "market-otter", displayName: "市场水獭" }));
  const manifest = {
    schemaVersion: 1,
    repository,
    ref: "main",
    pets: {
      "market-otter": {
        petJsonSha256: petAssetHash(json),
        petJsonBytes: json.length,
        spritesheetSha256: petAssetHash(sheet),
        spritesheetBytes: sheet.length,
        spritesheetWidth: 1536,
        spritesheetHeight: 1872,
        spriteVersionNumber: 1,
      },
    },
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const custom = await override?.(url, init);
    if (custom) return custom;
    if (url === `${api}/git/ref/heads/main`) return Response.json({ object: { sha: revision } });
    if (url === `${raw}/pets.json`)
      return Response.json([
        { slug: "market-otter", name: "市场水獭", license: "CC BY-NC 4.0", author: "测试作者" },
      ]);
    if (url === `${raw}/install-manifest.json`) return Response.json(manifest);
    if (url === `${raw}/pets/market-otter/pet.json`) return new Response(Uint8Array.from(json));
    if (url === `${raw}/pets/market-otter/spritesheet.webp`)
      return new Response(Uint8Array.from(sheet));
    if (url.startsWith("https://codexpet.top/assets/previews/"))
      return new Response(null, { status: 404 });
    throw new Error(`测试禁止未登记网络请求：${url}`);
  });
  return { fetcher, manifest, revision };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function preparePet(library: DesktopPetLibrary, id = "otter", ownerId = 11) {
  await writePet(join(root, "source"), id);
  const review = await library.prepareImport("directory", ownerId);
  if (!review) throw new Error("测试来源不应取消");
  return review;
}

describe("桌宠二期导入入口与预检冻结", () => {
  it.each([false, true])("支持宠物根目录与单宠目录（单宠=%s）并保存许可和进度", async (single) => {
    const path = await writePet(join(root, "source"), "otter");
    await writeFile(
      join(path, "submission.json"),
      JSON.stringify({ author: "测试作者", license: "CC BY-NC 4.0" }),
    );
    const selectPath = vi.fn(async () => (single ? path : join(root, "source")));
    const { library, decodeImageSize } = makeLibrary({ selectPath });
    const review = await library.prepareImport("directory", 11);
    expect(review?.candidates).toEqual([
      expect.objectContaining({
        id: "otter",
        source: "directory",
        alreadyInstalled: false,
        license: { text: "CC BY-NC 4.0", commercialUse: "nonCommercial", attribution: "测试作者" },
      }),
    ]);
    expect(decodeImageSize.mock.calls[0]?.[0].equals(sheet)).toBe(true);
    expect(await library.listInstalled()).toEqual([]);
    const params = operation();
    await library.installImport({ ...params, reviewId: review!.reviewId, petIds: ["otter"] });
    expect(
      (await readFile(join(root, "installed", "otter", "spritesheet.webp"))).equals(sheet),
    ).toBe(true);
    expect(await library.listInstalled()).toEqual([
      expect.objectContaining({
        id: "otter",
        source: "local",
        license: expect.objectContaining({ commercialUse: "nonCommercial" }),
      }),
    ]);
    expect(
      JSON.parse(
        await readFile(join(root, "installed", "otter", ".zcode-provenance.json"), "utf8"),
      ),
    ).toMatchObject({
      source: "local",
      assetSha256: petAssetHash(sheet),
      license: { text: "CC BY-NC 4.0", commercialUse: "nonCommercial", attribution: "测试作者" },
    });
    expect(params.reportProgress.mock.calls.map(([progress]) => progress)).toEqual([
      {
        operationId: params.operationId,
        phase: "installing",
        completed: 0,
        total: 1,
        petId: "otter",
      },
      {
        operationId: params.operationId,
        phase: "installing",
        completed: 1,
        total: 1,
        petId: "otter",
      },
      { operationId: params.operationId, phase: "completed", completed: 1, total: 1 },
    ]);
  });

  it.each(["显式Codex目录", "CODEX_HOME", "Codex默认", "Mikiko默认"])(
    "%s 自动读取已知目录，不调用选择器",
    async (mode) => {
      vi.stubEnv("CODEX_HOME", mode === "CODEX_HOME" ? join(root, "env-codex") : "");
      const homeDir = join(root, "home");
      const codexHome = mode === "显式Codex目录" ? join(root, "injected-codex") : undefined;
      const source = mode === "Mikiko默认" ? "mikiko" : "codex";
      const directory =
        source === "mikiko"
          ? join(homeDir, ".mikiko", "v2", "pets")
          : join(
              codexHome ??
                (mode === "CODEX_HOME" ? join(root, "env-codex") : join(homeDir, ".codex")),
              "pets",
            );
      await writePet(directory, "otter");
      const { library, selectPath } = makeLibrary({ homeDir, codexHome });
      const review = await library.prepareImport(source, 11);
      expect(review?.candidates).toEqual([expect.objectContaining({ id: "otter", source })]);
      expect(selectPath).not.toHaveBeenCalled();
      await library.installImport({
        ...operation(),
        reviewId: review!.reviewId,
        petIds: ["otter"],
      });
      expect((await library.listInstalled())[0]?.source).toBe(source);
    },
  );

  it("注入的 codexHome 优先于 CODEX_HOME，空白环境变量回落 home", async () => {
    vi.stubEnv("CODEX_HOME", join(root, "environment"));
    await writePet(join(root, "injected", "pets"), "injected");
    await writePet(join(root, "environment", "pets"), "environment");
    const first = makeLibrary({ codexHome: join(root, "injected") });
    expect(
      (await first.library.prepareImport("codex", 11))?.candidates.map((pet) => pet.id),
    ).toEqual(["injected"]);
    vi.stubEnv("CODEX_HOME", "   ");
    await writePet(join(root, "home", ".codex", "pets"), "fallback");
    const second = makeLibrary();
    expect(
      (await second.library.prepareImport("codex", 11))?.candidates.map((pet) => pet.id),
    ).toEqual(["fallback"]);
  });

  it.each(["codex", "mikiko"] as const)(
    "%s 默认目录缺失时交由选择器，取消返回 null 且不创建安装目录",
    async (source) => {
      vi.stubEnv("CODEX_HOME", "");
      const selectPath = vi.fn(async () => null);
      const { library } = makeLibrary({ selectPath });
      expect(await library.prepareImport(source, 11)).toBeNull();
      expect(selectPath).toHaveBeenCalledWith(
        source,
        source === "codex"
          ? join(root, "home", ".codex", "pets")
          : join(root, "home", ".mikiko", "v2", "pets"),
      );
      await expect(lstat(join(root, "installed"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("其他 ZCode 必须使用 picker，不猜测 home 内其他实例目录", async () => {
    await writePet(join(root, "home", ".zcode", "v2", "pets"), "ignored");
    const { library, selectPath } = makeLibrary();
    await writePet(join(root, "source"), "chosen");
    expect((await library.prepareImport("zcode", 11))?.candidates.map((pet) => pet.id)).toEqual([
      "chosen",
    ]);
    expect(selectPath).toHaveBeenCalledWith("zcode", undefined);
  });

  it("ZIP 只能通过 archive 专用入口读取，目录入口不会把 ZIP 当目录", async () => {
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify({ id: "otter" })), "pet.json");
    zip.addBuffer(sheet, "spritesheet.webp");
    const chunks: Buffer[] = [];
    const complete = new Promise<void>((resolve, reject) => {
      zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      zip.outputStream.on("error", reject);
      zip.outputStream.on("end", resolve);
    });
    zip.end();
    await complete;
    const archive = join(root, "pet.zip");
    await writeFile(archive, Buffer.concat(chunks));
    const selectPath = vi.fn(async () => archive);
    const decodeImageSize = vi.fn(async () => ({ width: 1536, height: 1872 }));
    const { library } = makeLibrary({ selectPath, decodeImageSize });
    await expect(library.prepareImport("directory", 11)).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    const review = await library.prepareImport("archive", 11);
    expect(decodeImageSize).toHaveBeenCalledOnce();
    expect(selectPath).toHaveBeenLastCalledWith("archive", undefined);
    expect(review?.candidates).toEqual([
      expect.objectContaining({ id: "otter", source: "archive" }),
    ]);
    await library.installImport({ ...operation(), reviewId: review!.reviewId, petIds: ["otter"] });
    expect((await library.listInstalled())[0]?.source).toBe("local");
    const rejected = makeLibrary({ selectPath, decodeImageSize: async () => null });
    await expect(rejected.library.prepareImport("archive", 11)).rejects.toMatchObject({
      code: "INVALID_PET",
    });
  });

  it("确认使用冻结的字节，来源替换或删除、摘要被修改均不能改变安装内容", async () => {
    const { library } = makeLibrary();
    const review = await preparePet(library);
    await writeFile(
      join(root, "source", "otter", "pet.json"),
      JSON.stringify({ id: "evil", displayName: "后来内容" }),
    );
    await writeFile(join(root, "source", "otter", "spritesheet.webp"), "无效图集");
    await rm(join(root, "source"), { recursive: true });
    review.candidates[0]!.displayName = "被调用方篡改的摘要";
    review.candidates[0]!.license.text = "MIT License";
    review.candidates[0]!.license.commercialUse = "allowed";
    await library.installImport({ ...operation(), reviewId: review.reviewId, petIds: ["otter"] });
    expect(
      JSON.parse(await readFile(join(root, "installed", "otter", "pet.json"), "utf8")),
    ).toMatchObject({ id: "otter", displayName: "原始宠物" });
    expect(
      (await readFile(join(root, "installed", "otter", "spritesheet.webp"))).equals(sheet),
    ).toBe(true);
    expect((await library.listInstalled())[0]?.license).toEqual({
      text: "Unknown license",
      commercialUse: "unknown",
    });
  });

  it("review 绑定 owner，跨窗口拒绝且不会消费原窗口 token，成功后不可复用", async () => {
    const { library } = makeLibrary();
    const review = await preparePet(library);
    await expect(
      library.installImport({ ...operation(22), reviewId: review.reviewId, petIds: ["otter"] }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await library.installImport({ ...operation(), reviewId: review.reviewId, petIds: ["otter"] });
    await expect(
      library.installImport({ ...operation(), reviewId: review.reviewId, petIds: ["otter"] }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });

  it("review 在五分钟边界过期且不写安装目录", async () => {
    let time = 1000;
    const { library } = makeLibrary({ now: () => time });
    const review = await preparePet(library);
    expect(review.expiresAt).toBe(301000);
    time = review.expiresAt;
    await expect(
      library.installImport({ ...operation(), reviewId: review.reviewId, petIds: ["otter"] }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(await library.listInstalled()).toEqual([]);
  });

  it("候选外的 ID 或覆盖 ID 拒绝且不消耗有效 review", async () => {
    const { library } = makeLibrary();
    const review = await preparePet(library);
    for (const selection of [
      { petIds: [] },
      { petIds: ["other"] },
      { petIds: ["otter"], replacePetIds: ["other"] },
    ]) {
      await expect(
        library.installImport({ ...operation(), reviewId: review.reviewId, ...selection }),
      ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    }
    await library.installImport({
      ...operation(),
      reviewId: review.reviewId,
      petIds: ["otter", "otter"],
    });
    expect((await library.listInstalled()).map((pet) => pet.id)).toEqual(["otter"]);
  });

  it("最多保留八个 review，过期后可重新扫描", async () => {
    let time = 1000;
    const { library } = makeLibrary({ now: () => time });
    await writePet(join(root, "source"), "otter");
    for (let index = 0; index < 8; index++) await library.prepareImport("directory", 11);
    await expect(library.prepareImport("directory", 11)).rejects.toMatchObject({
      code: "SIZE_LIMIT",
    });
    time += 300000;
    expect((await library.prepareImport("directory", 11))?.candidates).toHaveLength(1);
  });
});

describe("桌宠二期输入安全", () => {
  it.each([
    "../escape",
    "/absolute",
    "a\\b",
    "a/b",
    ".hidden",
    "a.",
    "a ",
    "CON",
    "aux.txt",
    "LPT1",
    "",
    "a".repeat(129),
  ])("拒绝不安全 ID %s", async (id) => {
    expect(() => assertPetId(id)).toThrow("INVALID_PET");
    const { library } = makeLibrary();
    await expect(library.deleteInstalled({ ...operation(), petId: id })).rejects.toMatchObject({
      code: "INVALID_PET",
    });
    await expect(library.installMarketPet({ ...operation(), petId: id })).rejects.toMatchObject({
      code: "INVALID_PET",
    });
  });

  it.each([
    ["坏JSON", "{坏JSON"],
    ["ID不一致", JSON.stringify({ id: "other" })],
    ["路径穿越", JSON.stringify({ id: "otter", spritesheetPath: "../sheet.webp" })],
    ["版本非法", JSON.stringify({ id: "otter", spriteVersionNumber: 3 })],
  ])("跳过%s并产生 warning，不影响有效候选", async (_label, json) => {
    const path = await writePet(join(root, "source"), "otter");
    await writeFile(join(path, "pet.json"), json);
    await writePet(join(root, "source"), "valid");
    const { library } = makeLibrary();
    const review = await library.prepareImport("directory", 11);
    expect(review?.candidates.map((pet) => pet.id)).toEqual(["valid"]);
    expect(review?.warnings).toEqual([expect.stringContaining("otter：")]);
  });

  it.each([null, { width: 1, height: 1 }, { width: 1536, height: 2288 }])(
    "注入解码尺寸无效时拒绝候选：%j",
    async (dimensions) => {
      await writePet(join(root, "source"), "otter");
      const { library } = makeLibrary({ decodeImageSize: () => dimensions });
      const review = await library.prepareImport("directory", 11);
      expect(review?.candidates).toEqual([]);
      expect(review?.warnings).toEqual([expect.stringContaining("INVALID_PET")]);
    },
  );

  it.each([true, false])("目录预检等待异步尺寸解码结果（有效=%s）", async (valid) => {
    await writePet(join(root, "source"), "otter");
    const decodeImageSize = vi.fn(async (bytes: Buffer) => {
      expect(bytes.equals(sheet)).toBe(true);
      return valid ? { width: 1536, height: 1872 } : null;
    });
    const { library } = makeLibrary({ decodeImageSize });
    const review = await library.prepareImport("directory", 11);
    expect(review?.candidates.map((pet) => pet.id)).toEqual(valid ? ["otter"] : []);
    expect(decodeImageSize).toHaveBeenCalledOnce();
    if (!valid) expect(review?.warnings).toEqual([expect.stringContaining("INVALID_PET")]);
  });

  it("即使注入尺寸正确也拒绝无效 RIFF 头，v2 声明不能接受 v1 图集", async () => {
    const path = await writePet(join(root, "source"), "otter");
    const { library } = makeLibrary();
    await writeFile(join(path, "spritesheet.webp"), "RIFF0000WEBPVP8L");
    expect((await library.prepareImport("directory", 11))?.candidates).toEqual([]);
    await writeFile(join(path, "spritesheet.webp"), sheet);
    await writeFile(
      join(path, "pet.json"),
      JSON.stringify({ id: "otter", spriteVersionNumber: 2 }),
    );
    expect((await library.prepareImport("directory", 11))?.candidates).toEqual([]);
  });

  it.each(["pet.json", "spritesheet.webp"])("%s 超限拒绝整个预检", async (file) => {
    const path = await writePet(join(root, "source"), "otter");
    await writeFile(
      join(path, file),
      Buffer.alloc((file === "pet.json" ? PET_JSON_LIMIT : PET_SHEET_LIMIT) + 1),
    );
    const { library } = makeLibrary();
    await expect(library.prepareImport("directory", 11)).rejects.toMatchObject({
      code: "SIZE_LIMIT",
    });
  });

  it("来源根目录或目标目录为 junction 时拒绝，不能修改链接目标", async () => {
    const actual = join(root, "actual");
    await writePet(actual, "otter");
    const linkedSource = join(root, "linked-source");
    await symlink(actual, linkedSource, process.platform === "win32" ? "junction" : "dir");
    const first = makeLibrary({ selectPath: async () => linkedSource });
    await expect(first.library.prepareImport("directory", 11)).rejects.toMatchObject({
      code: "INVALID_SOURCE",
    });
    const { library } = makeLibrary();
    const review = await preparePet(library);
    await mkdir(join(root, "installed"));
    await symlink(
      join(actual, "otter"),
      join(root, "installed", "otter"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      library.installImport({
        ...operation(),
        reviewId: review.reviewId,
        petIds: ["otter"],
        replacePetIds: ["otter"],
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect((await readFile(join(actual, "otter", "spritesheet.webp"))).equals(sheet)).toBe(true);
  });

  it("命名为允许文件的 junction 不能作为 pet.json 读取", async () => {
    const path = await writePet(join(root, "source"), "otter");
    await rm(join(path, "pet.json"));
    await mkdir(join(root, "outside"));
    await symlink(
      join(root, "outside"),
      join(path, "pet.json"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const { library } = makeLibrary();
    const review = await library.prepareImport("directory", 11);
    expect(review?.candidates).toEqual([]);
    expect(review?.warnings).toEqual([expect.stringContaining("UNSAFE_PATH")]);
  });

  it("命名为 spritesheet.webp 的文件符号链接被拒绝", async (context) => {
    const path = await writePet(join(root, "source"), "otter");
    await rm(join(path, "spritesheet.webp"));
    await writeFile(join(root, "outside.webp"), sheet);
    try {
      await symlink(join(root, "outside.webp"), join(path, "spritesheet.webp"), "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip(true, "Windows 当前账户无文件符号链接权限；junction 安全边界另有实际测试");
        return;
      }
      throw error;
    }
    const { library } = makeLibrary();
    const review = await library.prepareImport("directory", 11);
    expect(review?.candidates).toEqual([]);
    expect(review?.warnings).toEqual([expect.stringContaining("UNSAFE_PATH")]);
  });
});

describe("桌宠二期原子修改与显式取消", () => {
  it("默认拒绝重复安装，失败后 review 不可复用；显式确认才可覆盖", async () => {
    await writePet(join(root, "installed"), "otter", "原安装");
    const { library } = makeLibrary();
    const review = await preparePet(library);
    expect(review.candidates[0]?.alreadyInstalled).toBe(true);
    await expect(
      library.installImport({ ...operation(), reviewId: review.reviewId, petIds: ["otter"] }),
    ).rejects.toMatchObject({ code: "ALREADY_INSTALLED" });
    expect((await library.listInstalled())[0]?.displayName).toBe("原安装");
    await expect(
      library.installImport({
        ...operation(),
        reviewId: review.reviewId,
        petIds: ["otter"],
        replacePetIds: ["otter"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    const confirmed = await library.prepareImport("directory", 11);
    await library.installImport({
      ...operation(),
      reviewId: confirmed!.reviewId,
      petIds: ["otter"],
      replacePetIds: ["otter"],
    });
    expect((await library.listInstalled())[0]?.displayName).toBe("原始宠物");
    expect(await readdir(join(root, "installed"))).toEqual(["otter"]);
  });

  it("已活动宠物不可删除或替换，切换后才可删除", async () => {
    await writePet(join(root, "installed"), "otter", "活动宠物");
    activePetId = "otter";
    const { library } = makeLibrary();
    const review = await preparePet(library);
    await expect(library.deleteInstalled({ ...operation(), petId: "otter" })).rejects.toMatchObject(
      { code: "PET_IN_USE" },
    );
    await expect(
      library.installImport({
        ...operation(),
        reviewId: review.reviewId,
        petIds: ["otter"],
        replacePetIds: ["otter"],
      }),
    ).rejects.toMatchObject({ code: "PET_IN_USE" });
    expect((await library.listInstalled())[0]?.displayName).toBe("活动宠物");
    activePetId = "other";
    const params = operation();
    await library.deleteInstalled({ ...params, petId: "otter" });
    expect(await library.listInstalled()).toEqual([]);
    expect(params.reportProgress).toHaveBeenLastCalledWith({
      operationId: params.operationId,
      phase: "completed",
      completed: 1,
      total: 1,
      petId: "otter",
    });
  });

  it.skipIf(process.platform !== "win32").each(["删除", "替换"])(
    "Windows 大小写别名也不能%s活动宠物",
    async (action) => {
      await writePet(join(root, "installed"), "otter", "活动宠物");
      activePetId = "otter";
      const { library } = makeLibrary();
      const review = await preparePet(library, "Otter");
      expect(review.candidates[0]?.alreadyInstalled).toBe(true);
      if (action === "删除") {
        await expect(
          library.deleteInstalled({ ...operation(), petId: "Otter" }),
        ).rejects.toMatchObject({ code: "PET_IN_USE" });
      } else {
        await expect(
          library.installImport({
            ...operation(),
            reviewId: review.reviewId,
            petIds: ["Otter"],
            replacePetIds: ["Otter"],
          }),
        ).rejects.toMatchObject({ code: "PET_IN_USE" });
      }
      expect((await library.listInstalled())[0]?.displayName).toBe("活动宠物");
    },
  );

  it("注入 staging rename 失败时恢复原安装并清理 staging/backup", async () => {
    await writePet(join(root, "installed"), "otter", "必须保留");
    const failure = new Error("测试注入：提交 rename 失败");
    const renamePath = vi.fn<typeof rename>(async (from, to) => {
      if (String(from).includes(".staging-")) throw failure;
      await rename(from, to);
    });
    const { library } = makeLibrary({ filesystem: { rename: renamePath } });
    const review = await preparePet(library);
    await expect(
      library.installImport({
        ...operation(),
        reviewId: review.reviewId,
        petIds: ["otter"],
        replacePetIds: ["otter"],
      }),
    ).rejects.toBe(failure);
    expect(renamePath).toHaveBeenCalledTimes(3);
    expect((await library.listInstalled())[0]?.displayName).toBe("必须保留");
    expect(
      (await readFile(join(root, "installed", "otter", "spritesheet.webp"))).equals(sheet),
    ).toBe(true);
    expect(await readdir(join(root, "installed"))).toEqual(["otter"]);
  });

  it("新安装提交失败不留下半成品", async () => {
    const { library } = makeLibrary({
      filesystem: {
        rename: async () => {
          throw new Error("测试注入：提交失败");
        },
      },
    });
    const review = await preparePet(library);
    await expect(
      library.installImport({ ...operation(), reviewId: review.reviewId, petIds: ["otter"] }),
    ).rejects.toThrow("测试注入：提交失败");
    expect(await readdir(join(root, "installed"))).toEqual([]);
  });

  it("删除拒绝包含功能外额外数据的目录", async () => {
    const path = await writePet(join(root, "installed"), "otter");
    await writeFile(join(path, "用户数据.txt"), "不可删除");
    const { library } = makeLibrary();
    await expect(library.deleteInstalled({ ...operation(), petId: "otter" })).rejects.toMatchObject(
      { code: "UNSAFE_PATH" },
    );
    expect(await readFile(join(path, "用户数据.txt"), "utf8")).toBe("不可删除");
  });

  it("取消必须同时匹配操作 ID 与 owner；仅匹配一项不能取消其他窗口", async () => {
    const started = deferred();
    const release = deferred();
    const renamePath: typeof rename = async (from, to) => {
      if (String(from).includes(".staging-") && String(to).endsWith("first")) {
        started.resolve();
        await release.promise;
      }
      await rename(from, to);
    };
    const { library } = makeLibrary({ filesystem: { rename: renamePath } });
    await writePet(join(root, "source"), "first");
    await writePet(join(root, "source"), "second");
    await writePet(join(root, "source"), "cancelled");
    const reviews = await Promise.all(
      [11, 22, 33].map((owner) => library.prepareImport("directory", owner)),
    );
    const first = operation(11);
    const second = operation(22);
    const cancelled = operation(33);
    const firstRun = library.installImport({
      ...first,
      reviewId: reviews[0]!.reviewId,
      petIds: ["first"],
    });
    await started.promise;
    const secondRun = library.installImport({
      ...second,
      reviewId: reviews[1]!.reviewId,
      petIds: ["second"],
    });
    const cancelledRun = library.installImport({
      ...cancelled,
      reviewId: reviews[2]!.reviewId,
      petIds: ["cancelled"],
    });
    const cancelledResult = expect(cancelledRun).rejects.toMatchObject({ code: "CANCELLED" });
    try {
      library.cancelOperation(second.operationId, 11);
      library.cancelOperation(randomUUID(), 22);
      library.cancelOperation(cancelled.operationId, 33);
      await expect(
        library.deleteInstalled({
          ...operation(99),
          operationId: second.operationId,
          petId: "second",
        }),
      ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    } finally {
      release.resolve();
    }
    await Promise.all([firstRun, secondRun, cancelledResult]);
    expect((await library.listInstalled()).map((pet) => pet.id)).toEqual(["first", "second"]);
    expect(cancelled.reportProgress).not.toHaveBeenCalled();
  });

  it("setActive 与目录提交使用同一队列，未提交完成不能提前应用活动设置", async () => {
    const started = deferred();
    const release = deferred();
    const { library } = makeLibrary({
      filesystem: {
        rename: async (from, to) => {
          started.resolve();
          await release.promise;
          await rename(from, to);
        },
      },
    });
    const review = await preparePet(library);
    const installation = library.installImport({
      ...operation(),
      reviewId: review.reviewId,
      petIds: ["otter"],
    });
    await started.promise;
    const apply = vi.fn(async () => {
      activePetId = "otter";
    });
    const activation = library.setActive("otter", apply);
    try {
      expect(apply).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await Promise.all([installation, activation]);
    expect(apply).toHaveBeenCalledOnce();
    await expect(library.deleteInstalled({ ...operation(), petId: "otter" })).rejects.toMatchObject(
      { code: "PET_IN_USE" },
    );
    await expect(library.setActive("missing", apply)).rejects.toMatchObject({
      code: "INVALID_PET",
    });
  });

  it("市场经 library 下载校验后原子安装并保存来源，重复默认拒绝、明确确认可覆盖", async () => {
    const { fetcher, revision } = mockMarketFetcher();
    const { library } = makeLibrary({ fetcher });
    const params = operation();
    await library.installMarketPet({ ...params, petId: "market-otter" });
    expect(params.reportProgress.mock.calls.map(([progress]) => progress.phase)).toEqual([
      "downloading",
      "downloading",
      "downloading",
      "verifying",
      "installing",
      "completed",
    ]);
    expect(
      params.reportProgress.mock.calls.every(
        ([progress]) => progress.operationId === params.operationId,
      ),
    ).toBe(true);
    expect((await library.listInstalled())[0]).toMatchObject({
      id: "market-otter",
      source: "market",
      license: { text: "CC BY-NC 4.0", commercialUse: "nonCommercial", attribution: "测试作者" },
    });
    expect(
      JSON.parse(
        await readFile(join(root, "installed", "market-otter", ".zcode-provenance.json"), "utf8"),
      ),
    ).toMatchObject({
      source: "market",
      sourceRef: revision,
      assetSha256: petAssetHash(sheet),
      author: "测试作者",
    });
    expect((await library.listMarket()).items[0]?.installed).toBe(true);
    await expect(
      library.installMarketPet({ ...operation(), petId: "market-otter" }),
    ).rejects.toMatchObject({ code: "ALREADY_INSTALLED" });
    await library.installMarketPet({
      ...operation(),
      petId: "market-otter",
      replaceExisting: true,
    });
    activePetId = "market-otter";
    await expect(
      library.installMarketPet({ ...operation(), petId: "market-otter", replaceExisting: true }),
    ).rejects.toMatchObject({ code: "PET_IN_USE" });
    expect(await readdir(join(root, "installed"))).toEqual(["market-otter"]);
  });

  it.each([true, false])(
    "市场安装支持异步尺寸解码，不能忽略 Promise 返回值（有效=%s）",
    async (valid) => {
      const { fetcher } = mockMarketFetcher();
      const { library } = makeLibrary({
        fetcher,
        decodeImageSize: async () => (valid ? { width: 1536, height: 1872 } : null),
      });
      const run = library.installMarketPet({ ...operation(), petId: "market-otter" });
      if (valid) {
        await run;
        expect((await library.listInstalled())[0]?.id).toBe("market-otter");
      } else {
        await expect(run).rejects.toMatchObject({ code: "INVALID_PET" });
        await expect(lstat(join(root, "installed"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("市场 SHA 不符在创建 staging 前拒绝，不留下宠物目录", async () => {
    const { fetcher, manifest } = mockMarketFetcher();
    manifest.pets["market-otter"].spritesheetSha256 = "0".repeat(64);
    const { library } = makeLibrary({ fetcher });
    await expect(
      library.installMarketPet({ ...operation(), petId: "market-otter" }),
    ).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    await expect(lstat(join(root, "installed"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("显式取消正在下载的市场操作，中止注入 fetcher 且不提交安装目录", async () => {
    const started = deferred();
    const { fetcher } = mockMarketFetcher((url, init) => {
      if (!url.endsWith("/pets/market-otter/pet.json")) return undefined;
      return new Promise<Response>((_resolve, reject) => {
        const abort = init?.signal;
        if (!abort) throw new Error("市场请求缺少取消信号");
        const onAbort = () => reject(abort.reason);
        if (abort.aborted) onAbort();
        else abort.addEventListener("abort", onAbort, { once: true });
        started.resolve();
      });
    });
    const { library } = makeLibrary({ fetcher });
    const params = operation();
    const run = library.installMarketPet({ ...params, petId: "market-otter" });
    const result = expect(run).rejects.toMatchObject({ code: "CANCELLED" });
    await started.promise;
    library.cancelOperation(params.operationId, params.ownerId);
    await result;
    expect(params.reportProgress.mock.calls.map(([progress]) => progress.phase)).toEqual([
      "downloading",
    ]);
    await expect(lstat(join(root, "installed"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("关闭库后拒绝继续扫描或使用旧 review", async () => {
    const { library } = makeLibrary();
    const review = await preparePet(library);
    library.dispose();
    await expect(library.prepareImport("directory", 11)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(
      library.installImport({ ...operation(), reviewId: review.reviewId, petIds: ["otter"] }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
});
