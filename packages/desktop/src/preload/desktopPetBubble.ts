/**
 * 桌宠汇报气泡窗口的 preload（本地定制，specs/desktop/desktop-pet.md）。
 * 与宠物窗口同样遵循最小面原则：只暴露气泡渲染所需的活动拉取与订阅。
 */
import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels, type DesktopPetBubblePayload } from "@zcode/shared";

contextBridge.exposeInMainWorld("desktopPetBubble", {
  /** 拉取当前汇总活动（窗口就绪时的初始值）。 */
  getActivity: (): Promise<DesktopPetBubblePayload> =>
    ipcRenderer.invoke(PlatformChannels.PetGetActivity),
  /** 订阅活动推送（状态变化或会话标题变化时下发）。 */
  onActivity: (callback: (payload: DesktopPetBubblePayload) => void) => {
    const listener = (_event: unknown, payload: DesktopPetBubblePayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.DesktopPetActivity, listener);
    return () => ipcRenderer.removeListener(PlatformChannels.DesktopPetActivity, listener);
  },
  /** 点击会话条：请求 main 打开对应会话（条目保留，气泡保持常驻）。 */
  openSession: (sessionId: string): void =>
    ipcRenderer.send(PlatformChannels.PetBubbleOpenSession, sessionId),
  /** 点击条目上的关闭按钮：请求 main 移除该条目（唯一的移除路径）。 */
  dismissSession: (sessionId: string): void =>
    ipcRenderer.send(PlatformChannels.PetBubbleDismissSession, sessionId),
});
