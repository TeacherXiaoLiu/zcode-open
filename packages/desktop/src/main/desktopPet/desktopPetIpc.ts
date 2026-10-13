import { ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { PlatformChannels, type DesktopPetOperationProgress } from "@zcode/shared";
import type { DesktopPetController } from "./desktopPetController.js";
import type { DesktopPetLibrary } from "./desktopPetLibrary.js";
import { petIdSchema } from "./desktopPetPackage.js";

/** 会话活动上报（三期）：动画状态 + 气泡会话列表；标题/摘要截断上限对齐任务标题与 preview 量级。 */
const sessionStateSchema = z.enum(["running", "completed", "interrupted", "failed", "waiting"]);
const sessionActivitySchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    title: z.string().max(200),
    state: sessionStateSchema,
    detail: z.string().max(200).optional(),
  })
  .strict();
const activitySchema = z
  .object({
    state: z.enum(["idle", "running", "waiting", "failed", "review"]),
    sessions: z.array(sessionActivitySchema).max(5),
  })
  .strict();

const marketQuerySchema = z
  .object({
    query: z.string().max(256).optional(),
    category: z.string().max(128).optional(),
    cursor: z
      .string()
      .regex(/^\d{1,8}$/)
      .optional(),
    limit: z.number().int().min(1).max(24).optional(),
    refresh: z.boolean().optional(),
  })
  .strict();
const sourceSchema = z
  .object({ source: z.enum(["codex", "zcode", "mikiko", "directory", "archive"]) })
  .strict();
const operationIdSchema = z.string().uuid();
/** 气泡点击跳转的会话 ID（taskId/sessionId）。 */
const sessionIdSchema = z.string().min(1).max(128);
const importSchema = z
  .object({
    operationId: operationIdSchema,
    reviewId: z.string().uuid(),
    petIds: z.array(petIdSchema).min(1).max(200),
    replacePetIds: z.array(petIdSchema).max(200).optional(),
  })
  .strict();
const installSchema = z
  .object({
    operationId: operationIdSchema,
    petId: petIdSchema,
    replaceExisting: z.boolean().optional(),
  })
  .strict();
const deleteSchema = z.object({ operationId: operationIdSchema, petId: petIdSchema }).strict();

/** 窗口身份与载荷均在 main 校验；review/取消权归发起窗口，不接受 renderer 提供任意路径或 URL。 */
export function registerDesktopPetIpc(options: {
  controller: DesktopPetController;
  library: DesktopPetLibrary;
  isApplicationSender: (id: number) => boolean;
}): () => void {
  const { controller, library } = options;
  const managedHandlers: string[] = [];
  function assertApplication(event: IpcMainInvokeEvent | IpcMainEvent) {
    if (!options.isApplicationSender(event.sender.id))
      throw new Error("INVALID_SOURCE: 当前窗口无权管理桌宠");
  }
  function assertPet(event: IpcMainInvokeEvent | IpcMainEvent) {
    if (event.sender.isDestroyed() || !controller.ownsWebContents(event.sender.id))
      throw new Error("INVALID_SOURCE: 当前窗口不是桌宠窗口");
  }
  function assertBubble(event: IpcMainInvokeEvent | IpcMainEvent) {
    if (event.sender.isDestroyed() || !controller.ownsBubbleWebContents(event.sender.id))
      throw new Error("INVALID_SOURCE: 当前窗口不是桌宠气泡窗口");
  }
  function handle(
    channel: string,
    handler: (event: IpcMainInvokeEvent, payload: unknown) => unknown,
  ) {
    ipcMain.handle(channel, handler);
    managedHandlers.push(channel);
  }
  function report(event: IpcMainInvokeEvent) {
    return (progress: DesktopPetOperationProgress) => {
      if (!event.sender.isDestroyed())
        event.sender.send(PlatformChannels.PetOperationProgress, progress);
    };
  }

  handle(PlatformChannels.PetGetActive, (event) => {
    assertPet(event);
    return controller.getActivePayload();
  });
  handle(PlatformChannels.PetGetActivity, (event) => {
    assertBubble(event);
    return controller.getBubblePayload();
  });
  const onStateReport = (event: IpcMainEvent, payload: unknown) => {
    const parsed = activitySchema.safeParse(payload);
    if (!options.isApplicationSender(event.sender.id) || !parsed.success) return;
    controller.reportActivity(parsed.data, event.sender.id);
  };
  const onDragStart = (event: IpcMainEvent) => {
    if (controller.ownsWebContents(event.sender.id)) controller.startDrag();
  };
  const onContextMenu = (event: IpcMainEvent) => {
    if (controller.ownsWebContents(event.sender.id)) controller.showContextMenu();
  };
  const onOpenApp = (event: IpcMainEvent) => {
    if (controller.ownsWebContents(event.sender.id)) controller.openMainWindow();
  };
  const onCancel = (event: IpcMainEvent, payload: unknown) => {
    if (
      options.isApplicationSender(event.sender.id) &&
      operationIdSchema.safeParse(payload).success
    )
      library.cancelOperation(payload as string, event.sender.id);
  };
  const onBubbleOpenSession = (event: IpcMainEvent, payload: unknown) => {
    if (event.sender.isDestroyed() || !controller.ownsBubbleWebContents(event.sender.id)) return;
    const parsed = sessionIdSchema.safeParse(payload);
    if (parsed.success) controller.openSession(parsed.data);
  };
  ipcMain.on(PlatformChannels.PetStateReport, onStateReport);
  ipcMain.on(PlatformChannels.PetDragStart, onDragStart);
  ipcMain.on(PlatformChannels.PetContextMenu, onContextMenu);
  ipcMain.on(PlatformChannels.PetOpenApp, onOpenApp);
  ipcMain.on(PlatformChannels.PetCancelOperation, onCancel);
  ipcMain.on(PlatformChannels.PetBubbleOpenSession, onBubbleOpenSession);
  handle(PlatformChannels.PetDragEnd, (event) => {
    assertPet(event);
    return controller.endDrag();
  });

  handle(PlatformChannels.PetListInstalled, (event) => {
    assertApplication(event);
    return library.listInstalled();
  });
  handle(PlatformChannels.PetListMarket, (event, payload) => {
    assertApplication(event);
    return library.listMarket(marketQuerySchema.parse(payload ?? {}));
  });
  handle(PlatformChannels.PetPrepareImport, (event, payload) => {
    assertApplication(event);
    return library.prepareImport(sourceSchema.parse(payload).source, event.sender.id);
  });
  handle(PlatformChannels.PetInstallImport, (event, payload) => {
    assertApplication(event);
    return library.installImport({
      ...importSchema.parse(payload),
      ownerId: event.sender.id,
      reportProgress: report(event),
    });
  });
  handle(PlatformChannels.PetInstallMarket, (event, payload) => {
    assertApplication(event);
    return library.installMarketPet({
      ...installSchema.parse(payload),
      ownerId: event.sender.id,
      reportProgress: report(event),
    });
  });
  handle(PlatformChannels.PetDeleteInstalled, (event, payload) => {
    assertApplication(event);
    return library.deleteInstalled({
      ...deleteSchema.parse(payload),
      ownerId: event.sender.id,
      reportProgress: report(event),
    });
  });
  handle(PlatformChannels.PetSetActive, (event, payload) => {
    assertApplication(event);
    const id = petIdSchema.parse(payload);
    return library.setActive(id, () => controller.switchActivePet(id));
  });

  return () => {
    for (const channel of managedHandlers) ipcMain.removeHandler(channel);
    ipcMain.removeListener(PlatformChannels.PetStateReport, onStateReport);
    ipcMain.removeListener(PlatformChannels.PetDragStart, onDragStart);
    ipcMain.removeListener(PlatformChannels.PetContextMenu, onContextMenu);
    ipcMain.removeListener(PlatformChannels.PetOpenApp, onOpenApp);
    ipcMain.removeListener(PlatformChannels.PetCancelOperation, onCancel);
    ipcMain.removeListener(PlatformChannels.PetBubbleOpenSession, onBubbleOpenSession);
  };
}
