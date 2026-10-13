import { useCallback, useEffect, useRef, useState } from "react";
import {
  DESKTOP_PET_SCALE_DEFAULT,
  normalizeDesktopPetScale,
  type DesktopPetImportReview,
  type DesktopPetImportSource,
  type DesktopPetInstalledInfo,
  type DesktopPetMarketPage,
  type DesktopPetOperationPhase,
  type DesktopPetOperationProgress,
} from "@zcode/shared";
import { usePlatform } from "./usePlatform.js";
import { useSettings } from "./useSettingService.js";

export interface DesktopPetUiError {
  messageId: string;
  details?: string;
}
export interface DesktopPetUiOperation {
  progress: DesktopPetOperationProgress;
  cancelling: boolean;
}

function errorDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isCancelled(error: unknown): boolean {
  return (
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "CANCELLED") ||
    /\bCANCELLED\b/.test(errorDetails(error))
  );
}
const errorId = (kind: string) => `settings.desktopPet.error.${kind}`;

/** Main 持有宠物库与安装操作；此 hook 只持有当前页面的投影、review 和进度订阅。 */
export function useDesktopPets({ showMarket }: { showMarket: boolean }) {
  const { desktopPet: port } = usePlatform();
  const {
    settings,
    loading: settingsLoading,
    error: settingsError,
    update,
    refresh,
  } = useSettings();
  const [installed, setInstalled] = useState<DesktopPetInstalledInfo[]>([]);
  const [installedLoading, setInstalledLoading] = useState(Boolean(port));
  const [installedError, setInstalledError] = useState<DesktopPetUiError | null>(null);
  const [actionError, setActionError] = useState<DesktopPetUiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<DesktopPetUiOperation | null>(null);
  const [noticeId, setNoticeId] = useState<string | null>(null);
  const [importReview, setImportReview] = useState<DesktopPetImportReview | null>(null);
  const [marketPage, setMarketPage] = useState<DesktopPetMarketPage | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<DesktopPetUiError | null>(null);
  const [marketQuery, setMarketQuery] = useState("");
  const [marketCategory, setMarketCategory] = useState("");
  const [marketPageIndex, setMarketPageIndex] = useState(0);
  const mounted = useRef(true);
  const locked = useRef(false);
  const currentOperation = useRef<{ id: string; cancelling: boolean } | null>(null);
  const installedRequest = useRef(0);
  const marketRequest = useRef(0);
  const marketState = useRef({
    query: "",
    category: "",
    cursors: [undefined] as (string | undefined)[],
    index: 0,
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      installedRequest.current += 1;
      marketRequest.current += 1;
      // 离开页面只停止投影；已接受的 Main 操作不能因组件卸载而隐式取消。
    };
  }, []);

  useEffect(
    () =>
      port?.onOperationProgress((progress) => {
        if (!mounted.current || progress.operationId !== currentOperation.current?.id) return;
        setOperation({ progress, cancelling: currentOperation.current.cancelling });
      }),
    [port],
  );

  const refreshInstalled = useCallback(async () => {
    if (!port) return;
    const request = ++installedRequest.current;
    setInstalledLoading(true);
    setInstalledError(null);
    try {
      const pets = await port.listInstalled();
      if (mounted.current && installedRequest.current === request) setInstalled(pets);
    } catch (error) {
      if (mounted.current && installedRequest.current === request) {
        setInstalledError({ messageId: errorId("installed"), details: errorDetails(error) });
      }
    } finally {
      if (mounted.current && installedRequest.current === request) setInstalledLoading(false);
    }
  }, [port]);
  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  const loadMarket = useCallback(
    async (state: typeof marketState.current, forceRefresh = false) => {
      if (!port) return;
      const request = ++marketRequest.current;
      setMarketLoading(true);
      setMarketError(null);
      try {
        const page = await port.listMarket({
          query: state.query || undefined,
          category: state.category || undefined,
          cursor: state.cursors[state.index],
          limit: 12,
          refresh: forceRefresh,
        });
        // 搜索、分类和翻页共用版本号，迟到的旧响应不能改写新页面。
        if (mounted.current && marketRequest.current === request) {
          setMarketPage(page);
          marketState.current = state;
          setMarketPageIndex(state.index);
        }
      } catch (error) {
        if (mounted.current && marketRequest.current === request) {
          setMarketError({ messageId: errorId("market"), details: errorDetails(error) });
        }
      } finally {
        if (mounted.current && marketRequest.current === request) setMarketLoading(false);
      }
    },
    [port],
  );
  useEffect(() => {
    if (showMarket) void loadMarket(marketState.current);
  }, [showMarket, loadMarket]);

  const searchMarket = useCallback(
    async (query: string, category: string) => {
      const state = {
        query: query.trim(),
        category,
        cursors: [undefined] as (string | undefined)[],
        index: 0,
      };
      marketState.current = state;
      setMarketQuery(state.query);
      setMarketCategory(category);
      setMarketPage((current) =>
        current ? { ...current, items: [], nextCursor: undefined, total: 0 } : null,
      );
      setMarketPageIndex(0);
      await loadMarket(state);
    },
    [loadMarket],
  );
  const refreshMarket = useCallback(async () => {
    const state = { ...marketState.current, cursors: [undefined], index: 0 };
    await loadMarket(state, true);
  }, [loadMarket]);
  const nextMarketPage = useCallback(async () => {
    if (!marketPage?.nextCursor || marketLoading) return;
    const state = marketState.current;
    await loadMarket({
      ...state,
      cursors: [...state.cursors.slice(0, state.index + 1), marketPage.nextCursor],
      index: state.index + 1,
    });
  }, [loadMarket, marketPage, marketLoading]);
  const previousMarketPage = useCallback(async () => {
    if (marketState.current.index === 0 || marketLoading) return;
    await loadMarket({ ...marketState.current, index: marketState.current.index - 1 });
  }, [loadMarket, marketLoading]);

  const runAction = useCallback(
    async (kind: string, action: () => Promise<void>, phase?: DesktopPetOperationPhase) => {
      if (!port || locked.current) return false;
      locked.current = true;
      setBusy(true);
      setActionError(null);
      setNoticeId(null);
      if (phase) {
        const id = crypto.randomUUID();
        currentOperation.current = { id, cancelling: false };
        setOperation({
          progress: { operationId: id, phase, completed: 0, total: 0 },
          cancelling: false,
        });
      }
      try {
        await action();
        if (mounted.current && kind !== "scan")
          setNoticeId(`settings.desktopPet.operation.${phase ? "completed" : "saved"}`);
        return true;
      } catch (error) {
        if (mounted.current) {
          if (isCancelled(error)) setNoticeId("settings.desktopPet.operation.cancelled");
          else setActionError({ messageId: errorId(kind), details: errorDetails(error) });
        }
        return false;
      } finally {
        // 先撤销当前 ID，再刷新投影；已完成操作的迟到事件不会进入下一次操作。
        currentOperation.current = null;
        locked.current = false;
        if (mounted.current) {
          setBusy(false);
          setOperation(null);
          void refreshInstalled();
          void refresh();
          if (phase && showMarket) void loadMarket(marketState.current);
        }
      }
    },
    [port, refreshInstalled, refresh, showMarket, loadMarket],
  );

  const activeId = settings?.desktopPetId?.trim();
  // Main 在保存的 ID 已失效时也选取首个有效安装；同一投影规则防止 UI 误放开活动项删除。
  const activePet = installed.find((pet) => pet.id === activeId) ?? installed[0];
  const activePetId = activePet?.id ?? activeId ?? "";
  const setEnabled = useCallback(
    (enabled: boolean) =>
      runAction("save", async () => {
        await update({ desktopPetEnabled: enabled });
      }),
    [runAction, update],
  );
  const scale = settings?.desktopPetScale ?? DESKTOP_PET_SCALE_DEFAULT;
  const setScale = useCallback(
    (next: number) =>
      runAction("save", async () => {
        await update({ desktopPetScale: normalizeDesktopPetScale(next) });
      }),
    [runAction, update],
  );
  const setActive = useCallback(
    (petId: string) =>
      runAction("activate", async () => {
        await port!.setActive(petId);
      }),
    [runAction, port],
  );
  const deletePet = useCallback(
    async (petId: string) => {
      if (petId === activePetId) {
        setActionError({ messageId: errorId("activeDelete") });
        return false;
      }
      return runAction(
        "delete",
        () => port!.deleteInstalled({ operationId: currentOperation.current!.id, petId }),
        "deleting",
      );
    },
    [activePetId, port, runAction],
  );
  const installMarketPet = useCallback(
    (petId: string, replaceExisting = false) =>
      runAction(
        "install",
        () =>
          port!.installMarketPet({
            operationId: currentOperation.current!.id,
            petId,
            replaceExisting,
          }),
        "downloading",
      ),
    [runAction, port],
  );
  const prepareImport = useCallback(
    async (source: DesktopPetImportSource) => {
      setImportReview(null);
      return runAction("scan", async () => {
        const review = await port!.prepareImport(source);
        if (mounted.current) setImportReview(review);
      });
    },
    [port, runAction],
  );
  const installImport = useCallback(
    async (petIds: string[], replacePetIds: string[]) => {
      if (!importReview || importReview.expiresAt <= Date.now()) {
        setActionError({ messageId: errorId("reviewExpired") });
        return false;
      }
      const selected = [...new Set(petIds)];
      const candidates = selected.map((id) =>
        importReview.candidates.find((candidate) => candidate.id === id),
      );
      if (!selected.length || candidates.some((candidate) => !candidate)) {
        setActionError({ messageId: errorId("selection") });
        return false;
      }
      const duplicates = candidates
        .filter((candidate) => candidate?.alreadyInstalled)
        .map((candidate) => candidate!.id);
      if (duplicates.some((id) => !replacePetIds.includes(id))) {
        setActionError({ messageId: errorId("replaceRequired") });
        return false;
      }
      const success = await runAction(
        "import",
        () =>
          port!.installImport({
            operationId: currentOperation.current!.id,
            reviewId: importReview.reviewId,
            petIds: selected,
            replacePetIds: duplicates,
          }),
        "staging",
      );
      if (success && mounted.current) setImportReview(null);
      return success;
    },
    [importReview, port, runAction],
  );
  const cancelOperation = useCallback(() => {
    const current = currentOperation.current;
    if (!current || current.cancelling || !port) return;
    current.cancelling = true;
    setOperation((value) => (value ? { ...value, cancelling: true } : null));
    try {
      port.cancelOperation(current.id);
    } catch (error) {
      setActionError({ messageId: errorId("cancel"), details: errorDetails(error) });
    }
  }, [port]);

  return {
    available: Boolean(port),
    installed,
    installedLoading,
    installedError,
    refreshInstalled,
    enabled: settings?.desktopPetEnabled === true,
    activePet,
    activePetId,
    settingsLoading,
    settingsReady: Boolean(settings),
    settingsError: settingsError
      ? { messageId: errorId("settings"), details: errorDetails(settingsError) }
      : null,
    refreshSettings: refresh,
    busy,
    actionError,
    noticeId,
    operation,
    setEnabled,
    scale,
    setScale,
    setActive,
    deletePet,
    installMarketPet,
    prepareImport,
    installImport,
    cancelOperation,
    importReview,
    clearImportReview: () => setImportReview(null),
    clearActionError: () => {
      setActionError(null);
      setNoticeId(null);
    },
    marketPage,
    marketLoading,
    marketError,
    marketQuery,
    marketCategory,
    marketPageIndex,
    searchMarket,
    refreshMarket,
    nextMarketPage,
    previousMarketPage,
  };
}

export type DesktopPetsController = ReturnType<typeof useDesktopPets>;
