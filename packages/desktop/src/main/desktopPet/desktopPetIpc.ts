import { ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_PET_STATE_PRIORITY,
  PlatformChannels,
  type DesktopPetState,
} from "@zcode/shared";
import { listInstalledDesktopPets } from "./desktopPetCatalog.js";
import type { DesktopPetController } from "./desktopPetController.js";

/**
 * 桌面宠物 IPC 注册（本地定制，specs/desktop/desktop-pet.md）。
 * pet 窗口（getActive/drag/context-menu/open-app）与设置页（list-installed/set-active）
 * 都经这些频道进入控制器；状态上报按 sender 区分上报者。
 * 返回反注册函数（dispose 时摘掉 handler）。
 */
export function registerDesktopPetIpc(options: {
  controller: DesktopPetController;
  petsRootDir: string;
}): () => void {
  const { controller } = options;

  const onGetActive = () => controller.getActivePayload();
  ipcMain.handle(PlatformChannels.PetGetActive, onGetActive);

  const onStateReport = (event: IpcMainEvent, payload: unknown) => {
    // 载荷是状态名（来自主 renderer 的会话聚合器）：白名单校验，拼错不得污染动画。
    if (
      typeof payload !== "string" ||
      !(DESKTOP_PET_STATE_PRIORITY as readonly string[]).includes(payload)
    ) {
      return;
    }
    controller.reportState(payload as DesktopPetState, event.sender.id);
  };
  ipcMain.on(PlatformChannels.PetStateReport, onStateReport);

  const onDragStart = () => controller.startDrag();
  ipcMain.on(PlatformChannels.PetDragStart, onDragStart);

  const onDragEnd = () => controller.endDrag();
  ipcMain.handle(PlatformChannels.PetDragEnd, onDragEnd);

  const onContextMenu = () => controller.showContextMenu();
  ipcMain.on(PlatformChannels.PetContextMenu, onContextMenu);

  const onOpenApp = () => controller.openMainWindow();
  ipcMain.on(PlatformChannels.PetOpenApp, onOpenApp);

  const onListInstalled = () => listInstalledDesktopPets(options.petsRootDir);
  ipcMain.handle(PlatformChannels.PetListInstalled, onListInstalled);

  const onSetActive = (_event: IpcMainInvokeEvent, payload: unknown) => {
    if (typeof payload !== "string" || !payload.trim()) {
      return;
    }
    controller.switchActivePet(payload.trim());
  };
  ipcMain.handle(PlatformChannels.PetSetActive, onSetActive);

  return () => {
    ipcMain.removeHandler(PlatformChannels.PetGetActive);
    ipcMain.removeListener(PlatformChannels.PetStateReport, onStateReport);
    ipcMain.removeListener(PlatformChannels.PetDragStart, onDragStart);
    ipcMain.removeHandler(PlatformChannels.PetDragEnd);
    ipcMain.removeListener(PlatformChannels.PetContextMenu, onContextMenu);
    ipcMain.removeListener(PlatformChannels.PetOpenApp, onOpenApp);
    ipcMain.removeHandler(PlatformChannels.PetListInstalled);
    ipcMain.removeHandler(PlatformChannels.PetSetActive);
  };
}