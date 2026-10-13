import { describe, expect, it } from "vitest";
import { readSourceText } from "./readSourceText.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

const source = (path: string) => readSourceText(new URL(`../src/${path}`, import.meta.url), "utf8");
const petFiles = [
  "settings/DesktopPetsSection.tsx",
  "settings/DesktopPetSetting.tsx",
  "settings/PetPreview.tsx",
  "settings/PetCards.tsx",
  "settings/PetConfirmationDialogs.tsx",
  "settings/PetImportDialog.tsx",
  "settings/PetOperationStatus.tsx",
];

describe("桌宠 UI 的平台和设计边界", () => {
  it("Pets 分发固定绑定本机服务，不继承远端 Workspace 的设置事实源", () => {
    expect(source("SettingsPage.tsx")).toMatch(
      /activeSection === "pets"[\s\S]*?<ServiceProvider services=\{localHostServices\}>\s*<DesktopPetsSection \/>\s*<\/ServiceProvider>/,
    );
    expect(source("settingsPageHelpers.tsx")).not.toContain("DesktopPetSetting");
  });
  it("旧桌宠卡已复用为独立首页，不保留旧服务或平台直调实现", () => {
    const homepage = source("settings/DesktopPetSetting.tsx");
    expect(homepage).toContain("SettingsGroupCard");
    expect(homepage).toContain("SettingsRow");
    expect(homepage).not.toContain("useSettings");
    expect(homepage).not.toContain("usePlatform");
    expect(homepage).not.toContain("listInstalled");
  });
  it("宠物首页复用自适应紧凑控制列，不改变其他设置行的默认宽度", () => {
    expect(source("settings/DesktopPetSetting.tsx")).toContain('controlLayout="compact"');
    expect(source("settings/SettingsPageParts.tsx")).toContain('controlLayout === "compact"');
    expect(source("settings/SettingsPageParts.tsx")).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(source("settings/SettingsPageParts.tsx")).toContain("grid-cols-[minmax(0,1fr)_192px]");
  });
  it("所有宠物业务平台调用收敛于 hook，页面不访问窗口、网络或文件 IO", () => {
    for (const path of petFiles) {
      const content = source(path);
      expect(content).not.toMatch(
        /window\.zcode|\bfetch\s*\(|node:fs|useServices\s*\(|usePlatform\s*\(|\bplatform\.desktopPet\b/,
      );
    }
    const hook = source("hooks/useDesktopPets.ts");
    expect(hook).toContain("crypto.randomUUID()");
    expect(hook).toContain("progress.operationId !== currentOperation.current?.id");
  });
  it("新增 UI 只用 text-ui 字号、语义主题，并对网格和弹窗限制窄窗宽度", () => {
    for (const path of petFiles) {
      const content = source(path);
      expect(content).not.toMatch(
        /\btext-(?:xs|sm|base|lg|xl|\d+xl)\b|text-\[\d|fontSize|#[0-9a-fA-F]{3,8}\b/,
      );
    }
    expect(source("settings/DesktopPetsSection.tsx")).toContain("minmax(min(100%,10rem),1fr)");
    expect(source("settings/PetImportDialog.tsx")).toContain("overflow-y-auto sm:max-w-2xl");
  });
  it("桌宠全部文案同时提供中英文，包含动态错误、阶段、来源和许可键", () => {
    const keys = Object.keys(zhCN).filter((key) => key.startsWith("settings.desktopPet"));
    expect(keys.length).toBeGreaterThan(80);
    expect(
      Object.keys(enUS)
        .filter((key) => key.startsWith("settings.desktopPet"))
        .sort(),
    ).toEqual(keys.sort());
    for (const key of keys) {
      expect(zhCN[key]).toBeTruthy();
      expect(enUS[key]).toBeTruthy();
    }
    const content = [...petFiles, "hooks/useDesktopPets.ts"].map(source).join("\n");
    for (const match of content.matchAll(/"(settings\.desktopPet\.[\w.]+)"/g)) {
      expect(keys).toContain(match[1]);
    }
  });
});
