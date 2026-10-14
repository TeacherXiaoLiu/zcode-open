import {
  DESKTOP_PET_SESSION_STATE_ORDER,
  desktopPetSessionStateToAnimation,
  type DesktopPetActivity,
  type DesktopPetSessionActivity,
} from "@zcode/shared";

/**
 * 多窗口活动归并（本地定制，specs/desktop/desktop-pet.md）。
 * 纯函数：合并各 reporter 的会话列表（按 sessionId 去重、过滤已处理条目），
 * 按条目状态优先级稳定排序并截断；动画状态由最高优先级条目推导。
 */
export function resolveEffectiveActivity(
  reported: Iterable<DesktopPetActivity>,
  dismissed: ReadonlySet<string>,
  maxSessions: number,
): DesktopPetActivity {
  const merged: DesktopPetSessionActivity[] = [];
  const seen = new Set<string>();
  for (const activity of reported) {
    for (const session of activity.sessions) {
      // 同 session 只保留先到的一条（renderer 侧已按优先级排序）。
      if (seen.has(session.sessionId)) {
        continue;
      }
      // 用户点过关闭按钮的会话从气泡移除；重新运行时会清除该标记。
      if (dismissed.has(session.sessionId)) {
        continue;
      }
      seen.add(session.sessionId);
      merged.push(session);
    }
  }
  // 稳定排序：renderer 已按 (优先级, 活动时间) 排好；这里只按优先级归并多窗口来源。
  merged.sort(
    (left, right) =>
      DESKTOP_PET_SESSION_STATE_ORDER.indexOf(left.state) -
      DESKTOP_PET_SESSION_STATE_ORDER.indexOf(right.state),
  );
  const sessions = merged.slice(0, maxSessions);
  return {
    state: sessions[0] ? desktopPetSessionStateToAnimation(sessions[0].state) : "idle",
    sessions,
  };
}
