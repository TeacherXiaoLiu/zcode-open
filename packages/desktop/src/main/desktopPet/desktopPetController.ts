import { Menu, screen } from "electron";
import type { BrowserWindow, MenuItemConstructorOptions, Point, Rectangle } from "electron";
import {
  DESKTOP_PET_ATLAS,
  DESKTOP_PET_STATE_PRIORITY,
  DESKTOP_PET_WINDOW_SCALE,
  PlatformChannels,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  type AppSettings,
  type DesktopPetActivePayload,
  type DesktopPetDragDirection,
  type DesktopPetManifest,
  type DesktopPetState,
  type Locale,
} from "@zcode/shared";
import {
  DESKTOP_PET_SPRITESHEET_FILE,
  ensureBundledDesktopPetsInstalled,
  listInstalledDesktopPets,
  readDesktopPetManifest,
} from "./desktopPetCatalog.js";
import { DESKTOP_PET_PACK_SCHEME } from "./desktopPetProtocol.js";
import type { DesktopPetWindowHandle } from "./desktopPetWindow.js";

/**
 * 桌面宠物控制器（本地定制，specs/desktop/desktop-pet.md）。
 *
 * 职责边界：
 *   - 窗口生命周期：设置开关/宠物切换时创建与销毁；跟随设置持久化位置。
 *   - 状态汇总：renderer 是会话聚合状态的唯一生产者（reportState），这里只做
 *     多窗口按优先级取最高（不重新解释会话语义），再转发给宠物窗口。
 *   - 拖动：pointerdown 后 main 以 16ms 跟随光标移动窗口并推送方向动画；
 *     drag-end 返回累计位移供渲染器区分点击/拖拽，并持久化位置。
 *   - 右键菜单：切换宠物 / 隐藏桌宠 / 打开 ZCode。
 */

const DRAG_TICK_MS = 16;
const DRAG_CLICK_THRESHOLD_PX = 6;
const WINDOW_EDGE_MARGIN_PX = 24;
const WINDOW_BOTTOM_OFFSET_PX = 96;

export interface DesktopPetLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface DesktopPetControllerDeps {
  logger?: DesktopPetLogger;
  petsRootDir: string;
  /** 随包分发的内置宠物目录（首次启用时复制到用户目录）。 */
  bundledPetsDir: string;
  createWindow: (initialBounds: Rectangle) => DesktopPetWindowHandle;
  /** 写回 desktopPetPosition（拖动结束后）。 */
  persistPosition: (position: { x: number; y: number }) => void;
  /** 写回 desktopPetId（右键菜单切换宠物）。 */
  persistActivePetId: (petId: string) => void;
  /** 右键"隐藏桌宠"（写 desktopPetEnabled=false，走设置链路回扫）。 */
  setEnabled: (enabled: boolean) => void;
  /** 双击宠物/菜单"打开 ZCode"：激活主窗口。 */
  openMainWindow: () => void;
  getLocale: () => Locale;
}

export interface DesktopPetController {
  /** 应用设置补丁（syncImmediateAppSettings 与启动装配共用这一条写入路径）。 */
  applySettings(patch: Partial<AppSettings>): void;
  /** pet 窗口拉取当前宠物（getActive IPC 的应答）。 */
  getActivePayload(): DesktopPetActivePayload | undefined;
  /** renderer 上报会话聚合状态（多窗口）。 */
  reportState(state: DesktopPetState, reporterId: number): void;
  /** renderer 销毁时清理上报（避免陈旧状态延续）。 */
  releaseReporter(reporterId: number): void;
  /** 切换当前宠物（设置页/右键菜单）：持久化 + 热重建窗口。 */
  switchActivePet(petId: string): void;
  /** 双击宠物/菜单"打开 ZCode"（IPC 入口转发）。 */
  openMainWindow(): void;
  startDrag(): void;
  endDrag(): { movedPx: number };
  showContextMenu(): void;
  /** 接入主窗集合排除逻辑（close-to-tray/单实例聚焦不得把桌宠当主窗）。 */
  ownsWindow(candidate: BrowserWindow): boolean;
  dispose(): void;
}

interface DragSession {
  interval?: ReturnType<typeof setInterval>;
  cursorStart: Point;
  windowStart: { x: number; y: number };
  movedPx: number;
  direction?: DesktopPetDragDirection;
}

export function createDesktopPetController(deps: DesktopPetControllerDeps): DesktopPetController {
  let disposed = false;
  let enabled = false;
  let activePetId: string | undefined;
  let savedPosition: { x: number; y: number } | undefined;
  let window: DesktopPetWindowHandle | null = null;
  let dragSession: DragSession | null = null;
  const stateByReporter = new Map<number, DesktopPetState>();
  let lastPushedState: DesktopPetState | undefined;

  function windowSize(): { width: number; height: number } {
    return {
      width: Math.round(DESKTOP_PET_ATLAS[1].frameWidth * DESKTOP_PET_WINDOW_SCALE),
      height: Math.round(DESKTOP_PET_ATLAS[1].frameHeight * DESKTOP_PET_WINDOW_SCALE),
    };
  }

  function defaultBottomRight(width: number, height: number): { x: number; y: number } {
    const { workArea } = screen.getPrimaryDisplay();
    return {
      x: workArea.x + workArea.width - width - WINDOW_EDGE_MARGIN_PX,
      y: workArea.y + workArea.height - height - WINDOW_BOTTOM_OFFSET_PX,
    };
  }

  function resolveInitialBounds(): Rectangle {
    const { width, height } = windowSize();
    const candidate = savedPosition ?? defaultBottomRight(width, height);
    // 保存的位置可能来自已拔除的显示器：夹到最近显示器的可见工作区内。
    const { workArea } = screen.getDisplayNearestPoint(candidate);
    return {
      width,
      height,
      x: Math.round(
        Math.min(Math.max(candidate.x, workArea.x), workArea.x + workArea.width - width),
      ),
      y: Math.round(
        Math.min(Math.max(candidate.y, workArea.y), workArea.y + workArea.height - height),
      ),
    };
  }

  function effectiveState(): DesktopPetState {
    let bestIndex = DESKTOP_PET_STATE_PRIORITY.length - 1;
    for (const state of stateByReporter.values()) {
      const index = DESKTOP_PET_STATE_PRIORITY.indexOf(state);
      if (index >= 0 && index < bestIndex) {
        bestIndex = index;
      }
    }
    return DESKTOP_PET_STATE_PRIORITY[bestIndex] ?? "idle";
  }

  function pushState(force = false): void {
    if (!window || window.isDestroyed()) {
      return;
    }
    const next = effectiveState();
    if (!force && next === lastPushedState) {
      return;
    }
    lastPushedState = next;
    window.send(PlatformChannels.DesktopPetState, next);
  }

  function resolveActivePet(): DesktopPetManifest | null {
    // 首次启用时把内置默认宠物（MIT 资产）铺到用户目录；已存在或失败都不阻塞。
    ensureBundledDesktopPetsInstalled(deps.bundledPetsDir, deps.petsRootDir);
    const installed = listInstalledDesktopPets(deps.petsRootDir);
    if (installed.length === 0) {
      return null;
    }
    const desired =
      activePetId && installed.some((pet) => pet.id === activePetId)
        ? activePetId
        : (installed[0]?.id ?? activePetId);
    if (!desired) {
      return null;
    }
    const manifest = readDesktopPetManifest(desired, deps.petsRootDir);
    if (manifest) {
      activePetId = desired;
    }
    return manifest;
  }

  function stopDrag(): void {
    if (dragSession) {
      if (dragSession.interval) {
        clearInterval(dragSession.interval);
      }
      dragSession = null;
    }
  }

  function destroyWindow(): void {
    stopDrag();
    if (window) {
      if (!window.isDestroyed()) {
        window.destroy();
      }
      window = null;
    }
    lastPushedState = undefined;
  }

  function ensureWindow(): void {
    if (disposed || !enabled || (window && !window.isDestroyed())) {
      return;
    }
    const manifest = resolveActivePet();
    if (!manifest) {
      deps.logger?.warn(
        "[desktop-pet] no valid pet found in pets directory; window stays hidden",
        { petsRootDir: deps.petsRootDir },
      );
      return;
    }
    const created = deps.createWindow(resolveInitialBounds());
    window = created;
    created.onceReadyToShow(() => {
      if (disposed || window !== created || created.isDestroyed()) {
        return;
      }
      created.showInactive();
      pushState(true);
    });
    deps.logger?.info("[desktop-pet] window created", {
      petId: manifest.id,
      spriteVersionNumber: manifest.spriteVersionNumber,
    });
  }

  function switchActivePet(petId: string): void {
    if (petId === activePetId) {
      return;
    }
    activePetId = petId;
    deps.persistActivePetId(petId);
    // 切换频率低：重建窗口换内容最简单可靠（不维护第二条热切换路径）。
    destroyWindow();
    ensureWindow();
  }

  function applySettings(patch: Partial<AppSettings>): void {
    if (disposed) {
      return;
    }
    if (patch.desktopPetPosition) {
      savedPosition = patch.desktopPetPosition;
    }
    let petIdChanged = false;
    if (patch.desktopPetId !== undefined) {
      const nextId = patch.desktopPetId.trim() || undefined;
      petIdChanged = nextId !== activePetId;
      activePetId = nextId;
    }

    if (patch.desktopPetEnabled === false) {
      enabled = false;
      destroyWindow();
      return;
    }
    if (patch.desktopPetEnabled === true) {
      enabled = true;
    }
    if (!enabled) {
      return;
    }
    if (petIdChanged) {
      destroyWindow();
    }
    ensureWindow();
  }

  function tickDrag(session: DragSession): void {
    if (!window || window.isDestroyed()) {
      stopDrag();
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - session.cursorStart.x;
    const dy = cursor.y - session.cursorStart.y;
    if (dx === 0 && dy === 0) {
      return;
    }
    session.movedPx = Math.hypot(dx, dy);
    window.setPosition(session.windowStart.x + dx, session.windowStart.y + dy);
    const direction: DesktopPetDragDirection =
      Math.abs(dx) >= Math.abs(dy)
        ? dx >= 0
          ? "running-right"
          : "running-left"
        : "running";
    if (direction !== session.direction) {
      session.direction = direction;
      window.send(PlatformChannels.DesktopPetDragDirection, direction);
    }
  }

  function startDrag(): void {
    if (!window || window.isDestroyed() || dragSession) {
      return;
    }
    const bounds = window.getBounds();
    const session: DragSession = {
      cursorStart: screen.getCursorScreenPoint(),
      windowStart: { x: bounds.x, y: bounds.y },
      movedPx: 0,
    };
    // 先入档再挂 tick：tick 闭包引用同一 session，避免自引用初始化顺序问题。
    dragSession = session;
    session.interval = setInterval(() => tickDrag(session), DRAG_TICK_MS);
  }

  function endDrag(): { movedPx: number } {
    const session = dragSession;
    stopDrag();
    const movedPx = session?.movedPx ?? 0;
    if (
      session &&
      movedPx > DRAG_CLICK_THRESHOLD_PX &&
      window &&
      !window.isDestroyed()
    ) {
      const bounds = window.getBounds();
      savedPosition = { x: bounds.x, y: bounds.y };
      deps.persistPosition(savedPosition);
    }
    return { movedPx };
  }

  function showContextMenu(): void {
    if (!window || window.isDestroyed()) {
      return;
    }
    const locale = deps.getLocale();
    const installed = listInstalledDesktopPets(deps.petsRootDir);
    const template: MenuItemConstructorOptions[] = [];
    if (installed.length > 1) {
      template.push({
        label: getDesktopMenuMessage(locale, desktopMenuMessageIds.petSwitch),
        submenu: installed.map((pet) => ({
          label: pet.displayName,
          type: "radio" as const,
          checked: pet.id === activePetId,
          click: () => switchActivePet(pet.id),
        })),
      });
    }
    template.push(
      {
        label: getDesktopMenuMessage(locale, desktopMenuMessageIds.petHide),
        click: () => deps.setEnabled(false),
      },
      { type: "separator" },
      {
        label: getDesktopMenuMessage(locale, desktopMenuMessageIds.trayOpenZCode),
        click: () => deps.openMainWindow(),
      },
    );
    Menu.buildFromTemplate(template).popup();
  }

  function getActivePayload(): DesktopPetActivePayload | undefined {
    if (!enabled || !window || window.isDestroyed() || !activePetId) {
      return undefined;
    }
    const manifest = readDesktopPetManifest(activePetId, deps.petsRootDir);
    if (!manifest) {
      return undefined;
    }
    return {
      pet: manifest,
      spritesheetUrl: `${DESKTOP_PET_PACK_SCHEME}://${manifest.id}/${DESKTOP_PET_SPRITESHEET_FILE}`,
      state: effectiveState(),
    };
  }

  return {
    applySettings,
    getActivePayload,
    reportState(state, reporterId) {
      if (disposed) {
        return;
      }
      const previous = stateByReporter.get(reporterId);
      if (previous === state) {
        return;
      }
      stateByReporter.set(reporterId, state);
      pushState();
    },
    releaseReporter(reporterId) {
      if (stateByReporter.delete(reporterId)) {
        pushState();
      }
    },
    switchActivePet,
    openMainWindow: () => deps.openMainWindow(),
    startDrag,
    endDrag,
    showContextMenu,
    ownsWindow(candidate) {
      return Boolean(window && !window.isDestroyed() && window.ownsWindow(candidate));
    },
    dispose() {
      disposed = true;
      enabled = false;
      destroyWindow();
      stateByReporter.clear();
    },
  };
}