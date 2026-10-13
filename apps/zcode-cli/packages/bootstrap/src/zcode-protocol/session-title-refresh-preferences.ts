import { zcodeWorkspaceUpdateSessionTitleRefreshPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 会话标题自动刷新参数（本地定制，specs/session-title-auto-refresh.md）是 App 全局偏好，
 * 但每个 resident session 的 runtime 持有独立调度属性。协议层同时缓存偏好供未来
 * session 继承，并立即更新已有 session，避免新旧任务行为分裂。
 * 热更新只改调度参数、不触发补跑：下一轮完成时的触发判断自然读到新值。
 */
export async function updateSessionTitleRefreshPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(
    zcodeWorkspaceUpdateSessionTitleRefreshPreferencesParamsSchema,
    rawParams,
  );
  const config = params.preferences;
  context.appRuntimePreferences.sessionTitleRefresh = { ...config };

  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    if (!record.app.setSessionTitleRefreshConfig) continue;
    record.app.setSessionTitleRefreshConfig({ ...config });
    updatedSessionCount += 1;
  }

  return {
    workspace: params.workspace,
    enabled: config.enabled,
    firstRound: config.firstRound,
    interval: config.interval,
    updatedSessionCount,
  };
}