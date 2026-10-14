import { useEffect, useState } from "react";
import type { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import {
  createOutputSpeedMeter,
  type OutputSpeedAverageSnapshot,
  type OutputSpeedMeter,
} from "@/v4/outputSpeedMeter.js";

/**
 * 会话输出速度计量器组装（本地定制，见 outputSpeedMeter.ts 的口径说明）。
 *
 * 数据源是投影 store 的 live delta 旁路（onLiveDeltas）：只统计 `path === "text"` 的追加——
 * 它对应 assistantText 与 reasoning 两类行的模型输出文本；工具参数（inputText）、工具输出
 * （output.text）和子代理摘要（summaryText）不属于"模型输出速度"，不参与统计。
 * snapshot 帧（冷恢复/重订阅基线）不触发 live delta，因此恢复不会把历史内容计成新输出。
 *
 * 每个会话一个计量器（按 sessionId 缓存在模块级 Map 里）：切换会话再回来时恢复该会话的
 * 平均速度显示；实时样本带 renderer 时钟时间戳，切换期间必然过期，只恢复平均口径。
 * 同一 renderer 进程内多个 SessionPane（分屏/子代理 tab）共享同一会话的计量器是刻意的：
 * 计量器输入幂等（同一会话的 live delta 内容相同），多人共写同一份统计不会翻倍——
 * 但如果两个 pane 订阅的是同一会话的两个 store 实例，重复推送会翻倍，因此按会话只允许
 * 第一个挂载的 store 订阅，其余 pane 只读显示（见 subscribedSessionIds）。
 */
const metersBySessionId = new Map<string, OutputSpeedMeter>();
/** 平均口径的跨会话保留：切走时导出快照，回切时恢复。 */
const averageSnapshotsBySessionId = new Map<string, OutputSpeedAverageSnapshot>();
/** 已有订阅者的会话：防止同一会话的两个 store 实例重复推送导致统计翻倍。 */
const subscribedSessionIds = new Set<string>();
/** 上限：防止长期打开大量会话导致 Map 无限增长；超出后淘汰最早的会话。 */
const MAX_CACHED_SESSIONS = 50;

function getOrCreateMeter(sessionId: string): OutputSpeedMeter {
  let meter = metersBySessionId.get(sessionId);
  if (!meter) {
    meter = createOutputSpeedMeter();
    if (metersBySessionId.size >= MAX_CACHED_SESSIONS) {
      const oldest = metersBySessionId.keys().next().value;
      if (oldest !== undefined && oldest !== sessionId) {
        metersBySessionId.delete(oldest);
        averageSnapshotsBySessionId.delete(oldest);
        subscribedSessionIds.delete(oldest);
      }
    }
    metersBySessionId.set(sessionId, meter);
  }
  return meter;
}

export function useConversationOutputSpeed(
  store: ConversationProjectionStore | null,
  sessionId: string | null,
): OutputSpeedMeter | null {
  const [meter, setMeter] = useState<OutputSpeedMeter | null>(null);
  useEffect(() => {
    // 草稿（无 sessionId）或 lease 未就绪：不计量、不订阅。
    if (!store || !sessionId) {
      setMeter(null);
      return undefined;
    }
    const current = getOrCreateMeter(sessionId);
    // 切回有历史的会话：恢复平均口径；新会话：从空开始。
    // reset 语义保留在 restoreAverage(null) 里——无快照即清空。
    current.restoreAverage(averageSnapshotsBySessionId.get(sessionId) ?? null);
    setMeter(current);
    // 同一会话只允许第一个挂载的 store 订阅 live delta；重复挂载的 pane 只读显示。
    if (subscribedSessionIds.has(sessionId)) {
      return undefined;
    }
    subscribedSessionIds.add(sessionId);
    const unsubscribe = store.onLiveDeltas((deltas) => {
      for (const delta of deltas) {
        if (delta.op === "row.delta" && delta.path === "text") {
          current.push(delta.append);
        }
      }
    });
    return () => {
      unsubscribe();
      subscribedSessionIds.delete(sessionId);
      // 切走/卸载时导出平均快照：下次回来恢复显示；新输出继续累加在快照之上。
      const snapshot = current.snapshotAverage();
      if (snapshot) {
        averageSnapshotsBySessionId.set(sessionId, snapshot);
      } else {
        averageSnapshotsBySessionId.delete(sessionId);
      }
    };
  }, [store, sessionId]);
  return meter;
}
