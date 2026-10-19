// @vitest-environment jsdom
// 本地定制 specs/session-title-auto-refresh.md「标题生成模型（可选指定）」：
// 设置卡的「标题生成模型」为文本输入（provider/model 或 provider/model$档位）——
// 留空提交 null（跟随会话当前模型），解析失败不提交且只做行内提示。
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTitleRefreshSetting } from "@/settings/SessionTitleRefreshSetting.js";

const mocks = vi.hoisted(() => ({
  update: vi.fn(async (_patch: unknown) => undefined),
  toast: vi.fn(),
  settings: {} as Record<string, unknown>,
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: mocks.settings, update: mocks.update }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
// 行容器只验证 label/description/control/detail 的装配，不把设置页的重型依赖（shiki 等）带进 jsdom。
vi.mock("@/settings/SettingsPageParts.js", () => ({
  SettingsRow: ({
    label,
    description,
    control,
    detail,
  }: {
    label: ReactNode;
    description?: ReactNode;
    control: ReactNode;
    detail?: ReactNode;
  }) =>
    createElement(
      "div",
      {},
      createElement("span", {}, label),
      description ? createElement("span", {}, description) : null,
      control,
      detail ?? null,
    ),
  SettingsCommitOnReleaseRange: () => createElement("input", { type: "range" }),
}));

async function commit(value: string) {
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value } });
  await act(async () => {
    fireEvent.blur(input);
  });
}

describe("SessionTitleRefreshSetting 标题生成模型（本地定制）", () => {
  beforeEach(() => {
    mocks.update.mockReset();
    mocks.update.mockResolvedValue(undefined);
    mocks.toast.mockReset();
    mocks.settings = {};
  });
  afterEach(cleanup);

  it("已保存的模型回填为可编辑文本；留空提交 null（跟随会话当前模型）", async () => {
    mocks.settings = {
      sessionTitleModelSelection: { providerId: "opencode-go-responses", modelId: "muse-spark" },
    };
    render(createElement(SessionTitleRefreshSetting));
    expect(screen.getByRole("textbox")).toHaveProperty(
      "value",
      "opencode-go-responses/muse-spark",
    );

    await commit("");
    expect(mocks.update).toHaveBeenCalledWith({ sessionTitleModelSelection: null });
  });

  it("合法的 provider/model$档位解析为 ModelSelection 后提交", async () => {
    render(createElement(SessionTitleRefreshSetting));

    await commit("opencode-go-responses/muse-spark-1.3-contributor$high");
    expect(mocks.update).toHaveBeenCalledWith({
      sessionTitleModelSelection: {
        providerId: "opencode-go-responses",
        modelId: "muse-spark-1.3-contributor",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("解析失败不提交，只在行内显示错误提示（不弹 toast）", async () => {
    render(createElement(SessionTitleRefreshSetting));

    await commit("no-slash");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(screen.getByText("settings.sessionTitleRefresh.modelInvalid")).toBeTruthy();
  });

  it("回车与失焦共用同一次提交（只发一次保存请求）", async () => {
    render(createElement(SessionTitleRefreshSetting));
    const input = screen.getByRole("textbox");
    input.focus();
    fireEvent.change(input, { target: { value: "glm/glm-4.6" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update).toHaveBeenCalledWith({
      sessionTitleModelSelection: { providerId: "glm", modelId: "glm-4.6" },
    });
  });

  it("保存失败：回滚草稿到已保存值并按既有模式 toast", async () => {
    mocks.settings = { sessionTitleModelSelection: { providerId: "glm", modelId: "glm-4.6" } };
    mocks.update.mockRejectedValueOnce(new Error("disk full"));
    render(createElement(SessionTitleRefreshSetting));

    await commit("other/model");
    expect(mocks.update).toHaveBeenCalledWith({
      sessionTitleModelSelection: { providerId: "other", modelId: "model" },
    });
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("settings.sessionTitleRefresh.saveError"),
    );
    // 草稿被丢弃，界面回到已保存值。
    expect(screen.getByRole("textbox")).toHaveProperty("value", "glm/glm-4.6");
  });
});
