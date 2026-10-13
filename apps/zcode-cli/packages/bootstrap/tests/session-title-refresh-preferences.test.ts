import { describe, expect, it, vi } from "vitest";
import { zcodeWorkspaceUpdateSessionTitleRefreshPreferencesResultSchema } from "@zcode/shared";
import { updateSessionTitleRefreshPreferences } from "../src/zcode-protocol/session-title-refresh-preferences.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

const workspace = {
  workspacePath: "/workspace/app",
  workspaceKey: "/workspace/app",
};

// 定制（本地分支）：会话标题自动刷新参数热更新（specs/session-title-auto-refresh.md「设置与热更新链路」）。
describe("session title refresh runtime preferences", () => {
  it("applies the config to resident apps and caches it for future apps", async () => {
    const setSessionTitleRefreshConfig = vi.fn();
    const context = {
      appRuntimePreferences: {
        askUserQuestionAutoResolutionEnabled: true,
        modelIoFullRetentionEnabled: false,
        offPeakToolEnabled: false,
      },
      sessions: new Map([
        [
          "sess_title_refresh",
          {
            app: createFakeApp(undefined, { setSessionTitleRefreshConfig }),
          },
        ],
      ]),
    } as unknown as ZCodeProtocolAgentServerContext;

    const result = zcodeWorkspaceUpdateSessionTitleRefreshPreferencesResultSchema.parse(
      await updateSessionTitleRefreshPreferences(context, {
        workspace,
        preferences: { enabled: false, firstRound: 10, interval: 20 },
      }),
    );

    expect(result).toEqual({
      workspace,
      enabled: false,
      firstRound: 10,
      interval: 20,
      updatedSessionCount: 1,
    });
    expect(context.appRuntimePreferences.sessionTitleRefresh).toEqual({
      enabled: false,
      firstRound: 10,
      interval: 20,
    });
    expect(setSessionTitleRefreshConfig).toHaveBeenCalledWith({
      enabled: false,
      firstRound: 10,
      interval: 20,
    });
  });

  it("rejects out-of-bounds values at the protocol boundary", async () => {
    await expect(
      updateSessionTitleRefreshPreferences({} as ZCodeProtocolAgentServerContext, {
        workspace,
        preferences: { enabled: true, firstRound: 51, interval: 5 },
      }),
    ).rejects.toThrow();
  });
});