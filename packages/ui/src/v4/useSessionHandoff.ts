// 会话交接（specs/session-handoff.md）的 pane 侧编排。
//
// 首条消息由**客户端组装**：UI 已经持有当前会话的投影（正在渲染它），直接用已加载的
// 用户/助手正文构造摘录；不为"服务端从权威存储读旧会话"新增宿主能力。
// 建会话与首发复用既有的 createSession + firstInput（一条命令内完成，ACK 丢失/重启已有查重事实），
// 不新增协议命令、不做二次编排。旧会话完全不变：不改消息/标题/队列/归档，不写 parentID。
//
// 纯逻辑（预算/提示词/续号标题/资格判定）全部来自 @zcode/shared/session-handoff；
// 本文件只负责把 UI 事实喂进去、发命令、导航。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  HANDOFF_REJECTED,
  buildHandoffExcerpt,
  buildHandoffMessage,
  collectHandoffEntries,
  detectHandoffLanguage,
  isHandoffEligibleMessage,
  nextHandoffTitle,
  resolveHandoffEligibility,
  type HandoffEligibility,
  type HandoffSourceMessage,
} from "@zcode/shared/session-handoff";
import type {
  CommandAck,
  ConversationRow,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import {
  buildSessionHandoffScopeKey,
  registerSessionHandoffController,
  type SessionHandoffActionState,
} from "@/v4/sessionHandoffController.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexAgentService,
} from "@/v4/sessionsIndexRegistry.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

/** 投影行 → 交接正文来源。只取可见真实用户输入与助手正文；工具/推理/压缩标记不进摘录。 */
export function handoffMessagesFromConversationRows(
  rows: readonly ConversationRow[],
): HandoffSourceMessage[] {
  const messages: HandoffSourceMessage[] = [];
  for (const row of rows) {
    if (row.kind === "userInput") {
      // 引擎尾注（dwf ask 尾注 / nudge）不是用户原话：从 epilogueStart 处截断。
      const text =
        row.epilogueStart === undefined ? row.text : row.text.slice(0, row.epilogueStart);
      messages.push({
        role: "user",
        // 隐藏合成输入（后台结果 / goal 续跑 / mailbox / workflowLaunch）不进摘录：
        // 统一映射成 synthetic，让共享规则（isHandoffEligibleMessage）来裁决，不在这里分叉一份规则。
        synthetic: row.origin !== "realUser",
        parts: [{ type: "text", text }],
      });
      continue;
    }
    if (row.kind === "assistantText") {
      messages.push({ role: "assistant", parts: [{ type: "text", text: row.text }] });
    }
  }
  return messages;
}

/** 已加载窗口里是否存在可交接正文（早退扫描；不构造摘录）。 */
export function hasHandoffSourceText(rows: readonly ConversationRow[]): boolean {
  for (const message of handoffMessagesFromConversationRows(rows)) {
    if (!isHandoffEligibleMessage(message)) continue;
    if (message.parts.some((part) => part.type === "text" && (part.text ?? "").trim().length > 0))
      return true;
  }
  return false;
}

export interface SessionHandoffPaneFacts {
  /** 交互式根会话（只读/副屏观察视图不是）。 */
  interactiveRoot: boolean;
  /** 父会话 ID（fork/子代理派生会话；来自 sessions-index 权威摘要）。 */
  parentSessionId: string | null;
  phase: ConversationSnapshot["control"]["phase"] | null;
  activeWorkCount: number;
  queuedInputCount: number;
  /** 阻塞交互数（workspaceHookReview 是软审核，不阻塞交接）。 */
  blockingInteractionCount: number;
  hasSourceText: boolean;
}

/** UI 事实 → 共享资格判定。规则本体在 shared，本函数只做映射，不另立一套。 */
export function resolvePaneHandoffEligibility(facts: SessionHandoffPaneFacts): HandoffEligibility {
  if (!facts.interactiveRoot) return { allowed: false, reasonCode: HANDOFF_REJECTED.notInteractive };
  return resolveHandoffEligibility({
    parentSessionId: facts.parentSessionId,
    taskType: null,
    busy:
      facts.phase === "prewarming" ||
      facts.phase === "running" ||
      facts.activeWorkCount > 0 ||
      facts.queuedInputCount > 0,
    hasPendingInteraction: facts.blockingInteractionCount > 0,
    // UI 观测不到 runtime 工具面与对端 CLI 版本：不伪造禁用（不可用时由新会话首个回合如实暴露）。
    readToolAvailable: true,
    capabilitySupported: true,
    hasSourceText: facts.hasSourceText,
  });
}

export interface SessionHandoffPayload {
  message: string;
  excerptChars: number;
  entryCount: number;
}

/** 组装首条消息（交接指令 + 摘录）。没有可用正文时返回 null：调用方不建会话。 */
export function buildSessionHandoffPayload(params: {
  oldSessionId: string;
  rows: readonly ConversationRow[];
}): SessionHandoffPayload | null {
  const entries = collectHandoffEntries(handoffMessagesFromConversationRows(params.rows));
  if (entries.length === 0) return null;
  const excerpt = buildHandoffExcerpt(entries);
  if (!excerpt.text) return null;
  return {
    message: buildHandoffMessage({
      oldSessionId: params.oldSessionId,
      excerpt: excerpt.text,
      language: detectHandoffLanguage(entries),
    }),
    excerptChars: excerpt.chars,
    entryCount: excerpt.entryCount,
  };
}

export interface UseSessionHandoffParams {
  focused: boolean;
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** subagent 观察视图等只读 pane：不提供交接入口。 */
  readOnly: boolean;
  /** 框选副屏：不是交互式根会话。 */
  selectionSideChat: boolean;
  snapshot: ConversationSnapshot | null;
  /** 当前 pane 的有效执行选择（createComposerSubmissionConfig 冻结结果）；null = 不可用。 */
  submission: ComposerSubmissionConfig | null;
  /** 复用 SessionPane 的 createSession 发送纪律（pending 账本 / ACK 观测）。 */
  dispatchCreateSession: (payload: Record<string, unknown>) => Promise<CommandAck>;
  /** 成功后复用既有导航（shell 的 onSessionCreated）。 */
  onSessionCreated?: (sessionId: string) => void;
  agentService: SessionsIndexAgentService;
  intl: IntlShape;
  /** toast 里的交接时刻按当前 locale 本地化（IntlInstance 没有 formatTime）。 */
  locale: string;
}

function isBlockingInteraction(
  interaction: ConversationSnapshot["pendingInteractions"][number],
): boolean {
  // 软审核（workspaceHookReview）不是阻塞交互，与 SessionPane 的 blockingInteractionId 同规则。
  return interaction.payload.kind !== "workspaceHookReview";
}

function sameActionState(
  left: SessionHandoffActionState,
  right: SessionHandoffActionState,
): boolean {
  if (left.pending !== right.pending) return false;
  if (left.eligibility.allowed !== right.eligibility.allowed) return false;
  if (left.eligibility.allowed || right.eligibility.allowed) return true;
  return left.eligibility.reasonCode === right.eligibility.reasonCode;
}

/**
 * 在已挂载的 SessionPane 内注册交接能力（顶栏按钮经 sessionHandoffController 路由）。
 * 草稿态（sessionId=null）不注册：没有可交接的会话。
 */
export function useSessionHandoff(params: UseSessionHandoffParams): void {
  const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  const scopeKey = params.sessionId
    ? buildSessionHandoffScopeKey(workspaceKey, params.sessionId)
    : null;
  const [parentSessionId, setParentSessionId] = useState<string | null>(null);
  // 列表订阅需要可用的 agent service（部分宿主/测试 double 不提供）；缺失时保守按
  // 「无父会话」处理并跳过订阅，不让面板因可选能力缺失崩掉。
  const sessionsIndexService = params.agentService;
  const pendingRef = useRef(false);
  const aliveRef = useRef(true);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const bindingRef = useRef({ scopeKey, workspaceKey, sessionId: params.sessionId });
  bindingRef.current = { scopeKey, workspaceKey, sessionId: params.sessionId };

  // fork/派生会话在 sessions-index 摘要里有权威 parentSessionId；主会话没有该字段。
  // 只读/副屏 pane 不参与交接，不必为它订阅列表（interactiveRoot=false 已短路裁决）。
  useEffect(() => {
    if (
      !params.sessionId ||
      params.readOnly ||
      params.selectionSideChat ||
      !sessionsIndexService
    ) {
      setParentSessionId(null);
      return undefined;
    }
    const scope = {
      workspaceKey,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    };
    const store = acquireSessionsIndex(scope, sessionsIndexService);
    const read = (): void => {
      const summary = store.getSessions().find((item) => item.sessionId === params.sessionId);
      setParentSessionId(summary?.parentSessionId ?? null);
    };
    read();
    const unsubscribe = store.subscribe(read);
    return () => {
      unsubscribe();
      releaseSessionsIndex(scope, store);
    };
  }, [
    params.readOnly,
    params.selectionSideChat,
    params.sessionId,
    params.workspaceIdentity,
    params.workspacePath,
    sessionsIndexService,
    workspaceKey,
  ]);

  const hasSourceText = useMemo(
    () => hasHandoffSourceText(params.snapshot?.rows.window ?? []),
    [params.snapshot?.rows.window],
  );
  const eligibility = useMemo(
    () =>
      resolvePaneHandoffEligibility({
        interactiveRoot: !params.readOnly && !params.selectionSideChat,
        parentSessionId,
        phase: params.snapshot?.control.phase ?? null,
        activeWorkCount: params.snapshot?.control.activeWorks.length ?? 0,
        queuedInputCount: params.snapshot?.queue.items.length ?? 0,
        blockingInteractionCount:
          params.snapshot?.pendingInteractions.filter(isBlockingInteraction).length ?? 0,
        hasSourceText,
      }),
    [
      hasSourceText,
      parentSessionId,
      params.readOnly,
      params.selectionSideChat,
      params.snapshot?.control.activeWorks.length,
      params.snapshot?.control.phase,
      params.snapshot?.pendingInteractions,
      params.snapshot?.queue.items.length,
    ],
  );
  const actionState = useMemo<SessionHandoffActionState>(
    () => ({ eligibility, pending: pendingRef.current }),
    [eligibility],
  );
  const actionStateRef = useRef(actionState);
  actionStateRef.current = actionState;
  const registrationRef = useRef<{ setState: (state: SessionHandoffActionState) => void } | null>(
    null,
  );

  const trigger = useCallback((): boolean => {
    const current = paramsRef.current;
    const binding = bindingRef.current;
    const oldSessionId = binding.sessionId;
    if (!oldSessionId || !binding.scopeKey) return false;
    if (pendingRef.current) return false;
    const currentEligibility = resolvePaneHandoffEligibility({
      interactiveRoot: !current.readOnly && !current.selectionSideChat,
      parentSessionId,
      phase: current.snapshot?.control.phase ?? null,
      activeWorkCount: current.snapshot?.control.activeWorks.length ?? 0,
      queuedInputCount: current.snapshot?.queue.items.length ?? 0,
      blockingInteractionCount:
        current.snapshot?.pendingInteractions.filter(isBlockingInteraction).length ?? 0,
      hasSourceText: hasHandoffSourceText(current.snapshot?.rows.window ?? []),
    });
    if (!currentEligibility.allowed) {
      // 按钮在这些状态下是禁用的；命中说明状态在渲染与点击之间变化（或调用方绕过 UI），只记事实。
      logger.debug("[v4-handoff] 交接不可用，未发起", {
        oldSessionId,
        reasonCode: currentEligibility.reasonCode,
      });
      return false;
    }
    const submission = current.submission;
    if (!submission) {
      toast(current.intl.formatMessage({ id: "chat.handoff.executionUnavailable" }));
      return false;
    }
    const payload = buildSessionHandoffPayload({
      oldSessionId,
      rows: current.snapshot?.rows.window ?? [],
    });
    if (!payload) {
      toast(current.intl.formatMessage({ id: "chat.handoff.disabled.noSourceText" }));
      return false;
    }
    const title = current.snapshot?.meta.title?.trim() ?? "";
    const initialTitle = nextHandoffTitle(title);
    const followupMode = current.snapshot?.config.followupMode;
    const requestWorkspaceKey = binding.workspaceKey;
    pendingRef.current = true;
    actionStateRef.current = { eligibility: currentEligibility, pending: true };
    registrationRef.current?.setState(actionStateRef.current);
    void (async () => {
      try {
        const ack = await current.dispatchCreateSession({
          workspaceId: requestWorkspaceKey,
          config: {
            modelSelection: submission.modelSelection,
            mode: submission.mode,
            planEnabled: submission.planEnabled,
            ...(followupMode ? { followupMode } : {}),
          },
          firstInput: {
            text: payload.message,
            modelSelection: submission.modelSelection,
            mode: submission.mode,
            planEnabled: submission.planEnabled,
          },
          // 续号标题在首次持久化时写入（非 custom 来源），并关闭首轮自动命名，
          // 避免被 titleFromInput 与首轮命名各覆盖一次。
          // 旧会话没有标题时不写初始标题，也不关首轮命名：让新会话按既有默认命名得到可读标题。
          ...(initialTitle
            ? { initialTitle, titleGenerationEnabled: false }
            : {}),
        });
        if (ack.status !== "accepted" || ack.result?.type !== "createSession") {
          throw new Error(ack.message ?? ack.reasonCode ?? ack.status);
        }
        const createdSessionId = ack.result.sessionId;
        // 迟到结果：workspace/pane 已切换或 pane 已卸载时只报事实，不抢回导航。
        const stillBound =
          aliveRef.current &&
          bindingRef.current.scopeKey === binding.scopeKey &&
          bindingRef.current.workspaceKey === requestWorkspaceKey &&
          bindingRef.current.sessionId === oldSessionId;
        logger.info("[v4-handoff] 交接会话已创建", {
          createdSessionId,
          entryCount: payload.entryCount,
          excerptChars: payload.excerptChars,
          initialTitle,
          oldSessionId,
          stillBound,
        });
        if (!stillBound) {
          toast(current.intl.formatMessage({ id: "chat.handoff.createdElsewhere" }));
          return;
        }
        current.onSessionCreated?.(createdSessionId);
        toast(
          current.intl.formatMessage(
            { id: "chat.handoff.created" },
            { time: new Date().toLocaleTimeString(current.locale) },
          ),
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn("[v4-handoff] 会话交接失败", { oldSessionId, reason });
        // 不做降级：失败就是失败，用户可重试；不生成"只带部分上下文"的会话。
        toast(current.intl.formatMessage({ id: "chat.handoff.failed" }, { reason }));
      } finally {
        pendingRef.current = false;
        actionStateRef.current = { eligibility: currentEligibility, pending: false };
        registrationRef.current?.setState(actionStateRef.current);
      }
    })();
    return true;
  }, [parentSessionId]);
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;

  useEffect(() => {
    if (!scopeKey) return undefined;
    const registration = registerSessionHandoffController({
      key: scopeKey,
      focused: params.focused,
      state: actionStateRef.current,
      trigger: () => triggerRef.current(),
    });
    registrationRef.current = registration;
    return () => {
      if (registrationRef.current === registration) registrationRef.current = null;
      registration.dispose();
    };
  }, [params.focused, scopeKey]);

  useEffect(() => {
    // 注册句柄在 effect 之后才存在；资格变化时同步给顶栏按钮。
    if (sameActionState(actionStateRef.current, actionState)) return;
    actionStateRef.current = actionState;
    registrationRef.current?.setState(actionState);
  }, [actionState]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
}
