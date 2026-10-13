import { randomUUID } from "node:crypto";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels, type DesktopPetOperationProgress } from "@zcode/shared";
import type { DesktopPetController } from "../src/main/desktopPet/desktopPetController.js";
import type { DesktopPetLibrary } from "../src/main/desktopPet/desktopPetLibrary.js";

const ipc = vi.hoisted(() => ({
  handles: new Map<string, (event: IpcMainInvokeEvent, payload?: unknown) => unknown>(),
  listeners: new Map<string, (event: IpcMainEvent, payload?: unknown) => void>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (event: IpcMainInvokeEvent, payload?: unknown) => unknown) =>
        ipc.handles.set(channel, handler),
    ),
    on: vi.fn((channel: string, listener: (event: IpcMainEvent, payload?: unknown) => void) =>
      ipc.listeners.set(channel, listener),
    ),
    removeHandler: vi.fn((channel: string) => ipc.handles.delete(channel)),
    removeListener: vi.fn(
      (channel: string, listener: (event: IpcMainEvent, payload?: unknown) => void) => {
        if (ipc.listeners.get(channel) === listener) ipc.listeners.delete(channel);
      },
    ),
  },
}));
import { registerDesktopPetIpc } from "../src/main/desktopPet/desktopPetIpc.js";

const applicationId = 11;
const petId = 99;
const bubbleId = 77;
const operationId = "12345678-1234-4123-8123-123456789abc";
const reviewId = "12345678-1234-4123-8123-abcdef123456";
let dispose: (() => void) | undefined;
let controller: ReturnType<typeof controllerMock>;
let library: ReturnType<typeof libraryMock>;

function controllerMock() {
  return {
    applySettings: vi.fn(),
    getActivePayload: vi.fn(() => ({ id: "otter" })),
    reportActivity: vi.fn(),
    releaseReporter: vi.fn(),
    getBubblePayload: vi.fn(() => ({
      activity: { state: "running", sessions: [] },
      locale: "zh-CN",
    })),
    openSession: vi.fn(),
    getActivePetId: vi.fn(() => "otter"),
    switchActivePet: vi.fn(async () => undefined),
    openMainWindow: vi.fn(),
    startDrag: vi.fn(),
    endDrag: vi.fn(() => ({ movedPx: 12 })),
    showContextMenu: vi.fn(),
    ownsWindow: vi.fn(() => false),
    ownsWebContents: vi.fn((id: number) => id === petId),
    ownsBubbleWebContents: vi.fn((id: number) => id === bubbleId),
    dispose: vi.fn(),
  };
}
function libraryMock() {
  return {
    listInstalled: vi.fn(async () => []),
    listMarket: vi.fn(async () => ({ items: [], categories: [], total: 0 })),
    prepareImport: vi.fn(async () => null),
    setActive: vi.fn(async (_id: string, apply: () => Promise<void>) => {
      await apply();
    }),
    installImport: vi.fn(
      async (_params: Parameters<DesktopPetLibrary["installImport"]>[0]) => undefined,
    ),
    installMarketPet: vi.fn(
      async (_params: Parameters<DesktopPetLibrary["installMarketPet"]>[0]) => undefined,
    ),
    deleteInstalled: vi.fn(
      async (_params: Parameters<DesktopPetLibrary["deleteInstalled"]>[0]) => undefined,
    ),
    cancelOperation: vi.fn(),
    dispose: vi.fn(),
  } satisfies DesktopPetLibrary;
}
function event(id = applicationId, destroyed = false) {
  const sender = { id, isDestroyed: vi.fn(() => destroyed), send: vi.fn() };
  return { sender };
}
function invoke(channel: string, sender = event(), payload?: unknown) {
  const handler = ipc.handles.get(channel);
  if (!handler) throw new Error(`未注册 IPC handler：${channel}`);
  return handler(sender as unknown as IpcMainInvokeEvent, payload);
}
function send(channel: string, sender = event(), payload?: unknown) {
  const listener = ipc.listeners.get(channel);
  if (!listener) throw new Error(`未注册 IPC listener：${channel}`);
  listener(sender as unknown as IpcMainEvent, payload);
}

beforeEach(() => {
  ipc.handles.clear();
  ipc.listeners.clear();
  vi.clearAllMocks();
  controller = controllerMock();
  library = libraryMock();
  dispose = registerDesktopPetIpc({
    controller: controller as unknown as DesktopPetController,
    library,
    isApplicationSender: (id) => id === applicationId || id === 22,
  });
});
afterEach(() => {
  dispose?.();
});

const managementRequests = [
  { channel: PlatformChannels.PetListInstalled, payload: undefined },
  { channel: PlatformChannels.PetListMarket, payload: {} },
  { channel: PlatformChannels.PetPrepareImport, payload: { source: "directory" } },
  {
    channel: PlatformChannels.PetInstallImport,
    payload: { operationId, reviewId, petIds: ["otter"] },
  },
  { channel: PlatformChannels.PetInstallMarket, payload: { operationId, petId: "otter" } },
  { channel: PlatformChannels.PetDeleteInstalled, payload: { operationId, petId: "otter" } },
  { channel: PlatformChannels.PetSetActive, payload: "otter" },
];

describe("桌宠管理 IPC 发起方权限", () => {
  it.each(managementRequests)("非 application 发起方不能调用 $channel", ({ channel, payload }) => {
    expect(() => invoke(channel, event(50), payload)).toThrow("INVALID_SOURCE");
    expect(() => invoke(channel, event(petId), payload)).toThrow("INVALID_SOURCE");
    for (const method of [
      library.listInstalled,
      library.listMarket,
      library.prepareImport,
      library.installImport,
      library.installMarketPet,
      library.deleteInstalled,
      library.setActive,
    ]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("仅宠物窗口能获取 active 或开始/结束拖动，普通 application 不能冒充", () => {
    for (const id of [applicationId, 50]) {
      expect(() => invoke(PlatformChannels.PetGetActive, event(id))).toThrow("INVALID_SOURCE");
      expect(() => invoke(PlatformChannels.PetDragEnd, event(id))).toThrow("INVALID_SOURCE");
      send(PlatformChannels.PetDragStart, event(id));
      send(PlatformChannels.PetContextMenu, event(id));
      send(PlatformChannels.PetOpenApp, event(id));
    }
    expect(controller.startDrag).not.toHaveBeenCalled();
    expect(controller.showContextMenu).not.toHaveBeenCalled();
    expect(controller.openMainWindow).not.toHaveBeenCalled();
    expect(invoke(PlatformChannels.PetGetActive, event(petId))).toEqual({ id: "otter" });
    send(PlatformChannels.PetDragStart, event(petId));
    expect(invoke(PlatformChannels.PetDragEnd, event(petId))).toEqual({ movedPx: 12 });
    send(PlatformChannels.PetContextMenu, event(petId));
    send(PlatformChannels.PetOpenApp, event(petId));
    expect(controller.startDrag).toHaveBeenCalledOnce();
    expect(controller.endDrag).toHaveBeenCalledOnce();
    expect(controller.showContextMenu).toHaveBeenCalledOnce();
    expect(controller.openMainWindow).toHaveBeenCalledOnce();
  });

  it("已销毁的 pet sender 不能 invoke", () => {
    expect(() => invoke(PlatformChannels.PetGetActive, event(petId, true))).toThrow(
      "INVALID_SOURCE",
    );
    expect(() => invoke(PlatformChannels.PetDragEnd, event(petId, true))).toThrow("INVALID_SOURCE");
  });

  it("状态上报只能来自 application 且载荷必须是严格活动对象", () => {
    for (const value of [
      undefined,
      null,
      1,
      {},
      "running",
      { state: "unknown", sessions: [] },
      { state: "running" },
      { state: "running", sessions: "nope" },
      { state: "running", sessions: [{ sessionId: "s1", title: "T", state: "running", extra: 1 }] },
      { state: "running", sessions: [{ sessionId: "", title: "T", state: "running" }] },
      { state: "running", sessions: [{ sessionId: "s1", title: "T", state: "unknown" }] },
      { state: "running", sessions: [{ sessionId: "s1", title: "T", state: "running", detail: "x".repeat(201) }] },
      { state: "running", sessions: Array.from({ length: 6 }, (_, i) => ({ sessionId: `s${i}`, title: "T", state: "running" })) },
    ])
      send(PlatformChannels.PetStateReport, event(), value);
    send(PlatformChannels.PetStateReport, event(50), { state: "running", sessions: [] });
    send(PlatformChannels.PetStateReport, event(petId), { state: "running", sessions: [] });
    expect(controller.reportActivity).not.toHaveBeenCalled();
    const sessions = [{ sessionId: "s1", title: "构建任务", state: "running", detail: "摘要" }];
    send(PlatformChannels.PetStateReport, event(), { state: "running", sessions });
    send(PlatformChannels.PetStateReport, event(), { state: "idle", sessions: [] });
    expect(controller.reportActivity.mock.calls).toEqual([
      [{ state: "running", sessions }, applicationId],
      [{ state: "idle", sessions: [] }, applicationId],
    ]);
  });

  it("气泡窗口才能拉取活动汇总，宠物窗口与 application 不能冒充", () => {
    for (const id of [applicationId, petId, 50])
      expect(() => invoke(PlatformChannels.PetGetActivity, event(id))).toThrow("INVALID_SOURCE");
    expect(invoke(PlatformChannels.PetGetActivity, event(bubbleId))).toEqual({
      activity: { state: "running", sessions: [] },
      locale: "zh-CN",
    });
    expect(controller.getBubblePayload).toHaveBeenCalledOnce();
  });

  it("气泡点击跳转只接受气泡窗口的合法 sessionId", () => {
    for (const id of [applicationId, petId, 50])
      send(PlatformChannels.PetBubbleOpenSession, event(id), "sess_1");
    for (const value of [undefined, null, 1, {}, "", "x".repeat(129)])
      send(PlatformChannels.PetBubbleOpenSession, event(bubbleId), value);
    send(PlatformChannels.PetBubbleOpenSession, event(bubbleId, true), "sess_1");
    expect(controller.openSession).not.toHaveBeenCalled();
    send(PlatformChannels.PetBubbleOpenSession, event(bubbleId), "sess_1");
    expect(controller.openSession).toHaveBeenCalledWith("sess_1");
  });
});

describe("桌宠 IPC 严格载荷验证", () => {
  it.each([
    { channel: PlatformChannels.PetListMarket, payload: { url: "https://evil.example" } },
    { channel: PlatformChannels.PetListMarket, payload: { query: "x".repeat(257) } },
    { channel: PlatformChannels.PetListMarket, payload: { category: "x".repeat(129) } },
    { channel: PlatformChannels.PetListMarket, payload: { cursor: "../1" } },
    { channel: PlatformChannels.PetListMarket, payload: { limit: 25 } },
    { channel: PlatformChannels.PetListMarket, payload: { limit: 1.5 } },
    { channel: PlatformChannels.PetListMarket, payload: { refresh: "true" } },
    {
      channel: PlatformChannels.PetPrepareImport,
      payload: { source: "directory", path: "C:/secret" },
    },
    { channel: PlatformChannels.PetPrepareImport, payload: { source: "unknown" } },
    {
      channel: PlatformChannels.PetInstallImport,
      payload: { operationId: "not-uuid", reviewId, petIds: ["otter"] },
    },
    {
      channel: PlatformChannels.PetInstallImport,
      payload: { operationId, reviewId: "not-uuid", petIds: ["otter"] },
    },
    { channel: PlatformChannels.PetInstallImport, payload: { operationId, reviewId, petIds: [] } },
    {
      channel: PlatformChannels.PetInstallImport,
      payload: { operationId, reviewId, petIds: Array.from({ length: 201 }, () => "otter") },
    },
    {
      channel: PlatformChannels.PetInstallImport,
      payload: { operationId, reviewId, petIds: ["otter"], ownerId: 99 },
    },
    {
      channel: PlatformChannels.PetInstallImport,
      payload: { operationId, reviewId, petIds: ["../escape"] },
    },
    {
      channel: PlatformChannels.PetInstallImport,
      payload: { operationId, reviewId, petIds: ["otter"], replacePetIds: ["CON"] },
    },
    {
      channel: PlatformChannels.PetInstallMarket,
      payload: { operationId, petId: "otter", url: "https://evil.example" },
    },
    {
      channel: PlatformChannels.PetInstallMarket,
      payload: { operationId, petId: "otter", replaceExisting: "true" },
    },
    { channel: PlatformChannels.PetInstallMarket, payload: { operationId, petId: "a\\b" } },
    {
      channel: PlatformChannels.PetDeleteInstalled,
      payload: { operationId, petId: "otter", path: "C:/secret" },
    },
    {
      channel: PlatformChannels.PetDeleteInstalled,
      payload: { operationId: "bad", petId: "otter" },
    },
    { channel: PlatformChannels.PetSetActive, payload: { petId: "otter" } },
    { channel: PlatformChannels.PetSetActive, payload: "CON" },
  ])("拒绝无效 $channel 载荷 $payload", ({ channel, payload }) => {
    expect(() => invoke(channel, event(), payload)).toThrow();
    for (const method of [
      library.listMarket,
      library.prepareImport,
      library.installImport,
      library.installMarketPet,
      library.deleteInstalled,
      library.setActive,
    ])
      expect(method).not.toHaveBeenCalled();
  });

  it.each(["codex", "zcode", "mikiko", "directory", "archive"])(
    "导入来源 %s 由 main 绑定 sender owner",
    async (source) => {
      await invoke(PlatformChannels.PetPrepareImport, event(22), { source });
      expect(library.prepareImport).toHaveBeenCalledWith(source, 22);
    },
  );

  it("安装/删除/市场的 owner 与操作 ID 使用 main 已验证值，进度仅返回原 sender", async () => {
    const sender = event(22);
    const report: DesktopPetOperationProgress = {
      operationId,
      phase: "installing",
      completed: 0,
      total: 1,
      petId: "otter",
    };
    library.installImport.mockImplementation(async (params) => {
      params.reportProgress(report);
    });
    await invoke(PlatformChannels.PetInstallImport, sender, {
      operationId,
      reviewId,
      petIds: ["otter"],
      replacePetIds: ["otter"],
    });
    expect(library.installImport).toHaveBeenCalledWith({
      operationId,
      reviewId,
      petIds: ["otter"],
      replacePetIds: ["otter"],
      ownerId: 22,
      reportProgress: expect.any(Function),
    });
    expect(sender.sender.send).toHaveBeenCalledWith(PlatformChannels.PetOperationProgress, report);
    await invoke(PlatformChannels.PetInstallMarket, sender, {
      operationId,
      petId: "otter",
      replaceExisting: true,
    });
    expect(library.installMarketPet).toHaveBeenCalledWith({
      operationId,
      petId: "otter",
      replaceExisting: true,
      ownerId: 22,
      reportProgress: expect.any(Function),
    });
    await invoke(PlatformChannels.PetDeleteInstalled, sender, { operationId, petId: "otter" });
    expect(library.deleteInstalled).toHaveBeenCalledWith({
      operationId,
      petId: "otter",
      ownerId: 22,
      reportProgress: expect.any(Function),
    });
  });

  it("请求发起后 sender 销毁时不再发送进度", async () => {
    const sender = event();
    library.installMarketPet.mockImplementation(async (params) => {
      sender.sender.isDestroyed.mockReturnValue(true);
      params.reportProgress({ operationId, phase: "completed", completed: 1, total: 1 });
    });
    await invoke(PlatformChannels.PetInstallMarket, sender, { operationId, petId: "otter" });
    expect(sender.sender.send).not.toHaveBeenCalled();
  });

  it("市场查询默认对象与严格合法参数被转发，切换只能由 library 串行调用 controller", async () => {
    await invoke(PlatformChannels.PetListMarket);
    expect(library.listMarket).toHaveBeenLastCalledWith({});
    const params = { query: "水獭", category: "Animals", cursor: "2", limit: 24, refresh: true };
    await invoke(PlatformChannels.PetListMarket, event(), params);
    expect(library.listMarket).toHaveBeenLastCalledWith(params);
    await invoke(PlatformChannels.PetListInstalled);
    expect(library.listInstalled).toHaveBeenCalledOnce();
    await invoke(PlatformChannels.PetSetActive, event(), "otter");
    expect(library.setActive).toHaveBeenCalledWith("otter", expect.any(Function));
    expect(controller.switchActivePet).toHaveBeenCalledWith("otter");
  });

  it("取消只接受 application 的 UUID 字符串，由 sender 决定 owner，不接受任意 owner 对象", () => {
    for (const payload of [undefined, "not-uuid", { operationId, ownerId: 22 }])
      send(PlatformChannels.PetCancelOperation, event(), payload);
    send(PlatformChannels.PetCancelOperation, event(50), operationId);
    expect(library.cancelOperation).not.toHaveBeenCalled();
    send(PlatformChannels.PetCancelOperation, event(22), operationId);
    expect(library.cancelOperation).toHaveBeenCalledWith(operationId, 22);
    const anotherId = randomUUID();
    send(PlatformChannels.PetCancelOperation, event(), anotherId);
    expect(library.cancelOperation).toHaveBeenLastCalledWith(anotherId, applicationId);
  });

  it("反注册仅移除本模块的 handler/listener，服务生命周期不由 IPC 隐式取消", () => {
    // 9 个管理/宠物 handler + 1 个气泡活动拉取（三期）。
    expect(ipc.handles.size).toBe(10);
    // 5 个事件监听 + 1 个气泡点击跳转（三期）。
    expect(ipc.listeners.size).toBe(6);
    dispose?.();
    dispose = undefined;
    expect(ipc.handles.size).toBe(0);
    expect(ipc.listeners.size).toBe(0);
    expect(library.dispose).not.toHaveBeenCalled();
    expect(library.cancelOperation).not.toHaveBeenCalled();
    expect(controller.dispose).not.toHaveBeenCalled();
  });
});
