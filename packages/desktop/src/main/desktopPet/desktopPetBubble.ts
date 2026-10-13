import type { Rectangle } from "electron";
import {
  PlatformChannels,
  type DesktopPetActivity,
  type DesktopPetBubblePayload,
  type Locale,
} from "@zcode/shared";
import {
  resolveDesktopPetBubbleBounds,
  type DesktopPetSize,
} from "./desktopPetPlacement.js";
import type { DesktopPetBubbleWindowHandle } from "./desktopPetWindow.js";

/**
 * 会话汇报气泡（三期，specs/desktop/desktop-pet.md）。
 * 独立穿透窗口：只展示"当前最相关会话的状态 + 标题"，不接收鼠标、不抢焦点。
 * 数据由 controller 汇总后传入；本模块只负责窗口生命周期、挂靠定位与推送去重之外的显示时机。
 */

export const DESKTOP_PET_BUBBLE_WIDTH_PX = 300;
/** 每条会话行的高度（标题 + 摘要两行）。 */
export const DESKTOP_PET_BUBBLE_ROW_HEIGHT_PX = 46;
/** 卡片上下内边距。 */
export const DESKTOP_PET_BUBBLE_PADDING_PX = 24;
export const DESKTOP_PET_BUBBLE_MAX_ROWS = 3;

/** 气泡尺寸随会话条数自适应（1–3 行）；main 在推送前按最新条数调整窗口高度。 */
export function resolveDesktopPetBubbleSize(sessionCount: number): DesktopPetSize {
  const rows = Math.max(1, Math.min(DESKTOP_PET_BUBBLE_MAX_ROWS, sessionCount));
  return {
    width: DESKTOP_PET_BUBBLE_WIDTH_PX,
    height: DESKTOP_PET_BUBBLE_PADDING_PX + rows * DESKTOP_PET_BUBBLE_ROW_HEIGHT_PX,
  };
}

export interface DesktopPetBubbleHandle {
  /** 创建窗口（若未创建）并按宠物位置挂靠；重复调用无副作用。 */
  ensure(petBounds: Rectangle): void;
  destroy(): void;
  ownsWebContents(id: number): boolean;
  /** 气泡窗口是否属于本模块（主窗集合排除用）。 */
  ownsWindow(candidate: object): boolean;
  /** 显示并推送活动；窗口未就绪时先记待发，就绪后补发并显示。 */
  show(activity: DesktopPetActivity, locale: Locale): void;
  hide(): void;
  /** 宠物移动/缩放后重新挂靠（仅可见时生效）。 */
  reposition(petBounds: Rectangle): void;
  isVisible(): boolean;
}

export function createDesktopPetBubble(deps: {
  createWindow: (initialBounds: Rectangle) => DesktopPetBubbleWindowHandle;
  /** 取某点所在显示器的工作区（注入 screen 依赖，便于测试替身）。 */
  getWorkArea: (point: { x: number; y: number }) => Rectangle;
}): DesktopPetBubbleHandle {
  let win: DesktopPetBubbleWindowHandle | null = null;
  let ready = false;
  let visible = false;
  /** 窗口 ready 前到达的活动：就绪后补发，避免气泡首帧空窗。 */
  let pending: DesktopPetBubblePayload | undefined;
  /** 最近一次挂靠的宠物位置：行数变化换高度时用它重新定位。 */
  let lastPetBounds: Rectangle | undefined;
  let currentSize: DesktopPetSize = resolveDesktopPetBubbleSize(1);

  function workAreaFor(bounds: Rectangle): Rectangle {
    return deps.getWorkArea({
      x: bounds.x + Math.round(bounds.width / 2),
      y: bounds.y + Math.round(bounds.height / 2),
    });
  }

  function placedBounds(petBounds: Rectangle): Rectangle {
    return resolveDesktopPetBubbleBounds(petBounds, currentSize, workAreaFor(petBounds));
  }

  function ensure(petBounds: Rectangle): void {
    if (win && !win.isDestroyed()) {
      return;
    }
    ready = false;
    lastPetBounds = petBounds;
    const created = deps.createWindow(placedBounds(petBounds));
    win = created;
    created.onceReadyToShow(() => {
      if (win !== created || created.isDestroyed()) {
        return;
      }
      ready = true;
      const payload = pending;
      pending = undefined;
      if (!payload) {
        return;
      }
      created.send(PlatformChannels.DesktopPetActivity, payload);
      created.showInactive();
      visible = true;
    });
  }

  function show(activity: DesktopPetActivity, locale: Locale): void {
    const current = win;
    if (!current || current.isDestroyed()) {
      return;
    }
    const payload: DesktopPetBubblePayload = { activity, locale };
    // 行数变化时先换高度再显示：按挂靠位置重算 bounds，避免先显示再跳高度。
    const nextSize = resolveDesktopPetBubbleSize(activity.sessions.length);
    if (nextSize.height !== currentSize.height || nextSize.width !== currentSize.width) {
      currentSize = nextSize;
      if (ready && lastPetBounds) {
        current.setBounds(placedBounds(lastPetBounds));
      }
    }
    if (!ready) {
      pending = payload;
      return;
    }
    current.send(PlatformChannels.DesktopPetActivity, payload);
    if (!visible) {
      current.showInactive();
      visible = true;
    }
  }

  function hide(): void {
    pending = undefined;
    if (win && !win.isDestroyed() && visible) {
      win.hide();
    }
    visible = false;
  }

  /** 宠物移动/缩放后重新挂靠；窗口隐藏时也更新 bounds，保证下次显示就在正确位置。 */
  function reposition(petBounds: Rectangle): void {
    lastPetBounds = petBounds;
    if (!win || win.isDestroyed()) {
      return;
    }
    win.setBounds(placedBounds(petBounds));
  }

  function destroy(): void {
    pending = undefined;
    visible = false;
    ready = false;
    lastPetBounds = undefined;
    currentSize = resolveDesktopPetBubbleSize(1);
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
    win = null;
  }

  return {
    ensure,
    destroy,
    show,
    hide,
    reposition,
    isVisible: () => visible && Boolean(win && !win.isDestroyed()),
    ownsWindow: (candidate) => Boolean(win && !win.isDestroyed() && win.ownsWindow(candidate)),
    ownsWebContents: (id) => Boolean(win && !win.isDestroyed() && win.ownsWebContents(id)),
  };
}
