// 会话交接（specs/session-handoff.md）的 shell 接缝。
//
// 常驻顶栏（WorkspaceHeaderActionSection）位于会话 Provider 之外：它既读不到会话投影，
// 也不该自己拼协议命令。因此由已挂载的 SessionPane 在这里注册「资格状态 + 发起函数」，
// 顶栏按钮只按 workspace + session 路由。同一会话被多个分屏展示时优先交给 focused pane，
// 与 selection side chat 同一纪律（命令 owner 与当前输入焦点一致）。
//
// 本模块只做注册表与订阅；资格判定、摘录与命令编排分别在
// @zcode/shared/session-handoff 与 v4/useSessionHandoff.ts。
import { useCallback, useSyncExternalStore } from "react";
import type { HandoffEligibility } from "@zcode/shared/session-handoff";

/** 交接入口的作用域 key：workspace + 会话（与 selection side chat 同一口径）。 */
export function buildSessionHandoffScopeKey(workspaceKey: string, sessionId: string): string {
  return `${workspaceKey}\0${sessionId}`;
}

export interface SessionHandoffActionState {
  /** 共享资格判定结果；按钮按 reasonCode 决定隐藏（非交互）或禁用并给出原因。 */
  eligibility: HandoffEligibility;
  /** 正在发起：按钮进入处理中态并防重复点击。 */
  pending: boolean;
}

interface SessionHandoffEntry {
  focused: boolean;
  trigger: () => boolean;
  state: SessionHandoffActionState;
}

const entries = new Map<string, Map<symbol, SessionHandoffEntry>>();
const listeners = new Set<() => void>();
/** 选中项缓存：getSnapshot 必须返回稳定引用，否则 useSyncExternalStore 会死循环。 */
const selectionCache = new Map<string, { revision: number; entry: SessionHandoffEntry | null }>();
let registryRevision = 0;

function emitChange(): void {
  registryRevision += 1;
  for (const listener of listeners) listener();
}

function selectEntry(key: string): SessionHandoffEntry | null {
  const scoped = entries.get(key);
  if (!scoped?.size) return null;
  const candidates = Array.from(scoped.values());
  return candidates.find((candidate) => candidate.focused) ?? candidates[0] ?? null;
}

function cachedEntry(key: string): SessionHandoffEntry | null {
  const cached = selectionCache.get(key);
  if (cached && cached.revision === registryRevision) return cached.entry;
  const entry = selectEntry(key);
  selectionCache.set(key, { revision: registryRevision, entry });
  return entry;
}

export interface SessionHandoffRegistration {
  /** 更新按钮可见状态（资格/处理中）；引用变化即通知订阅者。 */
  setState(state: SessionHandoffActionState): void;
  dispose(): void;
}

/**
 * 注册某会话的交接能力。返回句柄由 SessionPane 在卸载时 dispose。
 * `trigger` 必须自己保证幂等：在途或不可用时返回 false，不产生半成品。
 */
export function registerSessionHandoffController(params: {
  key: string;
  focused: boolean;
  state: SessionHandoffActionState;
  trigger: () => boolean;
}): SessionHandoffRegistration {
  const token = Symbol(params.key);
  const entry: SessionHandoffEntry = {
    focused: params.focused,
    state: params.state,
    trigger: params.trigger,
  };
  const scoped = entries.get(params.key) ?? new Map<symbol, SessionHandoffEntry>();
  scoped.set(token, entry);
  entries.set(params.key, scoped);
  emitChange();

  return {
    setState: (state) => {
      entry.state = state;
      emitChange();
    },
    dispose: () => {
      const current = entries.get(params.key);
      current?.delete(token);
      if (current?.size === 0) entries.delete(params.key);
      emitChange();
    },
  };
}

export function getSessionHandoffActionState(key: string): SessionHandoffActionState | null {
  return cachedEntry(key)?.state ?? null;
}

/** 发起交接；没有可用 pane 或当前不可用/在途时返回 false（调用方不做任何事）。 */
export function requestSessionHandoff(key: string): boolean {
  const entry = cachedEntry(key);
  if (!entry) return false;
  return entry.trigger();
}

export function subscribeSessionHandoffControllers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 顶栏按钮的只读绑定：没有注册（无会话/pane 未挂载）时返回 null。 */
export function useSessionHandoffActionState(
  scopeKey: string | null,
): SessionHandoffActionState | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeSessionHandoffControllers(listener),
    [],
  );
  const getSnapshot = useCallback(
    () => (scopeKey ? getSessionHandoffActionState(scopeKey) : null),
    [scopeKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
