import { useEffect } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { usePlatform } from "./usePlatform.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";

/**
 * 桌宠汇报气泡点击 → main 转发 → 打开对应会话（本地定制，specs/desktop/desktop-pet.md）。
 * 通过注入的 openTask 复用主窗口既有的任务导航（含跨 workspace tab 切换与未读清理），
 * 不新增第二套跳转路径。
 */
export function useDesktopPetSessionOpener(
  openTask: (params: {
    workspacePath: string;
    taskId: string;
    workspaceIdentity?: string;
  }) => void,
): void {
  const platform = usePlatform();
  useEffect(() => {
    const port = platform.desktopPet;
    if (!port?.onOpenSession) {
      return;
    }
    return port.onOpenSession((sessionId) => {
      // 会话可能属于任意 workspace：先从任务元数据缓存反查归属，再交给导航层切换。
      const task: ZCodeTaskMeta | undefined = Object.values(
        useTaskQueryCacheStore.getState().taskMetaByEntityKey,
      ).find((candidate) => candidate.taskId === sessionId);
      if (!task) {
        return;
      }
      openTask({
        workspacePath: task.workspacePath,
        taskId: sessionId,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      });
    });
  }, [platform, openTask]);
}
