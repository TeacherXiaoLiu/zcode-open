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
  /** 判断某 BrowserWindow 是否为本宠物窗口（接入主窗集合排除逻辑）。 */
  ownsWindow(candidate: object): boolean;
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
      ownsWindow(candidate: object) {
        return candidate === win;
      },
    };
  };
}