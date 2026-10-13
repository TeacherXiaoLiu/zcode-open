// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { PetPreview } from "@/settings/PetPreview.js";
import { InstalledPetCard, MarketPetCard } from "@/settings/PetCards.js";

const wrap = (children: React.ReactNode) =>
  createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, children);
afterEach(cleanup);

describe("宠物缩略图裁切与占位", () => {
  it.each([
    [1, "900%"],
    [2, "1100%"],
  ])("v%s 精灵表只渲染 8 列首帧，不显示整张图集", (version, height) => {
    const html = renderToStaticMarkup(
      wrap(
        createElement(PetPreview, {
          kind: "atlas",
          name: "宠物",
          src: "petpack://pet/spritesheet.webp",
          spriteVersionNumber: version,
        }),
      ),
    );
    expect(html).toContain('data-testid="pet-preview-first-frame"');
    expect(html).toContain(`width:800%;height:${height}`);
    expect(html).toContain("overflow-hidden");
    expect(html).not.toContain("object-contain");
  });

  it("市场预览直接呈现独立图片，不按精灵表裁切", () => {
    const html = renderToStaticMarkup(
      wrap(
        createElement(PetPreview, {
          kind: "image",
          name: "宠物",
          src: "https://example.test/idle.webp",
        }),
      ),
    );
    expect(html).toContain("object-contain");
    expect(html).not.toContain("pet-preview-first-frame");
    expect(html).not.toContain("width:800%");
  });

  it("图片加载中、失败、缺图和切换 URL 都有可见占位", () => {
    const view = render(
      wrap(
        createElement(PetPreview, {
          kind: "image",
          name: "宠物",
          src: "https://example.test/a.webp",
        }),
      ),
    );
    expect(screen.getByText("正在加载预览…")).toBeTruthy();
    fireEvent.error(view.container.querySelector("img")!);
    expect(screen.getByText("预览不可用")).toBeTruthy();
    view.rerender(
      wrap(
        createElement(PetPreview, {
          kind: "image",
          name: "宠物",
          src: "https://example.test/b.webp",
        }),
      ),
    );
    expect(screen.getByText("正在加载预览…")).toBeTruthy();
    fireEvent.load(view.container.querySelector("img")!);
    expect(screen.queryByText("正在加载预览…")).toBeNull();
    view.rerender(wrap(createElement(PetPreview, { kind: "image", name: "宠物" })));
    expect(screen.getByText("预览不可用")).toBeTruthy();
  });

  it("静态卡片展示名称、版本、来源和逐宠物许可，活动卡禁用删除", () => {
    const html = renderToStaticMarkup(
      wrap(
        createElement(InstalledPetCard, {
          pet: {
            id: "pet",
            displayName: "测试宠物",
            spriteVersionNumber: 2,
            source: "codex",
            previewUrl: "petpack://pet/spritesheet.webp",
            license: { text: "CC BY-NC", commercialUse: "nonCommercial" },
          },
          active: true,
          disabled: false,
          onUse: () => {},
          onDelete: () => {},
        }),
      ),
    );
    expect(html).toContain("测试宠物");
    expect(html).toContain("v2 · Codex");
    expect(html).toContain("CC BY-NC");
    expect(html).toContain("仅限非商业使用");
    expect(html).toMatch(/<button(?=[^>]*aria-label="删除 测试宠物")(?=[^>]*disabled)[^>]*>/);
  });

  it("市场卡使用本地化名称和普通缩略图，未知许可不推断商用", () => {
    const html = renderToStaticMarkup(
      wrap(
        createElement(MarketPetCard, {
          pet: {
            id: "pet",
            displayName: "Name",
            localizedNames: { "zh-CN": "中文名" },
            spriteVersionNumber: 1,
            author: "作者",
            category: "分类",
            collections: [],
            installed: false,
            previewUrl: "https://example.test/idle.webp",
            license: { text: "", commercialUse: "unknown" },
          },
          installed: false,
          disabled: false,
          onInstall: () => {},
        }),
      ),
    );
    expect(html).toContain("中文名");
    expect(html).toContain("商业使用权限未知");
    expect(html).toContain("未知许可证");
    expect(html).not.toContain("pet-preview-first-frame");
  });
});
