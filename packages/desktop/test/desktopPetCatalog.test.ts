import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureBundledDesktopPetsInstalled,
  listInstalledDesktopPets,
  readDesktopPetManifest,
} from "../src/main/desktopPet/desktopPetCatalog.js";

/** 桌面宠物目录校验（本地定制，specs/desktop/desktop-pet.md 格式契约）。 */

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "zcode-pets-"));
}

function writePet(
  root: string,
  id: string,
  manifest: unknown,
  options: { withSpritesheet?: boolean } = {},
): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pet.json"), JSON.stringify(manifest));
  if (options.withSpritesheet !== false) {
    writeFileSync(join(dir, "spritesheet.webp"), "RIFF0000WEBPVP8L");
  }
}

describe("desktopPetCatalog", () => {
  it("接受 v1（可省略版本号）并按 8×9 几何归一", () => {
    const root = makeRoot();
    writePet(root, "otter", { id: "otter", displayName: "Otter" });
    const manifest = readDesktopPetManifest("otter", root);
    expect(manifest).toEqual({
      id: "otter",
      displayName: "Otter",
      spriteVersionNumber: 1,
      columns: 8,
      rows: 9,
      frameWidth: 192,
      frameHeight: 208,
      frameCount: 72,
    });
  });

  it("v2 必须显式声明并按 8×11 几何归一", () => {
    const root = makeRoot();
    writePet(root, "luna", {
      id: "luna",
      displayName: "Luna",
      description: "moon pet",
      spriteVersionNumber: 2,
    });
    const manifest = readDesktopPetManifest("luna", root);
    expect(manifest?.spriteVersionNumber).toBe(2);
    expect(manifest?.rows).toBe(11);
    expect(manifest?.frameCount).toBe(88);
    expect(manifest?.description).toBe("moon pet");
  });

  it("id 与目录不符 / 精灵表路径越界 / 版本非法都拒绝", () => {
    const root = makeRoot();
    writePet(root, "a--wrong-id", { id: "other", displayName: "X" });
    expect(readDesktopPetManifest("a--wrong-id", root)).toBeNull();

    writePet(root, "b--bad-sheet", {
      id: "b--bad-sheet",
      displayName: "B",
      spritesheetPath: "../escape.webp",
    });
    expect(readDesktopPetManifest("b--bad-sheet", root)).toBeNull();

    writePet(root, "c--bad-version", {
      id: "c--bad-version",
      displayName: "C",
      spriteVersionNumber: 3,
    });
    expect(readDesktopPetManifest("c--bad-version", root)).toBeNull();
  });

  it("缺 pet.json / 缺 spritesheet.webp / 坏 JSON 都拒绝且不影响其他宠物", () => {
    const root = makeRoot();
    writePet(root, "ok--pet", { id: "ok--pet", displayName: "OK" });
    writePet(root, "no-sheet", { id: "no-sheet", displayName: "NoSheet" }, { withSpritesheet: false });
    mkdirSync(join(root, "bad-json"), { recursive: true });
    writeFileSync(join(root, "bad-json", "pet.json"), "{not json");
    writeFileSync(join(root, "bad-json", "spritesheet.webp"), "RIFF");

    const installed = listInstalledDesktopPets(root);
    expect(installed.map((pet) => pet.id)).toEqual(["ok--pet"]);
  });

  it("内置宠物只复制缺失项，不覆盖用户目录已有内容", () => {
    const bundled = makeRoot();
    const user = makeRoot();
    writePet(bundled, "desk-otter--zihualiu1997", {
      id: "desk-otter--zihualiu1997",
      displayName: "Desk Otter",
    });
    // 用户目录已有同名（修改过的）宠物：不能被内置版覆盖。
    writePet(user, "desk-otter--zihualiu1997", {
      id: "desk-otter--zihualiu1997",
      displayName: "User Edited Otter",
    });

    ensureBundledDesktopPetsInstalled(bundled, user);
    expect(readDesktopPetManifest("desk-otter--zihualiu1997", user)?.displayName).toBe(
      "User Edited Otter",
    );

    // 缺失的会补齐。
    writePet(bundled, "extra--pet", { id: "extra--pet", displayName: "Extra" });
    ensureBundledDesktopPetsInstalled(bundled, user);
    expect(listInstalledDesktopPets(user).map((pet) => pet.id)).toEqual([
      "desk-otter--zihualiu1997",
      "extra--pet",
    ]);
  });
});