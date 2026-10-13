import type { Rectangle } from "electron";

/**
 * 桌面宠物窗口工厂（本地定制，specs/desktop/desktop-pet.md）。
 * 属性组合参考 cuaPermissionDragPanel 的实测结论：
 *   frame:false + transparent  —— 无边框圆角悬浮观感
 *   type:"panel"               —— macOS 点击不激活 app
 *   focusable:false            —— 不抢焦点
 *   show:false + showInactive  —— 显示但不激活
 *   alwaysOnTop("screen-saver")—— 压过系统设置窗口；floating 会被盖住
 * 差异：可接收鼠标交互（单击/拖动/右键），因此**不使用** setIgnoreMouseEvents。
 */

export interface DesktopPetWindowHandle {
  onceReadyToShow(callback: () => void): void;
  /** 显示但不激活；每次显示重申置顶与全工作区可见（Windows 隐藏后丢 topmost 的教训）。 */
  showInactive(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  getBounds(): Rectangle;
  setPosition(x: number, y: number): void;
  /** 缩放缓动：整块换 bounds（尺寸 + 位置），避免先改尺寸再挪位的中间态闪烁。 */
  setBounds(bounds: Rectangle): void;
  /** 判断某 BrowserWindow 是否为本宠物窗口（接入主窗集合排除逻辑）。 */
  ownsWindow(candidate: object): boolean;
  ownsWebContents(id: number): boolean;
}

/**
 * 汇报气泡窗口（三期，specs/desktop/desktop-pet.md）。
 * 与宠物窗口同族属性，但额外 `setIgnoreMouseEvents(true)`：纯展示，不挡桌面操作。
 */
export interface DesktopPetBubbleWindowHandle {
  onceReadyToShow(callback: () => void): void;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  send(channel: string, payload: unknown): void;
  setBounds(bounds: Rectangle): void;
  ownsWindow(candidate: object): boolean;
  ownsWebContents(id: number): boolean;
}

export function createDesktopPetWindow(deps: {
  BrowserWindow: typeof import("electron").BrowserWindow;
  app: Pick<typeof import("electron").app, "isPackaged">;
  preloadPath: string;
  rendererDir: string;
  rendererDevUrl?: string | undefined;
}): (initialBounds: Rectangle) => DesktopPetWindowHandle {
  return (initialBounds: Rectangle) => {
    const win = new deps.BrowserWindow({
      ...initialBounds,
      type: "panel",
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // 与主窗口保持一致：生产包始终加载签名包内的渲染资源。
    if (!deps.app.isPackaged && deps.rendererDevUrl) {
      void win.loadURL(`${deps.rendererDevUrl}/pet.html`);
    } else {
      void win.loadFile(`${deps.rendererDir}/pet.html`);
    }

    return {
      onceReadyToShow(callback: () => void) {
        win.once("ready-to-show", callback);
      },
      showInactive() {
        win.showInactive();
        win.setAlwaysOnTop(true, "screen-saver");
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      },
      hide() {
        win.hide();
      },
      destroy() {
        win.destroy();
      },
      isDestroyed: () => win.isDestroyed(),
      send(channel: string, payload: unknown) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      },
      getBounds() {
        return win.getBounds();
      },
      setPosition(x: number, y: number) {
        if (!win.isDestroyed()) win.setPosition(Math.round(x), Math.round(y), false);
      },
      setBounds(bounds: Rectangle) {
        if (!win.isDestroyed())
          win.setBounds({
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
          });
      },
      ownsWindow(candidate: object) {
        return candidate === win;
      },
      ownsWebContents(id: number) {
        return !win.isDestroyed() && win.webContents.id === id;
      },
    };
  };
}

export function createDesktopPetBubbleWindow(deps: {
  BrowserWindow: typeof import("electron").BrowserWindow;
  app: Pick<typeof import("electron").app, "isPackaged">;
  preloadPath: string;
  rendererDir: string;
  rendererDevUrl?: string | undefined;
}): (initialBounds: Rectangle) => DesktopPetBubbleWindowHandle {
  return (initialBounds: Rectangle) => {
    const win = new deps.BrowserWindow({
      ...initialBounds,
      type: "panel",
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // 会话条可点击（点击跳转到对应会话）：不再整窗穿透；
    // 气泡尺寸小且只覆盖宠物旁一小块区域，交互优先级留给跳转。
    // （历史语境：曾用 setIgnoreMouseEvents(true) 做纯展示浮层。）

    if (!deps.app.isPackaged && deps.rendererDevUrl) {
      void win.loadURL(`${deps.rendererDevUrl}/bubble.html`);
    } else {
      void win.loadFile(`${deps.rendererDir}/bubble.html`);
    }

    return {
      onceReadyToShow(callback: () => void) {
        win.once("ready-to-show", callback);
      },
      showInactive() {
        win.showInactive();
        win.setAlwaysOnTop(true, "screen-saver");
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      },
      hide() {
        win.hide();
      },
      destroy() {
        win.destroy();
      },
      isDestroyed: () => win.isDestroyed(),
      isVisible: () => !win.isDestroyed() && win.isVisible(),
      send(channel: string, payload: unknown) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      },
      setBounds(bounds: Rectangle) {
        if (!win.isDestroyed())
          win.setBounds({
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
          });
      },
      ownsWindow(candidate: object) {
        return candidate === win;
      },
      ownsWebContents(id: number) {
        return !win.isDestroyed() && win.webContents.id === id;
      },
    };
  };
}
