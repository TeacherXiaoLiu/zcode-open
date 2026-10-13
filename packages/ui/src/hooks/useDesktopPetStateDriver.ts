import { useEffect } from "react";
import type { DesktopPetState } from "@zcode/shared";
import { usePlatform } from "./usePlatform.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";

/**
 * 桌面宠物状态驱动（本地定制，specs/desktop/desktop-pet.md）。
 *
 * renderer 是会话聚合状态的唯一生产者：订阅任务元数据缓存（status + 未读覆盖），
 * 按优先级收敛成宠物状态后经平台端口上报；main 只做多窗口汇总与转发。
 * 桌面端之外（platform.desktopPet 缺失）整体不生效。
 */

type CacheState = ReturnType<typeof useTaskQueryCacheStore.getState>;

/** 状态收敛（与 spec 映射表一一对应；顺序即优先级）。 */
export function resolveDesktopPetState(state: {
  taskMetaByEntityKey: CacheState["taskMetaByEntityKey"];
  taskUnreadOverlayByEntityKey: CacheState["taskUnreadOverlayByEntityKey"];
}): DesktopPetState {
  let hasRunning = false;
  let hasErrorUnread = false;
  let hasCompletedUnread = false;
  let hasOtherUnread = false;
  for (const [entityKey, task] of Object.entries(state.taskMetaByEntityKey)) {
    if (task.status === "running") {
      hasRunning = true;
      continue;
    }
    // 覆盖层优先：null 表示已读（提交中的乐观清除）。
    const overlayUnread = state.taskUnreadOverlayByEntityKey[entityKey];
    const unreadAt = overlayUnread !== undefined ? overlayUnread : task.unreadAt;
    if (!unreadAt) {
      continue;
    }
    if (task.status === "error") {
      hasErrorUnread = true;
    } else if (task.status === "completed") {
      hasCompletedUnread = true;
    } else {
      hasOtherUnread = true;
    }
  }
  if (hasRunning) return "running";
  if (hasErrorUnread) return "failed";
  if (hasCompletedUnread) return "review";
  if (hasOtherUnread) return "waiting";
  return "idle";
}

export function useDesktopPetStateDriver(): void {
  const platform = usePlatform();

  useEffect(() => {
    const port = platform.desktopPet;
    if (!port) {
      return;
    }
    let last: DesktopPetState | undefined;
    const publish = (state: DesktopPetState) => {
      if (state === last) {
        return;
      }
      last = state;
      port.reportState(state);
    };
    const compute = (state: CacheState) => {
      publish(resolveDesktopPetState(state));
    };
    compute(useTaskQueryCacheStore.getState());
    const unsubscribe = useTaskQueryCacheStore.subscribe(compute);
    return () => {
      unsubscribe();
    };
  }, [platform]);
}