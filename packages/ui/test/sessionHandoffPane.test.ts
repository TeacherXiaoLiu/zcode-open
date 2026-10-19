// @vitest-environment jsdom
// 会话交接（specs/session-handoff.md）的 UI 侧纯逻辑：投影行 → 摘录正文、资格事实映射、
// 首条消息组装。命令编排（createSession + firstInput）与导航由用户人工验收。
import { describe, expect, it } from "vitest";
import {
  HANDOFF_EXCERPT_BUDGET_CHARS,
  HANDOFF_READ_TOOL_NAME,
  HANDOFF_REJECTED,
} from "@zcode/shared/session-handoff";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildSessionHandoffPayload,
  hasHandoffSourceText,
  handoffMessagesFromConversationRows,
  resolvePaneHandoffEligibility,
  type SessionHandoffPaneFacts,
} from "@/v4/useSessionHandoff.js";

function row(value: Record<string, unknown>): ConversationRow {
  return {
    rowId: 1,
    turnId: "turn-1",
    createdAt: 1,
    createdAtSeq: 1,
    ...value,
  } as unknown as ConversationRow;
}

const baseFacts: SessionHandoffPaneFacts = {
  interactiveRoot: true,
  parentSessionId: null,
  phase: "completedSuccess",
  activeWorkCount: 0,
  queuedInputCount: 0,
  blockingInteractionCount: 0,
  hasSourceText: true,
};

describe("handoffMessagesFromConversationRows", () => {
  it("只取可见真实用户输入与助手正文，跳过合成来源与非正文行", () => {
    const messages = handoffMessagesFromConversationRows([
      row({ kind: "userInput", origin: "realUser", text: "先看这个文件" }),
      row({ kind: "userInput", origin: "backgroundResult", text: "后台任务完成" }),
      row({ kind: "userInput", origin: "goalContinuation", text: "继续目标" }),
      row({ kind: "reasoning", text: "内部推理" }),
      row({ kind: "assistantText", text: "好的", state: "complete" }),
      row({ kind: "toolCall", tool: "bash", state: { status: "completed", output: "输出" } }),
      row({ kind: "timelineMarker", marker: { type: "compact" } }),
      row({ kind: "assistantText", text: "再看这里", state: "complete" }),
    ]);

    expect(messages.map((message) => [message.role, message.synthetic ?? false])).toEqual([
      ["user", false],
      ["user", true],
      ["user", true],
      ["assistant", false],
      ["assistant", false],
    ]);
  });

  it("引擎尾注（epilogueStart 之后）不计入用户原话", () => {
    const messages = handoffMessagesFromConversationRows([
      row({
        kind: "userInput",
        origin: "realUser",
        text: "继续\n\n[引擎尾注]",
        epilogueStart: 2,
      }),
    ]);
    expect(messages[0]?.parts[0]?.text).toBe("继续");
  });

  it("没有正文时 hasHandoffSourceText=false，且组装返回 null（不建会话）", () => {
    const rows = [
      row({ kind: "userInput", origin: "backgroundResult", text: "后台任务完成" }),
      row({ kind: "reasoning", text: "内部推理" }),
    ];
    expect(hasHandoffSourceText(rows)).toBe(false);
    expect(buildSessionHandoffPayload({ oldSessionId: "sess_old", rows })).toBeNull();
  });
});

describe("buildSessionHandoffPayload", () => {
  it("组装交接指令 + 摘录，摘录部分不超过 8000 码位", () => {
    const rows = [
      row({ kind: "userInput", origin: "realUser", text: "把支付流程重构完" }),
      row({ kind: "assistantText", text: "已经改完两处调用点。", state: "complete" }),
    ];
    const payload = buildSessionHandoffPayload({ oldSessionId: "sess_old123", rows });
    expect(payload).not.toBeNull();
    expect(payload!.message).toContain("sess_old123");
    expect(payload!.message).toContain(HANDOFF_READ_TOOL_NAME);
    expect(payload!.message).toContain("把支付流程重构完");
    expect(payload!.message).toContain("已经改完两处调用点。");
    expect(payload!.excerptChars).toBeLessThanOrEqual(HANDOFF_EXCERPT_BUDGET_CHARS);
    expect(payload!.entryCount).toBe(2);
  });
});

describe("resolvePaneHandoffEligibility", () => {
  it("空闲交互式根会话且窗口里有正文：允许", () => {
    expect(resolvePaneHandoffEligibility(baseFacts)).toEqual({ allowed: true });
  });

  it("只读/副屏观察视图不是交互式根会话：无入口", () => {
    expect(resolvePaneHandoffEligibility({ ...baseFacts, interactiveRoot: false })).toMatchObject({
      allowed: false,
      reasonCode: HANDOFF_REJECTED.notInteractive,
    });
  });

  it("fork/派生会话（parentSessionId）不参与交接", () => {
    expect(
      resolvePaneHandoffEligibility({ ...baseFacts, parentSessionId: "sess_parent" }),
    ).toMatchObject({ allowed: false, reasonCode: HANDOFF_REJECTED.notInteractive });
  });

  it.each(["prewarming", "running"] as const)("phase=%s 时禁用（运行中）", (phase) => {
    expect(resolvePaneHandoffEligibility({ ...baseFacts, phase })).toMatchObject({
      allowed: false,
      reasonCode: HANDOFF_REJECTED.busy,
    });
  });

  it("有前台工作或排队输入时禁用", () => {
    expect(resolvePaneHandoffEligibility({ ...baseFacts, activeWorkCount: 1 })).toMatchObject({
      reasonCode: HANDOFF_REJECTED.busy,
    });
    expect(resolvePaneHandoffEligibility({ ...baseFacts, queuedInputCount: 2 })).toMatchObject({
      reasonCode: HANDOFF_REJECTED.busy,
    });
  });

  it("有阻塞交互时禁用", () => {
    expect(
      resolvePaneHandoffEligibility({ ...baseFacts, blockingInteractionCount: 1 }),
    ).toMatchObject({ allowed: false, reasonCode: HANDOFF_REJECTED.pendingInteraction });
  });

  it("窗口里没有可交接正文时禁用", () => {
    expect(resolvePaneHandoffEligibility({ ...baseFacts, hasSourceText: false })).toMatchObject({
      allowed: false,
      reasonCode: HANDOFF_REJECTED.noSourceText,
    });
  });
});
