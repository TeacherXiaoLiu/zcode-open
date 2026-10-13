import { describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";
import {
  createDesktopPetBubble,
  resolveDesktopPetBubbleSize,
} from "../src/main/desktopPet/desktopPetBubble.js";
import type { DesktopPetBubbleWindowHandle } from "../src/main/desktopPet/desktopPetWindow.js";

/** 会话汇报气泡窗口（三期，specs/desktop/desktop-pet.md）。 */

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const petBounds = { x: 1500, y: 700, width: 192, height: 208 };

function bubbleWindowMock() {
  let readyCallback: (() => void) | undefined;
  let destroyed = false;
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
    setBounds: vi.fn(),
    ownsWindow: vi.fn(() => false),
    ownsWebContents: vi.fn(() => false),
  };
  return { handle, fireReady: () => readyCallback?.() };
}

function createBubble() {
  const windows: Array<ReturnType<typeof bubbleWindowMock>> = [];
  const createdBounds: Array<{ x: number; y: number; width: number; height: number }> = [];
  const bubble = createDesktopPetBubble({
    createWindow: (bounds) => {
      createdBounds.push(bounds);
      const mock = bubbleWindowMock();
      windows.push(mock);
      return mock.handle;
    },
    getWorkArea: () => workArea,
  });
  return { bubble, windows, createdBounds };
}

const activity = {
  state: "running" as const,
  sessions: [
    { sessionId: "s1", title: "构建任务", state: "running" as const, detail: "正在编译" },
    { sessionId: "s2", title: "第二个任务", state: "running" as const },
  ],
};

describe("resolveDesktopPetBubbleSize", () => {
  it("高度随会话条数变化并夹取到 1–3 行", () => {
    const one = resolveDesktopPetBubbleSize(1);
    const two = resolveDesktopPetBubbleSize(2);
    const three = resolveDesktopPetBubbleSize(3);
    expect(one.height).toBeLessThan(two.height);
    expect(two.height).toBeLessThan(three.height);
    expect(resolveDesktopPetBubbleSize(0)).toEqual(one);
    expect(resolveDesktopPetBubbleSize(9)).toEqual(three);
  });
});

describe("createDesktopPetBubble", () => {
  it("未 ensure 时 show/hide 均为空操作", () => {
    const { bubble } = createBubble();
    expect(() => bubble.show(activity, "zh-CN")).not.toThrow();
    expect(() => bubble.hide()).not.toThrow();
    expect(bubble.isVisible()).toBe(false);
  });

  it("创建窗口时按宠物左侧挂靠（1500 - 宽度 - 8）", () => {
    const { bubble, createdBounds } = createBubble();
    bubble.ensure(petBounds);
    const size = resolveDesktopPetBubbleSize(1);
    expect(createdBounds).toEqual([
      { x: 1500 - size.width - 8, y: 700, width: size.width, height: size.height },
    ]);
  });

  it("ready 前到达的活动在就绪后补发并显示", () => {
    const { bubble, windows } = createBubble();
    bubble.ensure(petBounds);
    const win = windows[0]!.handle;
    bubble.show(activity, "zh-CN");
    // 窗口尚未 ready：只记待发，不发送。
    expect(win.send).not.toHaveBeenCalled();
    windows[0]!.fireReady();
    expect(win.send).toHaveBeenCalledWith(PlatformChannels.DesktopPetActivity, {
      activity,
      locale: "zh-CN",
    });
    expect(win.showInactive).toHaveBeenCalledOnce();
    expect(bubble.isVisible()).toBe(true);
  });

  it("ready 后活动直接推送，重复 show 不重复 display", () => {
    const { bubble, windows } = createBubble();
    bubble.ensure(petBounds);
    const win = windows[0]!.handle;
    windows[0]!.fireReady();
    bubble.show(activity, "zh-CN");
    bubble.show(
      { state: "review", sessions: [{ sessionId: "s9", title: "待查看", state: "review" }] },
      "zh-CN",
    );
    expect(win.showInactive).toHaveBeenCalledOnce();
    expect(win.send).toHaveBeenCalledTimes(2);
  });

  it("会话条数变化时按新高度重新挂靠", () => {
    const { bubble, windows } = createBubble();
    bubble.ensure(petBounds);
    const win = windows[0]!.handle;
    windows[0]!.fireReady();
    // 首次 show（2 条）：从默认单行高度拉到两行。
    bubble.show(activity, "zh-CN");
    expect(win.setBounds).toHaveBeenCalledTimes(1);
    win.setBounds.mockClear();
    // 从 2 条变为 1 条：高度收缩并重算挂靠位置。
    bubble.show(
      { state: "running", sessions: [{ sessionId: "s1", title: "只剩一个", state: "running" }] },
      "zh-CN",
    );
    const size = resolveDesktopPetBubbleSize(1);
    expect(win.setBounds).toHaveBeenCalledWith({
      x: 1500 - size.width - 8,
      y: 700,
      width: size.width,
      height: size.height,
    });
    // 条数不变时不再调整窗口。
    win.setBounds.mockClear();
    bubble.show(
      { state: "running", sessions: [{ sessionId: "s1", title: "另一个标题", state: "running" }] },
      "zh-CN",
    );
    expect(win.setBounds).not.toHaveBeenCalled();
  });

  it("隐藏后再次 show 重新显示；隐藏时 reposition 仍更新位置", () => {
    const { bubble, windows } = createBubble();
    bubble.ensure(petBounds);
    const win = windows[0]!.handle;
    windows[0]!.fireReady();
    bubble.show(activity, "zh-CN");
    bubble.hide();
    expect(bubble.isVisible()).toBe(false);
    win.setBounds.mockClear();
    bubble.reposition(petBounds);
    expect(win.setBounds).toHaveBeenCalledOnce();
    bubble.show(activity, "zh-CN");
    expect(bubble.isVisible()).toBe(true);
  });

  it("destroy 清理窗口，ownsWebContents 反映归属", () => {
    const { bubble, windows } = createBubble();
    bubble.ensure(petBounds);
    const win = windows[0]!.handle;
    (win.ownsWebContents as ReturnType<typeof vi.fn>).mockReturnValue(true);
    expect(bubble.ownsWebContents(5)).toBe(true);
    bubble.destroy();
    expect(win.destroy).toHaveBeenCalledOnce();
    expect(bubble.ownsWebContents(5)).toBe(false);
    expect(bubble.isVisible()).toBe(false);
  });

  it("ensure 幂等：窗口存在时不重复创建", () => {
    const { bubble, windows } = createBubble();
    bubble.ensure(petBounds);
    bubble.ensure(petBounds);
    expect(windows).toHaveLength(1);
  });
});
