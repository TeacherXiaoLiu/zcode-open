import type { Rectangle } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";
import type {
  DesktopPetBubbleWindowHandle,
  DesktopPetWindowHandle,
} from "../src/main/desktopPet/desktopPetWindow.js";

/** 桌宠控制器：缩放（三期）与多窗口活动汇总。 */

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  screen: {
    getPrimaryDisplay: () => ({ workArea }),
    getDisplayNearestPoint: () => ({ workArea }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
}));
vi.mock("../src/main/desktopPet/desktopPetCatalog.js", () => ({
  DESKTOP_PET_SPRITESHEET_FILE: "spritesheet.webp",
  ensureBundledDesktopPetsInstalled: vi.fn(),
  listInstalledDesktopPets: vi.fn(() => [
    { id: "otter", displayName: "Otter", spriteVersionNumber: 1 },
  ]),
  readDesktopPetManifest: vi.fn((id: string) =>
    id === "otter"
      ? {
          id: "otter",
          displayName: "Otter",
          spriteVersionNumber: 1,
          columns: 8,
          rows: 9,
          frameWidth: 192,
          frameHeight: 208,
          frameCount: 72,
        }
      : null,
  ),
}));
import { createDesktopPetController } from "../src/main/desktopPet/desktopPetController.js";

function petWindowMock(initial: Rectangle) {
  let bounds = { ...initial };
  let destroyed = false;
  let readyCallback: (() => void) | undefined;
  const handle: DesktopPetWindowHandle = {
    onceReadyToShow: vi.fn((callback: () => void) => {
      readyCallback = callback;
    }),
    showInactive: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    isDestroyed: vi.fn(() => destroyed),
    send: vi.fn(),
    getBounds: vi.fn(() => ({ ...bounds })),
    setPosition: vi.fn(),
    setBounds: vi.fn((next: Rectangle) => {
      bounds = { ...next };
    }),
    ownsWindow: vi.fn(() => false),
    ownsWebContents: vi.fn(() => false),
  };
  return { handle, fireReady: () => readyCallback?.(), bounds: () => ({ ...bounds }) };
}

function bubbleWindowMock(initial: Rectangle) {
  let bounds = { ...initial };
  let destroyed = false;
  let readyCallback: (() => void) | undefined;
  const handle: DesktopPetBubbleWindowHandle = {
    onceReadyToShow: vi.fn((callback: () => void) => {
      readyCallback = callback;
    }),
    showInactive: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => true),
    send: vi.fn(),
    setBounds: vi.fn((next: Rectangle) => {
      bounds = { ...next };
    }),
    ownsWindow: vi.fn(() => false),
    ownsWebContents: vi.fn(() => false),
  };
  return { handle, fireReady: () => readyCallback?.(), bounds: () => ({ ...bounds }) };
}

function createController() {
  const petWindows: Array<ReturnType<typeof petWindowMock>> = [];
  const bubbleWindows: Array<ReturnType<typeof bubbleWindowMock>> = [];
  const persistPosition = vi.fn();
  const controller = createDesktopPetController({
    petsRootDir: "C:\\pets",
    bundledPetsDir: "C:\\bundled",
    createWindow: (bounds) => {
      const mock = petWindowMock(bounds);
      petWindows.push(mock);
      return mock.handle;
    },
    createBubbleWindow: (bounds) => {
      const mock = bubbleWindowMock(bounds);
      bubbleWindows.push(mock);
      return mock.handle;
    },
    persistPosition,
    persistActivePetId: vi.fn(async () => undefined),
    setEnabled: vi.fn(),
    openMainWindow: vi.fn(),
    getLocale: () => "zh-CN",
  });
  return { controller, petWindows, bubbleWindows, persistPosition };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("桌宠控制器缩放", () => {
  it("默认 1.0 缩放：窗口为图集格原始尺寸 192×208", () => {
    const { controller, petWindows } = createController();
    controller.applySettings({ desktopPetEnabled: true });
    const bounds = petWindows[0]!.bounds();
    expect({ width: bounds.width, height: bounds.height }).toEqual({ width: 192, height: 208 });
  });

  it("缩放设置变化时按底部中心锚定换 bounds 并持久化位置", () => {
    const { controller, petWindows, persistPosition } = createController();
    // 放在屏内：右下角默认位置放大后必然越界被夹取，无法断言锚定本身。
    controller.applySettings({ desktopPetPosition: { x: 800, y: 400 } });
    controller.applySettings({ desktopPetEnabled: true });
    const before = petWindows[0]!.bounds();
    controller.applySettings({ desktopPetScale: 2 });
    const after = petWindows[0]!.bounds();
    expect({ width: after.width, height: after.height }).toEqual({ width: 384, height: 416 });
    expect(after.x + after.width / 2).toBe(before.x + before.width / 2);
    expect(after.y + after.height).toBe(before.y + before.height);
    expect(persistPosition).toHaveBeenCalledWith({ x: after.x, y: after.y });
  });

  it("默认右下角位置放大后被夹回工作区（锚定让位可见性）", () => {
    const { controller, petWindows } = createController();
    controller.applySettings({ desktopPetEnabled: true });
    controller.applySettings({ desktopPetScale: 2 });
    const after = petWindows[0]!.bounds();
    // x 越出右边缘被夹回；y 按底部锚定（736 + 208 - 416）后仍在界内。
    expect(after.x).toBe(1920 - 384);
    expect(after.y).toBe(528);
  });

  it("缩放值越界时被归一夹取（0.5–2.0）", () => {
    const { controller, petWindows } = createController();
    controller.applySettings({ desktopPetEnabled: true });
    controller.applySettings({ desktopPetScale: 99 });
    expect(petWindows[0]!.bounds().width).toBe(384);
    controller.applySettings({ desktopPetScale: 0.01 });
    expect(petWindows[0]!.bounds().width).toBe(96);
  });

  it("禁用状态下只保存缩放，重新启用时按新尺寸创建窗口", () => {
    const { controller, petWindows } = createController();
    controller.applySettings({ desktopPetScale: 1.5 });
    controller.applySettings({ desktopPetEnabled: true });
    expect(petWindows[0]!.bounds().width).toBe(288);
  });

  it("缩放后的尺寸作为持久化位置的锚点：重建窗口仍用保存位置", () => {
    const { controller, petWindows } = createController();
    controller.applySettings({ desktopPetEnabled: true });
    controller.applySettings({ desktopPetScale: 0.5 });
    const resized = petWindows[0]!.bounds();
    controller.applySettings({ desktopPetEnabled: false });
    controller.applySettings({ desktopPetEnabled: true });
    const recreated = petWindows[1]!.bounds();
    expect(recreated.width).toBe(96);
    expect(recreated.x).toBe(resized.x);
    expect(recreated.y).toBe(resized.y);
  });
});

describe("桌宠控制器活动汇总", () => {
  it("启用后创建宠物窗口与气泡窗口；上报活动驱动动画与气泡", () => {
    const { controller, petWindows, bubbleWindows } = createController();
    controller.applySettings({ desktopPetEnabled: true });
    petWindows[0]!.fireReady();
    expect(bubbleWindows).toHaveLength(1);
    bubbleWindows[0]!.fireReady();
    controller.reportActivity(
      { state: "running", sessions: [{ sessionId: "s1", title: "构建任务", state: "running" }] },
      11,
    );
    expect(petWindows[0]!.handle.send).toHaveBeenCalledWith(
      PlatformChannels.DesktopPetState,
      "running",
    );
    expect(bubbleWindows[0]!.handle.send).toHaveBeenCalledWith(
      PlatformChannels.DesktopPetActivity,
      {
        activity: {
          state: "running",
          sessions: [{ sessionId: "s1", title: "构建任务", state: "running" }],
        },
        locale: "zh-CN",
      },
    );
  });

  it("多窗口按优先级汇总，会话合并去重且截断到 3 条", () => {
    const { controller, petWindows, bubbleWindows } = createController();
    controller.applySettings({ desktopPetEnabled: true });
    petWindows[0]!.fireReady();
    bubbleWindows[0]!.fireReady();
    controller.reportActivity({ state: "idle", sessions: [] }, 11);
    controller.reportActivity(
      {
        state: "review",
        sessions: [
          { sessionId: "r1", title: "待查看会话", state: "review", detail: "结果已就绪" },
        ],
      },
      22,
    );
    expect(petWindows[0]!.handle.send).toHaveBeenLastCalledWith(
      PlatformChannels.DesktopPetState,
      "review",
    );
    controller.reportActivity(
      {
        state: "running",
        sessions: [
          { sessionId: "s1", title: "运行中会话", state: "running", detail: "正在处理" },
          { sessionId: "s2", title: "第二个", state: "running" },
          { sessionId: "s3", title: "第三个", state: "running" },
          { sessionId: "r1", title: "重复会话", state: "review" },
        ],
      },
      33,
    );
    expect(petWindows[0]!.handle.send).toHaveBeenLastCalledWith(
      PlatformChannels.DesktopPetState,
      "running",
    );
    const payload = bubbleWindows[0]!.handle.send.mock.lastCall?.[1] as {
      activity: { state: string; sessions: Array<{ sessionId: string }> };
    };
    expect(payload.activity.state).toBe("running");
    // 合并 window 22 的 review 与会话 33 的 running 列表，去重后按优先级排：
    // running 三条在前（renderer 顺序保持），review 的 r1 去重后不重复。
    expect(payload.activity.sessions.map((s) => s.sessionId)).toEqual(["s1", "s2", "s3"]);
  });

  it("汇总回到 idle：气泡隐藏，动画回 idle", () => {
    const { controller, petWindows, bubbleWindows } = createController();
    controller.applySettings({ desktopPetEnabled: true });
    petWindows[0]!.fireReady();
    bubbleWindows[0]!.fireReady();
    controller.reportActivity(
      { state: "running", sessions: [{ sessionId: "s1", title: "任务", state: "running" }] },
      11,
    );
    controller.reportActivity({ state: "idle", sessions: [] }, 11);
    expect(bubbleWindows[0]!.handle.hide).toHaveBeenCalled();
    expect(petWindows[0]!.handle.send).toHaveBeenLastCalledWith(
      PlatformChannels.DesktopPetState,
      "idle",
    );
  });

  it("reporter 释放后其状态不再参与汇总", () => {
    const { controller, petWindows } = createController();
    controller.applySettings({ desktopPetEnabled: true });
    petWindows[0]!.fireReady();
    controller.reportActivity(
      { state: "running", sessions: [{ sessionId: "s1", title: "任务", state: "running" }] },
      11,
    );
    controller.releaseReporter(11);
    expect(petWindows[0]!.handle.send).toHaveBeenLastCalledWith(
      PlatformChannels.DesktopPetState,
      "idle",
    );
  });

  it("禁用时销毁宠物窗口与气泡窗口", () => {
    const { controller, petWindows, bubbleWindows } = createController();
    controller.applySettings({ desktopPetEnabled: true });
    petWindows[0]!.fireReady();
    bubbleWindows[0]!.fireReady();
    controller.applySettings({ desktopPetEnabled: false });
    expect(petWindows[0]!.handle.destroy).toHaveBeenCalledOnce();
    expect(bubbleWindows[0]!.handle.destroy).toHaveBeenCalledOnce();
  });
});
