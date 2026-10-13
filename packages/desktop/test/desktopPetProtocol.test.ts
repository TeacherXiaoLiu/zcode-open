import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installDesktopPetPackProtocol } from "../src/main/desktopPet/desktopPetProtocol.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("桌宠 petpack 协议", () => {
  it("允许名为 market-preview 的普通宠物加载精灵表", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-pet-protocol-"));
    roots.push(root);
    await mkdir(join(root, "market-preview"), { recursive: true });
    const sheet = join(root, "market-preview", "spritesheet.webp");
    await writeFile(sheet, "test");
    let handler: ((request: { url: string }, callback: (response: string | { error: number }) => void) => void) | undefined;
    installDesktopPetPackProtocol(
      { registerFileProtocol: (_scheme, value) => { handler = value; return true; } },
      { petsRootDir: root, marketPreviewRootDir: join(root, "previews") },
    );
    const result = await new Promise<string | { error: number }>((resolve) => {
      handler?.({ url: "petpack://market-preview/spritesheet.webp" }, resolve);
    });
    expect(result).toBe(sheet);
  });
});
