import { describe, expect, it } from "vitest";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

describe("app settings", () => {
  it("round-trips every structured Provider Family connection selection", () => {
    const selections = {
      zai: { kind: "individual-coding-plan" },
      bigmodel: {
        kind: "team-coding-plan",
        productId: "product-1",
        organizationId: "org-1",
        projectId: "project-1",
      },
    } as const;

    expect(
      appSettingsSchema.parse({ providerFamilyConnectionSelections: selections })
        .providerFamilyConnectionSelections,
    ).toEqual(selections);
    expect(
      appSettingsPatchSchema.parse({ providerFamilyConnectionSelections: selections })
        .providerFamilyConnectionSelections,
    ).toEqual(selections);
    expect(
      appSettingsPatchSchema.safeParse({
        providerFamilyConnectionSelections: {
          zai: { kind: "team-coding-plan", productId: "p", organizationId: "o" },
        },
      }).success,
    ).toBe(false);
  });

  it("defaults and validates the human embedded Browser viewport preference", () => {
    expect(appSettingsSchema.parse({}).embeddedBrowserViewportPreference).toEqual({
      mode: "normal",
      viewport: { width: 393, height: 852 },
      zoom: "fit",
    });

    const preference = {
      mode: "responsive",
      viewport: { width: 412, height: 915 },
      zoom: "50",
    } as const;
    expect(
      appSettingsSchema.parse({ embeddedBrowserViewportPreference: preference })
        .embeddedBrowserViewportPreference,
    ).toEqual(preference);
    expect(
      appSettingsPatchSchema.parse({ embeddedBrowserViewportPreference: preference })
        .embeddedBrowserViewportPreference,
    ).toEqual(preference);

    for (const embeddedBrowserViewportPreference of [
      { ...preference, mode: "agent" },
      { ...preference, viewport: { width: 319, height: 915 } },
      { ...preference, viewport: { width: 412, height: 2161 } },
      { ...preference, zoom: "80" },
    ]) {
      expect(appSettingsPatchSchema.safeParse({ embeddedBrowserViewportPreference }).success).toBe(
        false,
      );
    }
  });

  it("drops only a damaged human Browser preference from stored settings", () => {
    const settings = appSettingsSchema.parse({
      locale: "en-US",
      recentProjects: ["/workspace/demo"],
      embeddedBrowserViewportPreference: {
        mode: "responsive",
        viewport: { width: "bad", height: 915 },
        zoom: "50",
      },
    });

    expect(settings.locale).toBe("en-US");
    expect(settings.recentProjects).toEqual(["/workspace/demo"]);
    expect(settings.embeddedBrowserViewportPreference).toEqual({
      mode: "normal",
      viewport: { width: 393, height: 852 },
      zoom: "fit",
    });
  });

  it("defaults ModelIO full retention to off and validates explicit boolean patches", () => {
    expect(appSettingsSchema.parse({}).modelIoFullRetentionEnabled).toBe(false);
    expect(
      appSettingsSchema.parse({ modelIoFullRetentionEnabled: true }).modelIoFullRetentionEnabled,
    ).toBe(true);
    expect(
      appSettingsPatchSchema.parse({ modelIoFullRetentionEnabled: false })
        .modelIoFullRetentionEnabled,
    ).toBe(false);
    expect(appSettingsPatchSchema.safeParse({ modelIoFullRetentionEnabled: "true" }).success).toBe(
      false,
    );
  });

  it("drops the removed CUA overlay/pip/background settings keys from stored configs", () => {
    // 2026-08-17 设置面收敛：三个 key 已从 schema 删除；存量配置里的旧值被 zod strip 静默忽略，
    // 不报错也不回流（overlay/PiP 由 services 装配层恒传 true，见 cuaGhostCursorSettingsWiring）。
    const stale = appSettingsSchema.parse({
      cuaGhostCursorEnabled: false,
      cuaPipMode: false,
      cuaBackgroundMode: true,
    });
    expect("cuaGhostCursorEnabled" in stale).toBe(false);
    expect("cuaPipMode" in stale).toBe(false);
    expect("cuaBackgroundMode" in stale).toBe(false);
    expect(appSettingsPatchSchema.parse({ cuaPipMode: true })).toEqual({});
  });

  it("persists an explicit Windows integrated terminal shell selection", () => {
    const selection = {
      mode: "shell",
      dialect: "git-bash",
      id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
      label: "Git Bash",
      path: "C:\\Program Files\\Git\\bin\\bash.exe",
    } as const;

    expect(
      appSettingsSchema.parse({ integratedTerminalShell: selection }).integratedTerminalShell,
    ).toEqual(selection);
    expect(
      appSettingsPatchSchema.parse({ integratedTerminalShell: selection }).integratedTerminalShell,
    ).toEqual(selection);
  });

  it("accepts auto mode and rejects incomplete shell selections", () => {
    expect(
      appSettingsPatchSchema.parse({ integratedTerminalShell: { mode: "auto" } })
        .integratedTerminalShell,
    ).toEqual({ mode: "auto" });

    expect(() =>
      appSettingsPatchSchema.parse({
        integratedTerminalShell: {
          mode: "shell",
          dialect: "git-bash",
          id: "git-bash",
          label: "Git Bash",
        },
      }),
    ).toThrow();
  });

  it("accepts desktop zoom levels within the supported window range", () => {
    expect(appSettingsSchema.parse({ desktopZoomLevel: 5 }).desktopZoomLevel).toBe(5);
    expect(appSettingsPatchSchema.parse({ desktopZoomLevel: -3 }).desktopZoomLevel).toBe(-3);

    expect(() => appSettingsSchema.parse({ desktopZoomLevel: 6 })).toThrow();
    expect(() => appSettingsPatchSchema.parse({ desktopZoomLevel: -4 })).toThrow();
  });

  it("accepts a bounded desktop main window size and maximized state", () => {
    const desktopWindowSize = { width: 1440, height: 900, maximized: true };

    expect(appSettingsSchema.parse({ desktopWindowSize }).desktopWindowSize).toEqual(
      desktopWindowSize,
    );
    expect(appSettingsPatchSchema.parse({ desktopWindowSize }).desktopWindowSize).toEqual(
      desktopWindowSize,
    );
    expect(() =>
      appSettingsPatchSchema.parse({
        desktopWindowSize: { width: 479, height: 900, maximized: false },
      }),
    ).toThrow();
    expect(
      appSettingsSchema.parse({
        desktopWindowSize: { width: 1440, height: 639, maximized: false },
      }).desktopWindowSize,
    ).toBeUndefined();
  });

  it("discards a damaged desktop window size without resetting other settings", () => {
    const settings = appSettingsSchema.parse({
      locale: "en-US",
      recentProjects: ["/workspace/demo"],
      desktopWindowSize: { width: "bad", height: 900, maximized: false },
    });

    expect(settings.locale).toBe("en-US");
    expect(settings.recentProjects).toEqual(["/workspace/demo"]);
    expect(settings.desktopWindowSize).toBeUndefined();
  });

  it("defaults desktop Chromium hardware acceleration to enabled and accepts explicit patches", () => {
    expect(appSettingsSchema.parse({}).desktopChromiumHardwareAccelerationEnabled).toBe(true);
    expect(
      appSettingsSchema.parse({
        desktopChromiumHardwareAccelerationEnabled: false,
      }).desktopChromiumHardwareAccelerationEnabled,
    ).toBe(false);
    expect(
      appSettingsPatchSchema.parse({
        desktopChromiumHardwareAccelerationEnabled: true,
      }).desktopChromiumHardwareAccelerationEnabled,
    ).toBe(true);
    expect(() =>
      appSettingsPatchSchema.parse({
        desktopChromiumHardwareAccelerationEnabled: "false",
      }),
    ).toThrow();
  });

  it("preserves localized pending post-update release notes", () => {
    const payload = {
      version: "3.1.4",
      title: "Release v3.1.4",
      markdown: "## 新功能\n- 中文说明",
      releaseDate: "2026-06-23T13:48:54.438Z",
      releaseNotesByLocale: {
        "zh-CN": {
          title: "ZCode v3.1.4",
          markdown: "## 新功能\n- 中文说明",
        },
        "en-US": {
          title: "ZCode v3.1.4",
          markdown: "## New Features\n- English notes",
        },
      },
    };

    expect(
      appSettingsSchema.parse({ pendingPostUpdateReleaseNotes: payload })
        .pendingPostUpdateReleaseNotes,
    ).toEqual(payload);
    expect(
      appSettingsPatchSchema.parse({ pendingPostUpdateReleaseNotes: payload })
        .pendingPostUpdateReleaseNotes,
    ).toEqual(payload);
  });

  it("persists only stable Web remote control startup context fields", () => {
    const context = {
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      initialTaskId: "task-1",
    };

    expect(
      appSettingsSchema.parse({ webRemoteControlLastEnabledContext: context })
        .webRemoteControlLastEnabledContext,
    ).toEqual(context);
    expect(
      appSettingsPatchSchema.parse({ webRemoteControlLastEnabledContext: context })
        .webRemoteControlLastEnabledContext,
    ).toEqual(context);
    expect(
      appSettingsPatchSchema.parse({
        webRemoteControlLastEnabledContext: {
          ...context,
          remoteSessionId: "ephemeral-session",
        },
      }).webRemoteControlLastEnabledContext,
    ).toEqual(context);
  });
});

// DWG-19（docs/dynamic-workflow/launch.md「The user's choice」）：空串是删除选择的哨兵，
// 读文件时的未知取值按「跟随」处理，不能把整份设置读坏。
describe("dynamicWorkflowMode 设置（DWG-19）", () => {
  it("补丁接受三个模式与空串哨兵，拒绝其它值", () => {
    for (const value of ["disabled", "onDemand", "alwaysOn", ""]) {
      expect(appSettingsPatchSchema.parse({ dynamicWorkflowMode: value })).toEqual({
        dynamicWorkflowMode: value,
      });
    }
    expect(appSettingsPatchSchema.safeParse({ dynamicWorkflowMode: "bogus" }).success).toBe(false);
  });

  it("文件里的合法值原样读出，缺席保持缺席，未知值按跟随读成缺席", () => {
    expect(appSettingsSchema.parse({ dynamicWorkflowMode: "onDemand" }).dynamicWorkflowMode).toBe(
      "onDemand",
    );
    expect(appSettingsSchema.parse({}).dynamicWorkflowMode).toBeUndefined();
    expect(appSettingsSchema.parse({ dynamicWorkflowMode: "future" }).dynamicWorkflowMode).toBe(
      undefined,
    );
  });
});

// 定制（本地分支）：会话标题自动刷新（specs/session-title-auto-refresh.md）。
// 平铺三字段：浅合并语义下部分 patch 只改提交字段，不会重置其余值（由结构保证）。
describe("sessionTitleRefresh 设置（本地定制）", () => {
  it("默认档与 core DEFAULT_SESSION_TITLE_REFRESH 对齐（启用 / 3 / 5）", () => {
    const settings = appSettingsSchema.parse({});
    expect(settings.sessionTitleRefreshEnabled).toBe(true);
    expect(settings.sessionTitleRefreshFirstRound).toBe(3);
    expect(settings.sessionTitleRefreshInterval).toBe(5);
  });

  it("补丁只包含提交字段；边界 1-50 / 1-100 外的值被拒绝", () => {
    expect(appSettingsPatchSchema.parse({ sessionTitleRefreshInterval: 10 })).toEqual({
      sessionTitleRefreshInterval: 10,
    });
    for (const patch of [
      { sessionTitleRefreshFirstRound: 0 },
      { sessionTitleRefreshFirstRound: 51 },
      { sessionTitleRefreshInterval: 0 },
      { sessionTitleRefreshInterval: 101 },
    ]) {
      expect(appSettingsPatchSchema.safeParse(patch).success).toBe(false);
    }
  });

  it("旧设置文件缺字段时读成默认档，其余字段不受影响", () => {
    const settings = appSettingsSchema.parse({
      locale: "en-US",
      recentProjects: ["/workspace/demo"],
    });
    expect(settings.locale).toBe("en-US");
    expect(settings.recentProjects).toEqual(["/workspace/demo"]);
    expect(settings.sessionTitleRefreshEnabled).toBe(true);
    expect(settings.sessionTitleRefreshFirstRound).toBe(3);
    expect(settings.sessionTitleRefreshInterval).toBe(5);
  });

  it("标题生成模型：缺席/null = 跟随会话当前模型，补丁可单独替换", () => {
    expect(appSettingsSchema.parse({}).sessionTitleModelSelection).toBeUndefined();
    expect(
      appSettingsSchema.parse({ sessionTitleModelSelection: null }).sessionTitleModelSelection,
    ).toBeNull();
    const modelSelection = {
      providerId: "opencode-go-responses",
      modelId: "muse-spark-1.3-contributor",
    };
    // 单字段提交：patch 只包含该字段，浅合并不会重置其余刷新参数。
    expect(appSettingsPatchSchema.parse({ sessionTitleModelSelection: modelSelection })).toEqual({
      sessionTitleModelSelection: modelSelection,
    });
    expect(appSettingsPatchSchema.parse({ sessionTitleModelSelection: null })).toEqual({
      sessionTitleModelSelection: null,
    });
    // 结构非法的选择在设置边界被拒绝（strict 模型选择 schema）。
    expect(
      appSettingsPatchSchema.safeParse({ sessionTitleModelSelection: { providerId: "" } }).success,
    ).toBe(false);
  });
});
