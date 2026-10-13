/**
 * 桌面宠物窗口的 preload（本地定制，specs/desktop/desktop-pet.md）。
 * 只暴露宠物窗口需要的最小面（getActive / drag / context-menu / open-app / onState /
 * onDragDirection），不复用主窗口的 preload —— 攻击面越小越好。
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  PlatformChannels,
  type DesktopPetActivePayload,
  type DesktopPetDragDirection,
  type DesktopPetState,
} from "@zcode/shared";

contextBridge.exposeInMainWorld("desktopPet", {
  /** 拉取当前宠物（清单 + petpack:// 精灵表 URL + 初始状态）；未启用/无宠物时 undefined。 */
  getActive: (): Promise<DesktopPetActivePayload | undefined> =>
    ipcRenderer.invoke(PlatformChannels.PetGetActive),
  /** 拖动开始：main 进入跟随光标的 16ms 移动循环。 */
  dragStart: () => ipcRenderer.send(PlatformChannels.PetDragStart),
  /** 拖动结束：返回累计位移，供渲染器区分点击（≤6px）与拖拽。 */
  dragEnd: (): Promise<{ movedPx: number }> =>
    ipcRenderer.invoke(PlatformChannels.PetDragEnd),
  /** 右键：由 main 弹出原生菜单（切换宠物/隐藏/打开 ZCode）。 */
  contextMenu: () => ipcRenderer.send(PlatformChannels.PetContextMenu),
  /** 双击：打开（激活）主窗口。 */
  openApp: () => ipcRenderer.send(PlatformChannels.PetOpenApp),
  /** 订阅状态下发（waving 为 one-shot，由页面 3.2s 后回退）。 */
  onState: (callback: (state: DesktopPetState | "waving") => void) => {
    const listener = (_event: unknown, payload: DesktopPetState | "waving") => callback(payload);
    ipcRenderer.on(PlatformChannels.DesktopPetState, listener);
    return () => ipcRenderer.removeListener(PlatformChannels.DesktopPetState, listener);
  },
  /** 订阅拖动方向动画（running-left / running-right / running）。 */
  onDragDirection: (callback: (direction: DesktopPetDragDirection) => void) => {
    const listener = (_event: unknown, payload: DesktopPetDragDirection) => callback(payload);
    ipcRenderer.on(PlatformChannels.DesktopPetDragDirection, listener);
    return () => ipcRenderer.removeListener(PlatformChannels.DesktopPetDragDirection, listener);
  },
});