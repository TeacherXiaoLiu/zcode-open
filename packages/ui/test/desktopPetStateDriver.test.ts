import { describe, expect, it } from "vitest";
import { resolveDesktopPetActivity } from "../src/hooks/useDesktopPetStateDriver.js";

/** 桌面宠物活动收敛（本地定制，specs/desktop/desktop-pet.md 状态映射表 + 气泡列表）。 */

type TaskMeta = {
  status?: "running" | "completed" | "error";
  unreadAt?: number;
  title?: string;
  updatedAt?: number;
  __zcodeSessionActivity?: { phase?: string; assistantPreview?: string };
};

function resolve(
  tasks: Record<string, TaskMeta>,
  options: { overlay?: Record<string, number | null>; tracked?: string[] } = {},
): {
  state: string;
  sessions: Array<{ sessionId: string; title: string; state: string; detail?: string }>;
} {
  // 收敛函数只消费这几个字段；这里用最小形状驱动（类型由 hook 内部保证）。
  // entityKey 即任务行身份，补成 taskId 让会话 ID 断言可读。
  const withTaskIds = Object.fromEntries(
    Object.entries(tasks).map(([key, task]) => [key, { taskId: key, ...task }]),
  );
  return resolveDesktopPetActivity(
    {
      taskMetaByEntityKey: withTaskIds as never,
      taskUnreadOverlayByEntityKey: (options.overlay ?? {}) as never,
    },
    new Set(options.tracked ?? []),
  );
}

describe("resolveDesktopPetActivity", () => {
  it("无任务 / 无未读 → idle 且气泡为空", () => {
    expect(resolve({})).toEqual({ state: "idle", sessions: [] });
    expect(resolve({ a: { status: "completed" } })).toEqual({ state: "idle", sessions: [] });
  });

  it("多个运行中会话全部列出（同优先级按活动时间倒序），并带出助手摘要", () => {
    const result = resolve({
      a: {
        status: "running",
        title: "会话甲",
        updatedAt: 10,
        __zcodeSessionActivity: { assistantPreview: "甲的最新回复" },
      },
      b: {
        status: "running",
        title: "会话乙",
        updatedAt: 20,
        __zcodeSessionActivity: { assistantPreview: "乙的最新回复" },
      },
    });
    expect(result.state).toBe("running");
    expect(result.sessions).toEqual([
      { sessionId: "b", title: "会话乙", state: "running", detail: "乙的最新回复" },
      { sessionId: "a", title: "会话甲", state: "running", detail: "甲的最新回复" },
    ]);
  });

  it("phase 区分完成与中断：completedSuccess → completed，completedInterrupted → interrupted", () => {
    const result = resolve({
      a: {
        status: "completed",
        unreadAt: 1,
        title: "成功完成",
        __zcodeSessionActivity: { phase: "completedSuccess" },
      },
      b: {
        status: "completed",
        unreadAt: 1,
        title: "被中断",
        __zcodeSessionActivity: { phase: "completedInterrupted" },
      },
    });
    // 中断优先于完成排前；动画取最高优先级（failed）。
    expect(result.sessions.map((s) => s.state)).toEqual(["interrupted", "completed"]);
    expect(result.state).toBe("failed");
  });

  it("error → failed（红）；完成未读 → completed（绿）", () => {
    expect(resolve({ a: { status: "error", unreadAt: 1, title: "E" } })).toMatchObject({
      state: "failed",
      sessions: [{ sessionId: "a", title: "E", state: "failed" }],
    });
    expect(resolve({ a: { status: "completed", unreadAt: 1, title: "C" } })).toMatchObject({
      state: "review",
      sessions: [{ sessionId: "a", title: "C", state: "completed" }],
    });
  });

  it("tracked 保留：本窗口跑过的会话完成后仍显示（即使已读）", () => {
    const tasks = {
      a: { status: "completed", title: "跑过的会话", updatedAt: 5 },
      b: { status: "completed", title: "历史会话", updatedAt: 5 },
    };
    // 未 tracked：都不显示。
    expect(resolve(tasks).sessions).toEqual([]);
    // tracked 的显示，未 tracked 的不显示。
    expect(resolve(tasks, { tracked: ["a"] }).sessions).toEqual([
      { sessionId: "a", title: "跑过的会话", state: "completed" },
    ]);
  });

  it("覆盖层：null 清读移除未读；tracked 的完成条目不受覆盖层影响", () => {
    const tasks = { a: { status: "completed", unreadAt: 1, title: "A" } };
    expect(resolve(tasks, { overlay: { a: null } })).toEqual({ state: "idle", sessions: [] });
    expect(resolve(tasks, { overlay: { a: null }, tracked: ["a"] })).toMatchObject({
      state: "review",
      sessions: [{ sessionId: "a", state: "completed" }],
    });
    expect(resolve({ a: { status: "completed", title: "A" } }, { overlay: { a: 123 } })).toMatchObject(
      { state: "review", sessions: [{ sessionId: "a", state: "completed" }] },
    );
  });

  it("超过 3 条时截断，且截断保留优先级最高的状态", () => {
    const result = resolve({
      a: { status: "running", title: "1", updatedAt: 5 },
      b: { status: "running", title: "2", updatedAt: 4 },
      c: { status: "running", title: "3", updatedAt: 3 },
      d: { status: "running", title: "4", updatedAt: 2 },
      e: { status: "error", unreadAt: 1, title: "5" },
    });
    expect(result.sessions.map((s) => s.title)).toEqual(["1", "2", "3"]);
    expect(result.state).toBe("running");
  });

  it("无标题运行会话仍入列；标题空白视为缺省", () => {
    expect(resolve({ a: { status: "running" } })).toEqual({
      state: "running",
      sessions: [{ sessionId: "a", title: "", state: "running" }],
    });
    expect(resolve({ a: { status: "running", title: "   " } }).sessions[0]!.title).toBe("");
  });

  it("摘要缺省或空白时不产出 detail；超长标题/摘要被截断", () => {
    expect(resolve({ a: { status: "running", title: "T" } }).sessions[0]).toEqual({
      sessionId: "a",
      title: "T",
      state: "running",
    });
    expect(
      resolve({
        a: { status: "running", title: "T", __zcodeSessionActivity: { assistantPreview: "  " } },
      }).sessions[0]!.detail,
    ).toBeUndefined();
    const long = resolve({
      a: {
        status: "running",
        title: "题".repeat(300),
        __zcodeSessionActivity: { assistantPreview: "摘".repeat(300) },
      },
    });
    expect(long.sessions[0]!.title).toHaveLength(200);
    expect(long.sessions[0]!.detail).toHaveLength(120);
  });
});
