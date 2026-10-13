import { Menu, screen } from "electron";
import type { BrowserWindow, MenuItemConstructorOptions, Rectangle } from "electron";
import {
  DESKTOP_PET_ATLAS,
  DESKTOP_PET_SCALE_DEFAULT,
  PlatformChannels,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  normalizeDesktopPetScale,
  type AppSettings,
  type DesktopPetActivePayload,
  type DesktopPetActivity,
  type DesktopPetBubblePayload,
  type DesktopPetManifest,
  type DesktopPetState,
  type Locale,
} from "@zcode/shared";
import { resolveEffectiveActivity } from "./desktopPetActivity.js";
import {
  DESKTOP_PET_SPRITESHEET_FILE,
  ensureBundledDesktopPetsInstalled,
  listInstalledDesktopPets,
  readDesktopPetManifest,
} from "./desktopPetCatalog.js";
import { createDesktopPetBubble, type DesktopPetBubbleHandle } from "./desktopPetBubble.js";
import { createDesktopPetDrag } from "./desktopPetDrag.js";
import {
  resolveDesktopPetBounds,
  resolveResizedDesktopPetBounds,
} from "./desktopPetPlacement.js";
import { DESKTOP_PET_PACK_SCHEME } from "./desktopPetProtocol.js";
import type {
  DesktopPetBubbleWindowHandle,
  DesktopPetWindowHandle,
} from "./desktopPetWindow.js";

/**
 * 桌面宠物控制器（本地定制，specs/desktop/desktop-pet.md）。
 *
 * 职责边界：
 *   - 窗口生命周期：设置开关/宠物切换时创建与销毁；跟随设置持久化位置。
 *   - 活动汇总：renderer 是会话活动（状态 + 标题）的唯一生产者（reportActivity），这里只做
 *     多窗口按优先级取最高（不重新解释会话语义），再转发给宠物窗口与汇报气泡。
 *   - 拖动：pointerdown 后 main 以 16ms 跟随光标移动窗口并推送方向动画；
 *     drag-end 返回累计位移供渲染器区分点击/拖拽，并持久化位置。
 *   - 右键菜单：切换宠物 / 隐藏桌宠 / 打开 ZCode。
 */

const DRAG_CLICK_THRESHOLD_PX = 6;
/** 气泡会话列表条数上限（渲染预算与高度由 desktopPetBubble 按条数计算）。 */
const MAX_BUBBLE_SESSIONS = 3;

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
  /** 会话汇报气泡窗口工厂（三期）；缺省则不创建气泡。 */
  createBubbleWindow?: (initialBounds: Rectangle) => DesktopPetBubbleWindowHandle;
  /** 写回 desktopPetPosition（拖动结束 / 缩放缓动后）。 */
  persistPosition: (position: { x: number; y: number }) => void;
  /** 写回 desktopPetId（右键菜单切换宠物）。 */
  persistActivePetId: (petId: string) => Promise<void>;
  /** 右键"隐藏桌宠"（写 desktopPetEnabled=false，走设置链路回扫）。 */
  setEnabled: (enabled: boolean) => void;
  /** 双击宠物/菜单"打开 ZCode"：激活主窗口。 */
  openMainWindow: () => void;
  /** 气泡点击会话条：把"打开会话"请求转发给应用主窗口（跨 workspace 导航由 renderer 完成）。 */
  openSession: (sessionId: string) => void;
  getLocale: () => Locale;
}

export interface DesktopPetController {
  /** 应用设置补丁（syncImmediateAppSettings 与启动装配共用这一条写入路径）。 */
  applySettings(patch: Partial<AppSettings>): void;
  /** pet 窗口拉取当前宠物（getActive IPC 的应答）。 */
  getActivePayload(): DesktopPetActivePayload | undefined;
  /** renderer 上报会话活动（多窗口）。 */
  reportActivity(activity: DesktopPetActivity, reporterId: number): void;
  /** renderer 销毁时清理上报（避免陈旧状态延续）。 */
  releaseReporter(reporterId: number): void;
  /** 气泡窗口拉取当前汇总活动（getActivity IPC 的应答）。 */
  getBubblePayload(): DesktopPetBubblePayload;
  /** 气泡点击会话条：移除该条（视为已处理）并请求主窗口跳转到对应会话。 */
  openSession(sessionId: string): void;
  /** 当前活动宠物 ID（删除安全检查用）。 */
  getActivePetId(): string | undefined;
  /** 切换当前宠物（设置页/右键菜单）：持久化 + 热重建窗口。 */
  switchActivePet(petId: string): Promise<void>;
  /** 双击宠物/菜单"打开 ZCode"（IPC 入口转发）。 */
  openMainWindow(): void;
  startDrag(): void;
  endDrag(): { movedPx: number };
  showContextMenu(): void;
  /** 接入主窗集合排除逻辑（close-to-tray/单实例聚焦不得把桌宠当主窗）。 */
  ownsWindow(candidate: BrowserWindow): boolean;
  ownsWebContents(id: number): boolean;
  ownsBubbleWebContents(id: number): boolean;
  dispose(): void;
}

export function createDesktopPetController(deps: DesktopPetControllerDeps): DesktopPetController {
  let disposed = false;
  let enabled = false;
  let activePetId: string | undefined;
  let savedPosition: { x: number; y: number } | undefined;
  let scale = DESKTOP_PET_SCALE_DEFAULT;
  let window: DesktopPetWindowHandle | null = null;
  const stateByReporter = new Map<number, DesktopPetActivity>();
  /** 用户点击跳转过的会话：从气泡移除（视为已处理）；重新运行时会话会清除该标记。 */
  const dismissedSessions = new Set<string>();
  let lastPushedState: DesktopPetState | undefined;
  let lastBubbleKey: string | undefined;
  const bubble: DesktopPetBubbleHandle | null = deps.createBubbleWindow
    ? createDesktopPetBubble({
        createWindow: deps.createBubbleWindow,
        getWorkArea: (point) => screen.getDisplayNearestPoint(point).workArea,
      })
    : null;
  const drag = createDesktopPetDrag({
    getWindow: () => window,
    getCursor: () => screen.getCursorScreenPoint(),
    // 拖动中隐藏气泡：避免 16ms 跟随产生拖影；松手后按新位置恢复。
    onStart: () => bubble?.hide(),
  });

  function windowSize(): { width: number; height: number } {
    return {
      width: Math.max(1, Math.round(DESKTOP_PET_ATLAS[1].frameWidth * scale)),
      height: Math.max(1, Math.round(DESKTOP_PET_ATLAS[1].frameHeight * scale)),
    };
  }

  function workAreaNearest(point: { x: number; y: number }): Rectangle {
    return screen.getDisplayNearestPoint(point).workArea;
  }

  function resolveInitialBounds(): Rectangle {
    const size = windowSize();
    // 保存的位置可能来自已拔除的显示器：按候选点选最近显示器；无保存位置用主显示器。
    const workArea = savedPosition
      ? workAreaNearest(savedPosition)
      : screen.getPrimaryDisplay().workArea;
    return resolveDesktopPetBounds({ saved: savedPosition, size, workArea });
  }

  function effectiveActivity(): DesktopPetActivity {
    return resolveEffectiveActivity(stateByReporter.values(), dismissedSessions, MAX_BUBBLE_SESSIONS);
  }

  function pushActivity(force = false): void {
    const next = effectiveActivity();
    if (window && !window.isDestroyed()) {
      if (force || next.state !== lastPushedState) {
        lastPushedState = next.state;
        window.send(PlatformChannels.DesktopPetState, next.state);
      }
    }
    syncBubble(next, force);
  }

  function syncBubble(activity: DesktopPetActivity, force = false): void {
    if (!bubble) {
      return;
    }
    if (activity.state === "idle" || activity.sessions.length === 0) {
      lastBubbleKey = undefined;
      bubble.hide();
      return;
    }
    const key = JSON.stringify(activity.sessions);
    if (!force && key === lastBubbleKey) {
      return;
    }
    lastBubbleKey = key;
    bubble.show(activity, deps.getLocale());
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

  function destroyWindow(): void {
    drag.stop();
    if (window) {
      if (!window.isDestroyed()) {
        window.destroy();
      }
      window = null;
    }
    lastPushedState = undefined;
    lastBubbleKey = undefined;
    bubble?.destroy();
  }

  function ensureWindow(): void {
    if (disposed || !enabled || (window && !window.isDestroyed())) {
      return;
    }
    const manifest = resolveActivePet();
    if (!manifest) {
      deps.logger?.warn("[desktop-pet] no valid pet found in pets directory; window stays hidden", {
        petsRootDir: deps.petsRootDir,
      });
      return;
    }
    const bounds = resolveInitialBounds();
    const created = deps.createWindow(bounds);
    window = created;
    // 汇报气泡与宠物窗口同生命周期；挂靠在宠物旁，等首次活动驱动显示。
    bubble?.ensure(bounds);
    created.onceReadyToShow(() => {
      if (disposed || window !== created || created.isDestroyed()) {
        return;
      }
      created.showInactive();
      pushActivity(true);
    });
    deps.logger?.info("[desktop-pet] window created", {
      petId: manifest.id,
      spriteVersionNumber: manifest.spriteVersionNumber,
      scale,
    });
  }

  /** 缩放缓动：窗口存在时按底部中心锚定换 bounds，并持久化新位置。 */
  function resizeWindow(): void {
    if (!window || window.isDestroyed()) {
      return;
    }
    const bounds = window.getBounds();
    const next = resolveResizedDesktopPetBounds(bounds, windowSize(), workAreaNearest(bounds));
    window.setBounds(next);
    savedPosition = { x: next.x, y: next.y };
    deps.persistPosition(savedPosition);
    bubble?.reposition(next);
  }

  async function switchActivePet(petId: string): Promise<void> {
    if (!readDesktopPetManifest(petId, deps.petsRootDir))
      throw new Error("INVALID_PET: 宠物未安装或清单无效");
    if (petId === activePetId) return;
    // 持久化成功后才切换，设置页不会在 IPC 返回时读到旧 ID。
    await deps.persistActivePetId(petId);
    activePetId = petId;
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
    let scaleChanged = false;
    if (patch.desktopPetScale !== undefined) {
      const next = normalizeDesktopPetScale(patch.desktopPetScale);
      scaleChanged = next !== scale;
      scale = next;
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
    // 窗口已存在时 ensureWindow 不会重建，缩放需要显式套用；新建窗口自带新尺寸。
    if (scaleChanged && window && !window.isDestroyed()) {
      resizeWindow();
    }
  }

  function startDrag(): void {
    drag.start();
  }

  function endDrag(): { movedPx: number } {
    const active = drag.isActive();
    const { movedPx } = drag.end();
    if (active && window && !window.isDestroyed()) {
      const bounds = window.getBounds();
      if (movedPx > DRAG_CLICK_THRESHOLD_PX) {
        savedPosition = { x: bounds.x, y: bounds.y };
        deps.persistPosition(savedPosition);
      }
      // 先按最新 bounds 重挂，再让活动状态决定是否重新显示（拖动中气泡是隐藏的）。
      bubble?.reposition(bounds);
      syncBubble(effectiveActivity(), true);
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
          click: () => {
            void switchActivePet(pet.id).catch((error) =>
              deps.logger?.warn("[desktop-pet] 切换宠物失败", { error: String(error) }),
            );
          },
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
      state: effectiveActivity().state,
    };
  }

  return {
    applySettings,
    getActivePayload,
    reportActivity(activity, reporterId) {
      if (disposed) {
        return;
      }
      for (const session of activity.sessions) {
        // 会话重新跑起来 → 清除"已处理"标记，完成后可以再次提醒。
        if (session.state === "running") {
          dismissedSessions.delete(session.sessionId);
        }
      }
      const previous = stateByReporter.get(reporterId);
      if (previous && JSON.stringify(previous.sessions) === JSON.stringify(activity.sessions)) {
        return;
      }
      stateByReporter.set(reporterId, {
        state: activity.state,
        sessions: activity.sessions,
      });
      pushActivity();
    },
    releaseReporter(reporterId) {
      if (stateByReporter.delete(reporterId)) {
        pushActivity();
      }
    },
    getBubblePayload() {
      return { activity: effectiveActivity(), locale: deps.getLocale() };
    },
    openSession(sessionId) {
      if (disposed) {
        return;
      }
      dismissedSessions.add(sessionId);
      // 先激活主窗口再转发跳转请求：气泡点击时主窗可能最小化或被盖住。
      deps.openMainWindow();
      deps.openSession(sessionId);
      pushActivity();
    },
    getActivePetId: () => activePetId,
    switchActivePet,
    openMainWindow: () => deps.openMainWindow(),
    startDrag,
    endDrag,
    showContextMenu,
    ownsWindow(candidate) {
      // 宠物窗口与汇报气泡都从属于桌宠功能：主窗集合（close-to-tray/单实例聚焦/
      // last-window 判断）都必须排除它们。
      return Boolean(
        (window && !window.isDestroyed() && window.ownsWindow(candidate)) ||
        bubble?.ownsWindow(candidate),
      );
    },
    ownsWebContents(id) {
      return Boolean(window && !window.isDestroyed() && window.ownsWebContents(id));
    },
    ownsBubbleWebContents(id) {
      return Boolean(bubble?.ownsWebContents(id));
    },
    dispose() {
      disposed = true;
      enabled = false;
      destroyWindow();
      stateByReporter.clear();
      dismissedSessions.clear();
    },
  };
}
