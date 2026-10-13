import { useEffect } from "react";
import {
  DESKTOP_PET_STATE_PRIORITY,
  type DesktopPetActivity,
  type DesktopPetSessionActivity,
  type DesktopPetState,
} from "@zcode/shared";
import { usePlatform } from "./usePlatform.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

/**
 * 桌面宠物状态驱动（本地定制，specs/desktop/desktop-pet.md）。
 *
 * renderer 是会话活动（状态 + 气泡列表）的唯一生产者：订阅任务元数据缓存
 * （status + 未读覆盖 + sessions-index 的助手回复摘要），按优先级收敛后经平台端口上报；
 * main 只做多窗口汇总与转发。桌面端之外（platform.desktopPet 缺失）整体不生效。
 */

type CacheState = ReturnType<typeof useTaskQueryCacheStore.getState>;

/** main 侧 zod 校验上限；标题/摘要超长在这里截断，避免整条上报被丢弃。 */
const MAX_SESSION_TITLE_LENGTH = 200;
/** 与协议 lastAssistantPreview 的 120 字上限一致。 */
const MAX_SESSION_DETAIL_LENGTH = 120;
/** 气泡列表条数上限（与 main 侧展示预算一致）。 */
const MAX_BUBBLE_SESSIONS = 3;

const RUNNING_RANK = DESKTOP_PET_STATE_PRIORITY.indexOf("running");

interface ActivityEntry {
  session: DesktopPetSessionActivity;
  rank: number;
  updatedAt: number;
}

/**
 * 活动收敛：宠物动画取最高优先级状态；气泡列表收集全部"运行中 + 未读"会话，
 * running 优先、同优先级按活动时间倒序，截断到 3 条。
 * running 任务即使没有标题/摘要也入列；未读判定沿用未读覆盖层（null = 已读）。
 */
export function resolveDesktopPetActivity(cache: {
  taskMetaByEntityKey: CacheState["taskMetaByEntityKey"];
  taskUnreadOverlayByEntityKey: CacheState["taskUnreadOverlayByEntityKey"];
}): DesktopPetActivity {
  const entries: ActivityEntry[] = [];
  for (const [entityKey, task] of Object.entries(cache.taskMetaByEntityKey)) {
    const title = task.title?.trim().slice(0, MAX_SESSION_TITLE_LENGTH) ?? "";
    const detail =
      getTaskListRowActivity(task)?.assistantPreview?.trim().slice(0, MAX_SESSION_DETAIL_LENGTH) ||
      undefined;
    const updatedAt = typeof task.updatedAt === "number" ? task.updatedAt : 0;
    const buildSession = (state: DesktopPetState): DesktopPetSessionActivity => ({
      sessionId: task.taskId,
      title,
      state,
      ...(detail ? { detail } : {}),
    });
    if (task.status === "running") {
      entries.push({ session: buildSession("running"), rank: RUNNING_RANK, updatedAt });
      continue;
    }
    // 覆盖层优先：null 表示已读（提交中的乐观清除）。
    const overlayUnread = cache.taskUnreadOverlayByEntityKey[entityKey];
    const unreadAt = overlayUnread !== undefined ? overlayUnread : task.unreadAt;
    if (!unreadAt) {
      continue;
    }
    const state: DesktopPetState =
      task.status === "error" ? "failed" : task.status === "completed" ? "review" : "waiting";
    entries.push({ session: buildSession(state), rank: DESKTOP_PET_STATE_PRIORITY.indexOf(state), updatedAt });
  }
  entries.sort((left, right) => left.rank - right.rank || right.updatedAt - left.updatedAt);
  const sessions = entries.slice(0, MAX_BUBBLE_SESSIONS).map((entry) => entry.session);
  return { state: sessions[0]?.state ?? "idle", sessions };
}

export function useDesktopPetStateDriver(): void {
  const platform = usePlatform();

  useEffect(() => {
    const port = platform.desktopPet;
    if (!port) {
      return;
    }
    let last: string | undefined;
    const publish = (activity: DesktopPetActivity) => {
      const key = JSON.stringify(activity);
      if (key === last) {
        return;
      }
      last = key;
      port.reportActivity(activity);
    };
    const compute = (state: CacheState) => {
      publish(resolveDesktopPetActivity(state));
    };
    compute(useTaskQueryCacheStore.getState());
    const unsubscribe = useTaskQueryCacheStore.subscribe(compute);
    return () => {
      unsubscribe();
    };
  }, [platform]);
}
