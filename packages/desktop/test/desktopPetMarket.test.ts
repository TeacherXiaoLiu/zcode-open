import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopPetMarket } from "../src/main/desktopPet/desktopPetMarket.js";
import {
  PET_SHEET_LIMIT,
  petAssetHash,
  resolvePetLicense,
} from "../src/main/desktopPet/desktopPetPackage.js";

const repository = "legeling/awesome-codex-pet";
const api = `https://api.github.com/repos/${repository}`;
const raw = `https://raw.githubusercontent.com/${repository}`;
const revision = "a".repeat(40);
let root: string;
let sheet: Buffer;
beforeAll(async () => {
  sheet = await readFile(
    fileURLToPath(
      new URL("../resources/pets/desk-otter--zihualiu1997/spritesheet.webp", import.meta.url),
    ),
  );
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-pet-market-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

type CatalogRow = {
  slug: string;
  name: string;
  primary_category?: string;
  license?: string;
  author?: string;
  author_url?: string;
  localized_names?: Record<string, string>;
  collections?: string[];
  description?: string;
};
function catalogFixture(
  catalog: CatalogRow[] = [
    {
      slug: "otter",
      name: "Desk Otter",
      primary_category: "Animals",
      localized_names: { "zh-CN": "书桌水獭" },
      author: "作者甲",
      license: "CC BY-NC 4.0",
      collections: ["工作伙伴"],
      author_url: "https://example.com/author",
    },
    {
      slug: "luna",
      name: "Luna",
      primary_category: "Characters",
      license: "MIT License",
      author: "作者乙",
    },
    {
      slug: "mystery",
      name: "Mystery",
      description: "神秘宠物",
      author_url: "javascript:alert(1)",
    },
  ],
) {
  const files = new Map<string, Buffer>();
  const pets: Record<
    string,
    {
      petJsonSha256: string;
      petJsonBytes: number;
      spritesheetSha256: string;
      spritesheetBytes: number;
      spritesheetWidth: number;
      spritesheetHeight: number;
      spriteVersionNumber: number;
    }
  > = Object.create(null);
  for (const item of catalog) {
    const json = Buffer.from(JSON.stringify({ id: item.slug, displayName: item.name }));
    files.set(`pets/${item.slug}/pet.json`, json);
    files.set(`pets/${item.slug}/spritesheet.webp`, sheet);
    pets[item.slug] = {
      petJsonSha256: petAssetHash(json),
      petJsonBytes: json.length,
      spritesheetSha256: petAssetHash(sheet),
      spritesheetBytes: sheet.length,
      spritesheetWidth: 1536,
      spritesheetHeight: 1872,
      spriteVersionNumber: 1,
    };
  }
  // 上游实际清单的 ref 是 main，不是 commit SHA；校验固定在请求 URL 中的已解析 revision。
  return {
    revision,
    catalog,
    files,
    manifest: { schemaVersion: 1, repository, ref: "main", pets },
  };
}
function response(value: unknown, status = 200) {
  return new Response(value instanceof Buffer ? Uint8Array.from(value) : JSON.stringify(value), {
    status,
  });
}
function makeMarket(
  fixture = catalogFixture(),
  override?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const overridden = await override?.(url, init);
    if (overridden) return overridden;
    if (url === `${api}/git/ref/heads/main`)
      return response({
        ref: "refs/heads/main",
        object: { type: "commit", sha: fixture.revision },
      });
    if (url === `${raw}/${fixture.revision}/pets.json`) return response(fixture.catalog);
    if (url === `${raw}/${fixture.revision}/install-manifest.json`)
      return response(fixture.manifest);
    const prefix = `${raw}/${fixture.revision}/`;
    const file = url.startsWith(prefix) ? fixture.files.get(url.slice(prefix.length)) : undefined;
    if (file) return response(file);
    if (url.startsWith("https://codexpet.top/assets/previews/")) return response({}, 404);
    throw new Error(`测试拒绝未登记的网络请求：${url}`);
  });
  // 原生解码器以已知尺寸注入；真实 WebP 资产的头部仍由实现实际解析。
  const market = createDesktopPetMarket({
    previewRootDir: join(root, "previews"),
    fetcher,
    decodeImageSize: () => ({ width: 1536, height: 1872 }),
  });
  return { market, fetcher, fixture };
}
const signal = () => new AbortController().signal;

describe("桌宠市场固定 revision 与真实清单形状", () => {
  it("先解析 API git/ref/heads/main，catalog/manifest/资产均只读取固定 SHA；接受 ref:main", async () => {
    const { market, fetcher, fixture } = makeMarket();
    const page = await market.list({}, new Set(["otter"]));
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${api}/git/ref/heads/main`);
    expect(page.items.map((item) => item.id)).toEqual(["otter", "luna", "mystery"]);
    expect(page.items[0]?.installed).toBe(true);
    const report = vi.fn();
    const downloaded = await market.download("otter", signal(), report);
    expect(report).toHaveBeenCalledTimes(2);
    expect(downloaded.pet.files["spritesheet.webp"]!.equals(sheet)).toBe(true);
    expect(downloaded.provenance).toMatchObject({
      source: "market",
      sourceRef: revision,
      sourceUrl: `https://github.com/${repository}/tree/${revision}/pets/otter`,
      assetSha256: petAssetHash(sheet),
      author: "作者甲",
      license: { text: "CC BY-NC 4.0", commercialUse: "nonCommercial", attribution: "作者甲" },
    });
    const requests = fetcher.mock.calls.map(([url]) => String(url));
    expect(requests).toContain(`${raw}/${revision}/pets.json`);
    expect(requests).toContain(`${raw}/${revision}/install-manifest.json`);
    expect(requests).toContain(`${raw}/${revision}/pets/otter/pet.json`);
    expect(requests).toContain(`${raw}/${revision}/pets/otter/spritesheet.webp`);
    expect(requests.some((url) => url.startsWith(`${raw}/main/`))).toBe(false);
    expect(fixture.manifest.ref).toBe("main");
    for (const [, init] of fetcher.mock.calls)
      expect(init).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
  });

  it("缓存中安装仍固定原 SHA，显式刷新才解析新的 main revision", async () => {
    const fixture = catalogFixture();
    const { market, fetcher } = makeMarket(fixture, (url) => {
      const prefix = `${raw}/${revision}/pets/`;
      if (!url.startsWith(prefix)) return undefined;
      const bytes = fixture.files.get(`pets/${url.slice(prefix.length)}`);
      return bytes ? response(bytes) : undefined;
    });
    await market.list({ limit: 1 }, new Set());
    fixture.revision = "b".repeat(40);
    const downloaded = await market.download("otter", signal(), vi.fn());
    expect(downloaded.provenance.sourceRef).toBe(revision);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url) === `${api}/git/ref/heads/main`),
    ).toHaveLength(1);
    await market.list({ refresh: true, limit: 1 }, new Set());
    expect(
      fetcher.mock.calls.filter(([url]) => String(url) === `${api}/git/ref/heads/main`),
    ).toHaveLength(2);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toContain(
      `${raw}/${"b".repeat(40)}/pets.json`,
    );
  });

  it.each(["main", "a".repeat(39), "z".repeat(40), null])(
    "无法取得可信 SHA %j 时不继续下载 catalog",
    async (sha) => {
      const { market, fetcher } = makeMarket(undefined, (url) =>
        url.endsWith("/git/ref/heads/main") ? response({ object: { sha } }) : undefined,
      );
      await expect(market.list({}, new Set())).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("不接受没有安装完整性条目的目录，失败后可重新加载", async () => {
    const fixture = catalogFixture();
    fixture.manifest.pets = {};
    const { market } = makeMarket(fixture);
    await expect(market.list({}, new Set())).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    fixture.manifest.pets = catalogFixture().manifest.pets;
    expect((await market.list({}, new Set())).total).toBe(3);
  });

  it("跨仓库安装清单、坏 JSON、缺少必需字段一律拒绝", async () => {
    for (const manifest of [
      { ...catalogFixture().manifest, repository: "other/repository" },
      { schemaVersion: 1 },
    ]) {
      const { market } = makeMarket(undefined, (url) =>
        url.endsWith("/install-manifest.json") ? response(manifest) : undefined,
      );
      await expect(market.list({}, new Set())).rejects.toThrow();
    }
    const { market } = makeMarket(undefined, (url) =>
      url.endsWith("/pets.json") ? new Response("{bad") : undefined,
    );
    await expect(market.list({}, new Set())).rejects.toThrow();
  });
});

describe("桌宠市场搜索分类分页与许可", () => {
  it("按本地化名称、作者、collection 和多个词搜索并应用分类", async () => {
    const { market } = makeMarket();
    for (const query of ["书桌水獭", "作者甲", "工作伙伴", "  DESK   otter  "]) {
      const page = await market.list({ query, category: "Animals" }, new Set());
      expect(page.items.map((item) => item.id)).toEqual(["otter"]);
      expect(page.total).toBe(1);
      expect(page.categories).toEqual(["Animals", "Characters", "Other"]);
    }
    expect((await market.list({ query: "Desk", category: "Characters" }, new Set())).items).toEqual(
      [],
    );
    expect((await market.list({ category: "不存在" }, new Set())).items).toEqual([]);
  });

  it("分类列表显示的 Other 能筛出没有 primary_category 的宠物", async () => {
    const { market } = makeMarket();
    expect((await market.list({}, new Set())).categories).toContain("Other");
    const page = await market.list({ category: "Other" }, new Set());
    expect(page.items.map((item) => item.id)).toEqual(["mystery"]);
    expect(page.total).toBe(1);
  });

  it("分页游标和总数一致，末页不返回 nextCursor，超出范围为空页", async () => {
    const { market } = makeMarket();
    const first = await market.list({ limit: 2 }, new Set());
    expect(first).toMatchObject({ total: 3, nextCursor: "2" });
    expect(first.items.map((item) => item.id)).toEqual(["otter", "luna"]);
    const last = await market.list({ limit: 2, cursor: first.nextCursor }, new Set());
    expect(last.items.map((item) => item.id)).toEqual(["mystery"]);
    expect(last.nextCursor).toBeUndefined();
    expect((await market.list({ cursor: "999" }, new Set())).items).toEqual([]);
    for (const cursor of ["../1", "-1", "1.5", "123456789"]) {
      await expect(market.list({ cursor }, new Set())).rejects.toMatchObject({
        code: "INVALID_SOURCE",
      });
    }
  });

  it("未知与非商业许可保持原文，缺失作者不能被推断为 MIT，不显示非 HTTPS 作者链接", async () => {
    const { market } = makeMarket();
    const page = await market.list({}, new Set());
    expect(page.items[0]?.license).toMatchObject({
      text: "CC BY-NC 4.0",
      commercialUse: "nonCommercial",
    });
    expect(page.items[1]?.license).toMatchObject({ text: "MIT License", commercialUse: "allowed" });
    expect(page.items[2]).toMatchObject({
      license: { text: "Unknown license", commercialUse: "unknown" },
      author: "Unknown author",
      category: "Other",
    });
    expect(page.items[2]?.authorUrl).toBeUndefined();
    expect((await market.download("mystery", signal(), vi.fn())).provenance.license).toEqual({
      text: "Unknown license",
      commercialUse: "unknown",
    });
  });

  it.each([
    ["submitter provided this image", "unknown"],
    ["MIT License", "allowed"],
    ["CC0", "allowed"],
    ["CC BY 4.0", "allowed"],
    ["Apache-2.0", "allowed"],
    ["MIT License; non-commercial only", "nonCommercial"],
    ["禁止商用", "nonCommercial"],
    ["仅限个人", "nonCommercial"],
    [undefined, "unknown"],
  ])("许可 %j 分类为 %s", (text, commercialUse) => {
    expect(resolvePetLicense(text).commercialUse).toBe(commercialUse);
  });

  it("坏 ID、大小写重复 slug 和未校验 manifest 被排除，未知 pet 下载拒绝", async () => {
    const fixture = catalogFixture([
      { slug: "otter", name: "正常" },
      { slug: "Otter", name: "重复" },
      { slug: "../escape", name: "不安全" },
      { slug: "missing", name: "无清单" },
    ]);
    delete fixture.manifest.pets.missing;
    const { market } = makeMarket(fixture);
    expect((await market.list({}, new Set())).items.map((item) => item.id)).toEqual(["otter"]);
    await expect(market.download("unknown", signal(), vi.fn())).rejects.toMatchObject({
      code: "INVALID_PET",
    });
    await expect(market.download("../escape", signal(), vi.fn())).rejects.toMatchObject({
      code: "INVALID_PET",
    });
  });

  it("缩略图 404 不阻塞卡片或安装，不暴露不可信 URL", async () => {
    const { market } = makeMarket();
    const page = await market.list({}, new Set());
    expect(page.items.every((item) => item.previewUrl === undefined)).toBe(true);
    await expect(market.download("otter", signal(), vi.fn())).resolves.toMatchObject({
      pet: { manifest: { id: "otter" } },
    });
  });
});

describe("桌宠市场资产完整性与 API 降级", () => {
  it.each(["petJsonSha256", "petJsonBytes", "spritesheetSha256", "spritesheetBytes"] as const)(
    "%s 不符必须拒绝",
    async (field) => {
      const fixture = catalogFixture();
      const integrity = fixture.manifest.pets.otter!;
      if (field === "petJsonSha256" || field === "spritesheetSha256")
        integrity[field] = "0".repeat(64);
      else integrity[field] += 1;
      const { market } = makeMarket(fixture);
      await expect(market.download("otter", signal(), vi.fn())).rejects.toMatchObject({
        code: "HASH_MISMATCH",
        petId: "otter",
      });
    },
  );

  it("即使 SHA 和大小匹配，也拒绝清单版本与图集声明不符", async () => {
    const fixture = catalogFixture();
    fixture.manifest.pets.otter!.spriteVersionNumber = 2;
    const { market } = makeMarket(fixture);
    await expect(market.download("otter", signal(), vi.fn())).rejects.toMatchObject({
      code: "INVALID_PET",
    });
  });

  it.each(["content", "blob"])(
    "raw 不可达时通过固定 revision 的 %s API 回退，仍校验原 SHA",
    async (fallback) => {
      const fixture = catalogFixture();
      const blobSha = "c".repeat(40);
      const blobs = new Map<string, Buffer>();
      const { market, fetcher } = makeMarket(fixture, (url) => {
        if (url.startsWith(`${raw}/`)) return response({}, 503);
        if (url.startsWith(`${api}/contents/`)) {
          const parsed = new URL(url);
          expect(parsed.searchParams.get("ref")).toBe(revision);
          const path = parsed.pathname.split("/contents/")[1]!;
          const bytes =
            path === "pets.json"
              ? Buffer.from(JSON.stringify(fixture.catalog))
              : path === "install-manifest.json"
                ? Buffer.from(JSON.stringify(fixture.manifest))
                : fixture.files.get(path)!;
          if (fallback === "content")
            return response({
              encoding: "base64",
              content: bytes.toString("base64"),
              size: bytes.length,
              sha: blobSha,
            });
          const sha = petAssetHash(bytes).slice(0, 40);
          blobs.set(sha, bytes);
          return response({ encoding: "none", content: "", size: bytes.length, sha });
        }
        if (url.startsWith(`${api}/git/blobs/`)) {
          const bytes = blobs.get(url.split("/").at(-1)!)!;
          return response({ encoding: "base64", content: bytes.toString("base64") });
        }
        return undefined;
      });
      const result = await market.download("otter", signal(), vi.fn());
      expect(result.pet.files["spritesheet.webp"]!.equals(sheet)).toBe(true);
      expect(result.provenance.sourceRef).toBe(revision);
      expect(fetcher.mock.calls.map(([url]) => String(url))).toContain(
        `${api}/contents/pets/otter/spritesheet.webp?ref=${revision}`,
      );
      if (fallback === "blob")
        expect(fetcher.mock.calls.some(([url]) => String(url).includes("/git/blobs/"))).toBe(true);
    },
  );

  it("API 回退返回篡改资产仍拒绝，而非绕过完整性校验", async () => {
    const fixture = catalogFixture();
    const { market } = makeMarket(fixture, (url) => {
      if (url === `${raw}/${revision}/pets/otter/pet.json`) return response({}, 503);
      if (url === `${api}/contents/pets/otter/pet.json?ref=${revision}`) {
        const bytes = Buffer.from(JSON.stringify({ id: "otter", displayName: "被篡改" }));
        return response({
          encoding: "base64",
          size: bytes.length,
          content: bytes.toString("base64"),
        });
      }
      return undefined;
    });
    await expect(market.download("otter", signal(), vi.fn())).rejects.toMatchObject({
      code: "HASH_MISMATCH",
    });
  });

  it("content-length 超限不会尝试 API 回退", async () => {
    const { market, fetcher } = makeMarket(undefined, (url) =>
      url.endsWith("/pets/otter/spritesheet.webp")
        ? new Response(Uint8Array.from(sheet), {
            headers: { "content-length": String(PET_SHEET_LIMIT + 1) },
          })
        : undefined,
    );
    await expect(market.download("otter", signal(), vi.fn())).rejects.toMatchObject({
      code: "SIZE_LIMIT",
    });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/contents/"))).toBe(false);
  });

  it("没有 content-length 时实际读取超过上限仍拒绝并取消响应流", async () => {
    const cancel = vi.fn();
    const { market } = makeMarket(undefined, (url) => {
      if (!url.endsWith("/pets/otter/spritesheet.webp")) return undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(PET_SHEET_LIMIT + 1));
          },
          cancel,
        }),
      );
    });
    await expect(market.download("otter", signal(), vi.fn())).rejects.toMatchObject({
      code: "SIZE_LIMIT",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("已取消下载不发起 contents 回退", async () => {
    const abort = new AbortController();
    const { market, fetcher } = makeMarket(undefined, (url, init) => {
      if (!url.includes("/pets/otter/pet.json")) return undefined;
      abort.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException("测试取消下载", "AbortError");
    });
    await expect(market.download("otter", abort.signal, vi.fn())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/contents/"))).toBe(false);
  });
});
