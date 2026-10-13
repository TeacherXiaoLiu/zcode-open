import { describe, expect, it } from "vitest";
import { resolveDesktopPetState } from "../src/hooks/useDesktopPetStateDriver.js";

/** 桌面宠物状态收敛（本地定制，specs/desktop/desktop-pet.md 状态映射表）。 */

type TaskMeta = { status?: "running" | "completed" | "error"; unreadAt?: number };

function resolve(
  tasks: Record<string, TaskMeta>,
  overlay: Record<string, number | null> = {},
): string {
  // 收敛函数只消费两个字段；这里用最小形状驱动（类型由 hook 内部保证）。
  return resolveDesktopPetState({
    taskMetaByEntityKey: tasks as never,
    taskUnreadOverlayByEntityKey: overlay as never,
  });
}

describe("resolveDesktopPetState", () => {
  it("无任务 / 无未读 → idle", () => {
    expect(resolve({})).toBe("idle");
    expect(resolve({ a: { status: "completed" } })).toBe("idle");
  });

  it("running 优先于一切未读", () => {
    expect(
      resolve({
        a: { status: "error", unreadAt: 1 },
        b: { status: "running" },
      }),
    ).toBe("running");
  });

  it("未读按 error → completed → 其他 分派 failed / review / waiting", () => {
    expect(resolve({ a: { status: "error", unreadAt: 1 } })).toBe("failed");
    expect(resolve({ a: { status: "completed", unreadAt: 1 } })).toBe("review");
    expect(resolve({ a: { status: undefined, unreadAt: 1 } })).toBe("waiting");
  });

  it("覆盖层：null 清读恢复 idle，数值覆盖 task.unreadAt", () => {
    const tasks = { a: { status: "completed", unreadAt: 1 } };
    expect(resolve(tasks, { a: null })).toBe("idle");
    expect(resolve({ a: { status: "completed" } }, { a: 123 })).toBe("review");
  });

  it("优先级：failed 高于 review 高于 waiting", () => {
    expect(
      resolve({
        a: { status: undefined, unreadAt: 1 },
        b: { status: "completed", unreadAt: 1 },
        c: { status: "error", unreadAt: 1 },
      }),
    ).toBe("failed");
    expect(
      resolve({
        a: { status: undefined, unreadAt: 1 },
        b: { status: "completed", unreadAt: 1 },
      }),
    ).toBe("review");
  });
});