// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { DesktopPetOperationProgress } from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  port: {
    listInstalled: vi.fn(),
    listMarket: vi.fn(),
    prepareImport: vi.fn(),
    installImport: vi.fn(),
    installMarketPet: vi.fn(),
    deleteInstalled: vi.fn(),
    cancelOperation: vi.fn(),
    onOperationProgress: vi.fn(),
    setActive: vi.fn(),
  },
  settings: { desktopPetEnabled: false, desktopPetId: "active" },
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
import { useDesktopPets } from "@/hooks/useDesktopPets.js";

const license = { text: "MIT", commercialUse: "allowed" as const };
const installed = [
  {
    id: "active",
    displayName: "当前宠物",
    spriteVersionNumber: 2,
    previewUrl: "petpack://active/spritesheet.webp",
    source: "bundled" as const,
    license,
  },
];
const review = {
  reviewId: "review-1",
  expiresAt: Date.now() + 600_000,
  warnings: [],
  candidates: [
    {
      id: "new",
      displayName: "新宠物",
      spriteVersionNumber: 1,
      source: "directory" as const,
      license,
      alreadyInstalled: false,
    },
    {
      id: "active",
      displayName: "同名宠物",
      spriteVersionNumber: 2,
      source: "directory" as const,
      license,
      alreadyInstalled: true,
    },
  ],
};
let progressListener: (progress: DesktopPetOperationProgress) => void;
let unsubscribe: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  h.settings.desktopPetEnabled = false;
  h.settings.desktopPetId = "active";
  h.port.listInstalled.mockResolvedValue(installed);
  h.port.listMarket.mockResolvedValue({ items: [], categories: ["动物"], total: 0 });
  h.port.prepareImport.mockResolvedValue(review);
  h.port.installImport.mockResolvedValue(undefined);
  h.port.installMarketPet.mockResolvedValue(undefined);
  h.port.deleteInstalled.mockResolvedValue(undefined);
  h.port.setActive.mockResolvedValue(undefined);
  h.update.mockResolvedValue(undefined);
  h.refresh.mockResolvedValue(undefined);
  unsubscribe = vi.fn();
  h.port.onOperationProgress.mockImplementation((listener) => {
    progressListener = listener;
    return unsubscribe;
  });
});
afterEach(cleanup);

async function renderPets(showMarket = false) {
  const hook = renderHook(() => useDesktopPets({ showMarket }));
  await waitFor(() => expect(hook.result.current.installedLoading).toBe(false));
  return hook;
}

describe("桌宠 UI hook 的平台与异步边界", () => {
  it("保存的 ID 已失效时与 Main 一致使用首个有效宠物，仍禁止删除且不回写设置", async () => {
    h.settings.desktopPetId = "missing";
    const hook = await renderPets();
    expect(hook.result.current.activePetId).toBe("active");
    await act(async () => {
      await hook.result.current.deletePet("active");
    });
    expect(h.port.deleteInstalled).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
  it("隐藏宠物仍读取已安装列表，但首页不请求市场", async () => {
    const hook = await renderPets();
    expect(hook.result.current.activePet?.id).toBe("active");
    expect(h.port.listInstalled).toHaveBeenCalledOnce();
    expect(h.port.listMarket).not.toHaveBeenCalled();
    await act(async () => {
      await hook.result.current.setEnabled(true);
    });
    expect(h.update).toHaveBeenCalledWith({ desktopPetEnabled: true });
  });

  it("切换由 Main 保存 ID 后刷新本机设置，不增加第二条 ID 写入路径", async () => {
    const hook = await renderPets();
    await act(async () => {
      await hook.result.current.setActive("new");
    });
    expect(h.port.setActive).toHaveBeenCalledWith("new");
    expect(h.refresh).toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("活动宠物删除在调用平台前阻止", async () => {
    const hook = await renderPets();
    await act(async () => {
      await hook.result.current.deletePet("active");
    });
    expect(h.port.deleteInstalled).not.toHaveBeenCalled();
    expect(hook.result.current.actionError?.messageId).toBe(
      "settings.desktopPet.error.activeDelete",
    );
  });

  it("导入预检与取消均不安装；重复项必须逐项显式允许覆盖", async () => {
    const hook = await renderPets();
    await act(async () => {
      await hook.result.current.prepareImport("directory");
    });
    expect(h.port.installImport).not.toHaveBeenCalled();
    await act(async () => {
      await hook.result.current.installImport(["active"], []);
    });
    expect(h.port.installImport).not.toHaveBeenCalled();
    expect(hook.result.current.actionError?.messageId).toBe(
      "settings.desktopPet.error.replaceRequired",
    );
    await act(async () => {
      await hook.result.current.installImport(["new", "active"], ["active"]);
    });
    expect(h.port.installImport).toHaveBeenCalledWith({
      operationId: expect.any(String),
      reviewId: "review-1",
      petIds: ["new", "active"],
      replacePetIds: ["active"],
    });
    expect(hook.result.current.importReview).toBeNull();
    act(() => hook.result.current.clearImportReview());
    expect(h.port.installImport).toHaveBeenCalledOnce();
  });

  it("过期 review 和未知候选不会发送安装请求", async () => {
    h.port.prepareImport.mockResolvedValueOnce({ ...review, expiresAt: Date.now() - 1 });
    const hook = await renderPets();
    await act(async () => {
      await hook.result.current.prepareImport("archive");
    });
    await act(async () => {
      await hook.result.current.installImport(["new"], []);
    });
    expect(hook.result.current.actionError?.messageId).toBe(
      "settings.desktopPet.error.reviewExpired",
    );
    await act(async () => {
      await hook.result.current.prepareImport("archive");
    });
    await act(async () => {
      await hook.result.current.installImport(["unreviewed"], []);
    });
    expect(h.port.installImport).not.toHaveBeenCalled();
  });

  it("原生选择器取消没有安装，也没有假错误", async () => {
    h.port.prepareImport.mockResolvedValue(null);
    const hook = await renderPets();
    await act(async () => {
      await hook.result.current.prepareImport("directory");
    });
    expect(hook.result.current.importReview).toBeNull();
    expect(hook.result.current.actionError).toBeNull();
    expect(h.port.installImport).not.toHaveBeenCalled();
  });

  it("操作期间只消费当前 operationId，显式取消发送一次且卸载不隐式取消", async () => {
    let finish!: () => void;
    h.port.installMarketPet.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const hook = await renderPets();
    let promise!: Promise<boolean>;
    act(() => {
      promise = hook.result.current.installMarketPet("new");
    });
    const operationId = h.port.installMarketPet.mock.calls[0][0].operationId;
    act(() =>
      progressListener({ operationId: "another", phase: "installing", completed: 8, total: 10 }),
    );
    expect(hook.result.current.operation?.progress.completed).toBe(0);
    act(() => progressListener({ operationId, phase: "verifying", completed: 1, total: 2 }));
    expect(hook.result.current.operation?.progress.phase).toBe("verifying");
    act(() => {
      hook.result.current.cancelOperation();
      hook.result.current.cancelOperation();
    });
    expect(h.port.cancelOperation).toHaveBeenCalledExactlyOnceWith(operationId);
    hook.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(h.port.cancelOperation).toHaveBeenCalledOnce();
    await act(async () => {
      finish();
      await promise;
    });
  });

  it("取消错误显示取消状态，其他源错误保留详情并提供本地化用户文案", async () => {
    const hook = await renderPets();
    h.port.installMarketPet.mockRejectedValueOnce(new Error("CANCELLED: 已取消"));
    await act(async () => {
      await hook.result.current.installMarketPet("new");
    });
    expect(hook.result.current.noticeId).toBe("settings.desktopPet.operation.cancelled");
    expect(hook.result.current.actionError).toBeNull();
    h.port.prepareImport.mockRejectedValueOnce(new Error("INVALID_SOURCE: 目录不存在"));
    await act(async () => {
      await hook.result.current.prepareImport("codex");
    });
    expect(hook.result.current.actionError).toEqual({
      messageId: "settings.desktopPet.error.scan",
      details: "INVALID_SOURCE: 目录不存在",
    });
  });

  it("市场刷新显式传 refresh，搜索重置分页且陈旧响应不覆盖新查询", async () => {
    const hook = await renderPets(true);
    await waitFor(() => expect(hook.result.current.marketLoading).toBe(false));
    await act(async () => {
      await hook.result.current.refreshMarket();
    });
    expect(h.port.listMarket).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: true }));
    let finishOld!: (value: unknown) => void;
    h.port.listMarket.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    let oldQuery!: Promise<void>;
    act(() => {
      oldQuery = hook.result.current.searchMarket("旧", "动物");
    });
    await act(async () => {
      await hook.result.current.searchMarket("新", "");
    });
    await act(async () => {
      finishOld({ items: [], categories: ["旧分类"], total: 99 });
      await oldQuery;
    });
    expect(hook.result.current.marketQuery).toBe("新");
    expect(hook.result.current.marketPage?.total).toBe(0);
    expect(hook.result.current.marketPage?.categories).toEqual(["动物"]);
    expect(hook.result.current.marketPageIndex).toBe(0);
  });

  it("分页使用后端游标并能回上一页，搜索回到第一页", async () => {
    h.port.listMarket.mockResolvedValue({
      items: [],
      categories: [],
      total: 30,
      nextCursor: "cursor-2",
    });
    const hook = await renderPets(true);
    await waitFor(() => expect(hook.result.current.marketLoading).toBe(false));
    await act(async () => {
      await hook.result.current.nextMarketPage();
    });
    expect(h.port.listMarket).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "cursor-2" }),
    );
    expect(hook.result.current.marketPageIndex).toBe(1);
    await act(async () => {
      await hook.result.current.previousMarketPage();
    });
    expect(hook.result.current.marketPageIndex).toBe(0);
    await act(async () => {
      await hook.result.current.searchMarket("猫", "动物");
    });
    expect(h.port.listMarket).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "猫", category: "动物", cursor: undefined }),
    );
  });
});
