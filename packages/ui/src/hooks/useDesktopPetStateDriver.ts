import { useEffect, useRef } from "react";
import {
  DESKTOP_PET_SESSION_STATE_ORDER,
  desktopPetSessionStateToAnimation,
  type DesktopPetActivity,
  type DesktopPetSessionActivity,
  type DesktopPetSessionState,
} from "@zcode/shared";
import { usePlatform } from "./usePlatform.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

/**
 * 桌面宠物状态驱动（本地定制，specs/desktop/desktop-pet.md）。
 *
 * renderer 是会话活动（状态 + 气泡列表）的唯一生产者：订阅任务元数据缓存
 * （status + 未读覆盖 + sessions-index 的 phase/助手回复摘要），按优先级收敛后
 * 经平台端口上报；main 只做多窗口汇总、点击移除与跳转转发。
 * 桌面端之外（platform.desktopPet 缺失）整体不生效。
 */

type CacheState = ReturnType<typeof useTaskQueryCacheStore.getState>;
type TaskMeta = CacheState["taskMetaByEntityKey"][string];

/** main 侧 zod 校验上限；标题/摘要超长在这里截断，避免整条上报被丢弃。 */
const MAX_SESSION_TITLE_LENGTH = 200;
/** 与协议 lastAssistantPreview 的 120 字上限一致。 */
const MAX_SESSION_DETAIL_LENGTH = 120;
/** 气泡列表条数上限（与 main 侧展示预算一致）。 */
const MAX_BUBBLE_SESSIONS = 3;

/**
 * 会话条目状态：优先用 sessions-index 的 phase（能区分成功完成与中断），
 * 无 sidecar 时按任务 status + 未读推断。
 */
function resolveSessionState(
  task: TaskMeta,
  hasUnread: boolean,
): DesktopPetSessionState | undefined {
  const phase = getTaskListRowActivity(task)?.phase;
  if (phase === "running" || phase === "prewarming") {
    return "running";
  }
  if (phase === "completedInterrupted") {
    return "interrupted";
  }
  if (phase === "error") {
    return "failed";
  }
  if (phase === "completedSuccess") {
    return "completed";
  }
  if (task.status === "running") {
    return "running";
  }
  if (task.status === "error") {
    return "failed";
  }
  if (task.status === "completed") {
    return "completed";
  }
  return hasUnread ? "waiting" : undefined;
}

interface ActivityEntry {
  session: DesktopPetSessionActivity;
  rank: number;
  updatedAt: number;
}

/**
 * 活动收敛：动画状态由最高优先级条目推导；气泡列表收集运行中、未读，
 * 以及本窗口运行期间追踪过的完成/失败会话（tracked，指向用户"完成后保留"的诉求；
 * 点击跳转后由 main 移除）。同优先级按活动时间倒序，截断到 3 条。
 */
export function resolveDesktopPetActivity(
  cache: {
    taskMetaByEntityKey: CacheState["taskMetaByEntityKey"];
    taskUnreadOverlayByEntityKey: CacheState["taskUnreadOverlayByEntityKey"];
  },
  tracked: ReadonlySet<string> = new Set(),
): DesktopPetActivity {
  const entries: ActivityEntry[] = [];
  for (const [entityKey, task] of Object.entries(cache.taskMetaByEntityKey)) {
    // 覆盖层优先：null 表示已读（提交中的乐观清除）。
    const overlayUnread = cache.taskUnreadOverlayByEntityKey[entityKey];
    const unreadAt = overlayUnread !== undefined ? overlayUnread : task.unreadAt;
    const hasUnread = Boolean(unreadAt);
    const state = resolveSessionState(task, hasUnread);
    if (!state) {
      continue;
    }
    if (!hasUnread && state !== "running" && !tracked.has(task.taskId)) {
      continue;
    }
    const title = task.title?.trim().slice(0, MAX_SESSION_TITLE_LENGTH) ?? "";
    const detail =
      getTaskListRowActivity(task)?.assistantPreview?.trim().slice(0, MAX_SESSION_DETAIL_LENGTH) ||
      undefined;
    const updatedAt = typeof task.updatedAt === "number" ? task.updatedAt : 0;
    entries.push({
      session: {
        sessionId: task.taskId,
        title,
        state,
        ...(detail ? { detail } : {}),
      },
      rank: DESKTOP_PET_SESSION_STATE_ORDER.indexOf(state),
      updatedAt,
    });
  }
  entries.sort((left, right) => left.rank - right.rank || right.updatedAt - left.updatedAt);
  const sessions = entries.slice(0, MAX_BUBBLE_SESSIONS).map((entry) => entry.session);
  return {
    state: sessions[0] ? desktopPetSessionStateToAnimation(sessions[0].state) : "idle",
    sessions,
  };
}

export function useDesktopPetStateDriver(): void {
  const platform = usePlatform();
  // 本窗口运行期间见过 running 的会话：完成后保留在气泡里（绿灯/红灯），
  // 直到用户点击跳转（main 移除）；应用重启后集合清空。
  const trackedRef = useRef<Set<string>>(new Set());

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
      const tracked = trackedRef.current;
      for (const task of Object.values(state.taskMetaByEntityKey)) {
        if (task.status === "running") {
          tracked.add(task.taskId);
        }
      }
      publish(resolveDesktopPetActivity(state, tracked));
    };
    compute(useTaskQueryCacheStore.getState());
    const unsubscribe = useTaskQueryCacheStore.subscribe(compute);
    return () => {
      unsubscribe();
    };
  }, [platform]);
}
