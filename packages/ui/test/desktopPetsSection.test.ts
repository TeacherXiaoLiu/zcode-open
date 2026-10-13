// @vitest-environment jsdom
import { createElement, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  DesktopPetImportReview,
  DesktopPetMarketItem,
  DesktopPetOperationProgress,
} from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  port: {
    listInstalled: vi.fn(),
    listMarket: vi.fn(),
    prepareImport: vi.fn(),
    installImport: vi.fn(),
    installMarketPet: vi.fn(),
    deleteInstalled: vi.fn(),
    setActive: vi.fn(),
    onOperationProgress: vi.fn(),
    cancelOperation: vi.fn(),
  },
  settings: { desktopPetEnabled: false, desktopPetId: "active", desktopPetScale: 1.25 },
  update: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => ({ desktopPet: h.port }) }));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: h.settings,
    loading: false,
    error: null,
    update: h.update,
    refresh: h.refresh,
  }),
}));
vi.mock("@/settings/SettingsPageParts.js", async () => {
  const { createElement } = await import("react");
  return {
    SettingsGroupCard: ({ children }: { children: React.ReactNode }) =>
      createElement("div", { "data-slot": "card" }, children),
    SettingsRow: ({
      label,
      description,
      control,
      detail,
    }: {
      label: React.ReactNode;
      description?: React.ReactNode;
      control: React.ReactNode;
      detail?: React.ReactNode;
    }) =>
      createElement(
        "div",
        null,
        createElement("div", null, label),
        createElement("div", null, description),
        control,
        detail,
      ),
    // 大小滑条（三期）：把草稿变更与释放提交分别暴露成按钮，便于断言"释放才提交"。
    SettingsCommitOnReleaseRange: ({
      value,
      onChange,
      onCommit,
      valueLabel,
      ariaLabel,
    }: {
      value: number;
      onChange: (value: number) => void;
      onCommit: () => void;
      valueLabel: React.ReactNode;
      ariaLabel: string;
    }) =>
      createElement(
        "div",
        null,
        createElement("span", { "data-slot": "scale-value" }, `${ariaLabel}:${valueLabel}`),
        createElement("button", {
          type: "button",
          "data-testid": "scale-draft",
          onClick: () => onChange(Number(value) + 0.5),
        }),
        createElement("button", { type: "button", "data-testid": "scale-commit", onClick: onCommit }),
      ),
  };
});
import { DesktopPetsSection } from "@/settings/DesktopPetsSection.js";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const license = { text: "MIT", commercialUse: "allowed" as const };
const installed = [
  {
    id: "active",
    displayName: "当前宠物",
    spriteVersionNumber: 2,
    source: "bundled" as const,
    previewUrl: "petpack://active/spritesheet.webp",
    license,
  },
  {
    id: "second",
    displayName: "第二只",
    spriteVersionNumber: 1,
    source: "local" as const,
    previewUrl: "petpack://second/spritesheet.webp",
    license,
  },
];
const market: DesktopPetMarketItem = {
  id: "market",
  displayName: "市场宠物",
  localizedNames: { "zh-CN": "市场小猫" },
  spriteVersionNumber: 1,
  author: "作者",
  category: "动物",
  collections: [],
  installed: false,
  previewUrl: "https://example.test/idle.webp",
  license: { text: "CC BY-NC 4.0", commercialUse: "nonCommercial" },
};
const review: DesktopPetImportReview = {
  reviewId: "review-1",
  expiresAt: Date.now() + 600_000,
  warnings: ["坏 manifest 已跳过"],
  candidates: [
    {
      id: "new",
      displayName: "新宠物",
      spriteVersionNumber: 1,
      source: "directory",
      license,
      alreadyInstalled: false,
    },
    {
      id: "second",
      displayName: "第二只新版",
      spriteVersionNumber: 2,
      source: "directory",
      license,
      alreadyInstalled: true,
    },
  ],
};
let progressListener: (value: DesktopPetOperationProgress) => void;

function Frame() {
  const [items, setItems] = useState<readonly SettingsBreadcrumbItem[]>([]);
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "zh-CN" },
    createElement(
      SettingsBreadcrumbProvider,
      { sectionLabel: "宠物", onItemsChange: setItems },
      createElement(SettingsHeaderBreadcrumb, { ariaLabel: "设置导航", items }),
      createElement(DesktopPetsSection),
    ),
  );
}
async function renderManagement() {
  render(createElement(Frame));
  await screen.findByText("当前宠物 · v2");
  fireEvent.click(screen.getByRole("button", { name: "管理宠物" }));
  await screen.findByRole("heading", { name: "宠物市场" });
  await screen.findByText("市场小猫");
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  // jsdom 不实现滚动定位；Select 的键盘打开流程依赖该浏览器方法。
  Element.prototype.scrollIntoView = vi.fn();
  h.settings.desktopPetId = "active";
  h.settings.desktopPetEnabled = false;
  h.port.listInstalled.mockResolvedValue(installed);
  h.port.listMarket.mockResolvedValue({ items: [market], categories: ["动物"], total: 1 });
  h.port.prepareImport.mockResolvedValue(review);
  h.port.installImport.mockResolvedValue(undefined);
  h.port.installMarketPet.mockResolvedValue(undefined);
  h.port.deleteInstalled.mockResolvedValue(undefined);
  h.port.setActive.mockResolvedValue(undefined);
  h.update.mockResolvedValue(undefined);
  h.refresh.mockResolvedValue(undefined);
  h.port.onOperationProgress.mockImplementation((listener) => {
    progressListener = listener;
    return () => {};
  });
});
afterEach(cleanup);

describe("桌宠页面交互验收", () => {
  it("已安装和市场空态可见，仍保留导入与刷新入口", async () => {
    h.port.listInstalled.mockResolvedValue([]);
    h.port.listMarket.mockResolvedValue({ items: [], categories: [], total: 0 });
    render(createElement(Frame));
    await screen.findByText("尚未安装宠物。可从市场安装，或导入本地宠物。");
    fireEvent.click(screen.getByRole("button", { name: "管理宠物" }));
    await screen.findByText("未找到符合条件的宠物。请调整搜索或分类后重试。");
    expect(screen.getByRole("button", { name: "导入宠物" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
  });

  it("列表加载态及失败后的中文错误与重试按钮可见", async () => {
    let failInstalled!: (error: unknown) => void;
    h.port.listInstalled.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failInstalled = reject;
        }),
    );
    render(createElement(Frame));
    expect(screen.getByText("正在读取已安装宠物…")).toBeTruthy();
    await act(async () => failInstalled(new Error("IO_ERROR: 读取失败")));
    await screen.findByText("读取已安装宠物失败，请重试。");
    expect(screen.getByText("IO_ERROR: 读取失败").closest("details")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("当前宠物 · v2");
    let failMarket!: (error: unknown) => void;
    h.port.listMarket.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failMarket = reject;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "管理宠物" }));
    expect(screen.getByText("正在加载宠物市场…")).toBeTruthy();
    await act(async () => failMarket(new Error("DOWNLOAD_FAILED: 离线")));
    await screen.findByText("加载宠物市场失败，请检查网络后重试。");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("市场小猫");
  });

  it("导入 review 没有候选时显示空态且不能确认安装", async () => {
    h.port.prepareImport.mockResolvedValue({ ...review, candidates: [], warnings: [] });
    await renderManagement();
    fireEvent.click(screen.getByRole("button", { name: "导入宠物" }));
    fireEvent.click(screen.getByRole("button", { name: "扫描并预览" }));
    await screen.findByText("未找到可导入的宠物。请检查来源或另选目录。");
    expect(screen.getByRole("button", { name: "检查所选宠物" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "另选来源" }));
    expect(screen.getByRole("button", { name: "扫描并预览" })).toBeTruthy();
    expect(h.port.installImport).not.toHaveBeenCalled();
  });

  it("首页展示开关、当前名称版本与首帧预览，管理页 breadcrumb 返回首页", async () => {
    render(createElement(Frame));
    await screen.findByText("当前宠物 · v2");
    expect(screen.queryByRole("heading", { name: "宠物市场" })).toBeNull();
    const crop = screen.getByTestId("pet-preview-first-frame");
    expect(crop.querySelector("img")?.style.width).toBe("800%");
    expect(crop.querySelector("img")?.style.height).toBe("1100%");
    fireEvent.click(screen.getByRole("switch", { name: "启用桌面宠物" }));
    await waitFor(() => expect(h.update).toHaveBeenCalledWith({ desktopPetEnabled: true }));
    fireEvent.click(screen.getByRole("button", { name: "管理宠物" }));
    const navigation = await screen.findByRole("navigation", { name: "设置导航" });
    expect(within(navigation).getByText("宠物管理").getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(navigation).getByRole("button", { name: "宠物" }));
    await screen.findByRole("button", { name: "管理宠物" });
    expect(screen.queryByRole("navigation", { name: "设置导航" })).toBeNull();
  });

  it("大小滑条：拖动只改草稿，释放才提交缩放设置", async () => {
    render(createElement(Frame));
    await screen.findByText("当前宠物 · v2");
    // 初始展示已保存的缩放值（测试设置里为 1.25）。
    expect(screen.getByText("大小:125%")).toBeTruthy();
    fireEvent.click(screen.getByTestId("scale-draft"));
    // 草稿变更立即反映在数值上，但不写设置。
    expect(screen.getByText("大小:175%")).toBeTruthy();
    expect(h.update).not.toHaveBeenCalledWith({ desktopPetScale: expect.anything() });
    fireEvent.click(screen.getByTestId("scale-commit"));
    await waitFor(() => expect(h.update).toHaveBeenCalledWith({ desktopPetScale: 1.75 }));
  });

  it("管理页上下网格、來源和使用中状态可见，活动宠物不能删除，其他删除需确认", async () => {
    await renderManagement();
    const active = within(screen.getByTestId("installed-pets-grid")).getAllByTestId(
      "installed-pet-card",
    )[0];
    expect(within(active).getByRole("button", { name: "使用中" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(
      within(active).getByRole("button", { name: "删除 当前宠物" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText("v2 · 内置")).toBeTruthy();
    const installedGrid = screen.getByTestId("installed-pets-grid");
    const marketGrid = screen.getByTestId("market-pets-grid");
    expect(
      installedGrid.compareDocumentPosition(marketGrid) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除 第二只" }));
    const dialog = screen.getByRole("dialog");
    expect(h.port.deleteInstalled).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(h.port.deleteInstalled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除 第二只" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "删除", exact: true }),
    );
    await waitFor(() =>
      expect(h.port.deleteInstalled).toHaveBeenCalledWith({
        petId: "second",
        operationId: expect.any(String),
      }),
    );
  });

  it.each(["nonCommercial", "unknown"] as const)(
    "市场安装先显示 %s 具体许可且确认后才安装",
    async (commercialUse) => {
      h.port.listMarket.mockResolvedValue({
        items: [{ ...market, license: { text: "逐宠物许可", commercialUse } }],
        categories: [],
        total: 1,
      });
      await renderManagement();
      fireEvent.click(screen.getByRole("button", { name: "安装", exact: true }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("逐宠物许可")).toBeTruthy();
      expect(
        within(dialog).getByText(
          commercialUse === "unknown" ? /商业使用权限未知/ : /仅限非商业使用/,
        ),
      ).toBeTruthy();
      const confirm = within(dialog).getByRole("button", { name: "确认安装", exact: true });
      expect(confirm.hasAttribute("disabled")).toBe(true);
      expect(h.port.installMarketPet).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /我已阅读/ }));
      fireEvent.click(confirm);
      await waitFor(() =>
        expect(h.port.installMarketPet).toHaveBeenCalledWith({
          petId: "market",
          operationId: expect.any(String),
          replaceExisting: false,
        }),
      );
    },
  );

  it("市场重复项必须单独确认覆盖，许可确认不能顺带授权覆盖", async () => {
    h.port.listMarket.mockResolvedValue({
      items: [{ ...market, id: "second", installed: true }],
      categories: [],
      total: 1,
    });
    await renderManagement();
    fireEvent.click(screen.getByRole("button", { name: "已安装 · 重新安装" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /我已阅读/ }));
    const confirm = within(dialog).getByRole("button", { name: "确认安装", exact: true });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /明确允许覆盖/ }));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(h.port.installMarketPet).toHaveBeenCalledWith({
        petId: "second",
        operationId: expect.any(String),
        replaceExisting: true,
      }),
    );
  });

  it("导入扫描先 review，重复项默认不选，逐项确认后仍需最终确认；取消不安装", async () => {
    await renderManagement();
    fireEvent.click(screen.getByRole("button", { name: "导入宠物" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "扫描并预览" }));
    await within(dialog).findByText("新宠物");
    expect(h.port.prepareImport).toHaveBeenCalledWith("codex");
    expect(h.port.installImport).not.toHaveBeenCalled();
    expect(within(dialog).getByText("坏 manifest 已跳过")).toBeTruthy();
    const duplicate = within(dialog).getByRole("checkbox", { name: "第二只新版", exact: true });
    expect(duplicate.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(duplicate);
    const reviewButton = within(dialog).getByRole("button", { name: "检查所选宠物" });
    expect(reviewButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /明确允许覆盖/ }));
    fireEvent.click(reviewButton);
    expect(within(dialog).getByText("确认安装所选 2 只宠物")).toBeTruthy();
    expect(h.port.installImport).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消", exact: true }));
    expect(h.port.installImport).not.toHaveBeenCalled();
  });

  it("最终确认只安装所选 review 项，并保留单独覆盖名单", async () => {
    await renderManagement();
    fireEvent.click(screen.getByRole("button", { name: "导入宠物" }));
    fireEvent.click(screen.getByRole("button", { name: "扫描并预览" }));
    await screen.findByText("新宠物");
    fireEvent.click(screen.getByRole("checkbox", { name: "第二只新版", exact: true }));
    fireEvent.click(screen.getByRole("checkbox", { name: /明确允许覆盖/ }));
    fireEvent.click(screen.getByRole("button", { name: "检查所选宠物" }));
    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
    await waitFor(() =>
      expect(h.port.installImport).toHaveBeenCalledWith({
        reviewId: "review-1",
        operationId: expect.any(String),
        petIds: ["new", "second"],
        replacePetIds: ["second"],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("扫描错误提供中文标题和详情，用户可以另选本地来源", async () => {
    h.port.prepareImport.mockRejectedValueOnce(new Error("INVALID_SOURCE: source not found"));
    await renderManagement();
    fireEvent.click(screen.getByRole("button", { name: "导入宠物" }));
    fireEvent.click(screen.getByRole("button", { name: "扫描并预览" }));
    await screen.findByText("扫描导入来源失败，请检查来源，或另选本地目录。");
    expect(screen.getByText("INVALID_SOURCE: source not found").closest("details")).toBeTruthy();
    const source = screen.getByRole("combobox", { name: "导入来源" });
    fireEvent.keyDown(source, { key: "ArrowDown" });
    await screen.findByRole("option", { name: "选择本地目录" });
    expect(screen.getByRole("option", { name: "选择 ZIP 文件" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "从 Mikiko 导入" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "从其他 ZCode 导入" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "选择本地目录" }));
    fireEvent.click(screen.getByRole("button", { name: "扫描并预览" }));
    await waitFor(() => expect(h.port.prepareImport).toHaveBeenLastCalledWith("directory"));
  });

  it("搜索、分类刷新和分页调用真实 UI hook，不触发模型会话", async () => {
    h.port.listMarket.mockResolvedValue({
      items: [market],
      categories: ["动物"],
      total: 25,
      nextCursor: "next",
    });
    await renderManagement();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索" }), { target: { value: "猫" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索", exact: true }));
    await waitFor(() =>
      expect(h.port.listMarket).toHaveBeenLastCalledWith(expect.objectContaining({ query: "猫" })),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "下一页" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("第 2 页 · 共 25 只");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(h.port.listMarket).toHaveBeenLastCalledWith(
        expect.objectContaining({ refresh: true, cursor: undefined }),
      ),
    );
  });

  it("安装进度可见且只消费当前操作 ID，取消按钮显式发出取消", async () => {
    let reject!: (error: unknown) => void;
    h.port.installMarketPet.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await renderManagement();
    fireEvent.click(screen.getByRole("button", { name: "安装", exact: true }));
    fireEvent.click(screen.getByRole("checkbox", { name: /我已阅读/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认安装", exact: true }));
    const operationId = h.port.installMarketPet.mock.calls[0][0].operationId;
    act(() =>
      progressListener({ operationId: "other", phase: "deleting", completed: 7, total: 10 }),
    );
    expect(screen.queryByText("正在删除宠物…")).toBeNull();
    act(() => progressListener({ operationId, phase: "verifying", completed: 1, total: 2 }));
    expect(screen.getByText("正在校验宠物资产…")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "取消操作" }));
    expect(h.port.cancelOperation).toHaveBeenCalledWith(operationId);
    await act(async () => reject(new Error("CANCELLED: 已取消")));
  });
});
