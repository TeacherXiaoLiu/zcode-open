import { useEffect, useState } from "react";
import type { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { createOutputSpeedMeter, type OutputSpeedMeter } from "@/v4/outputSpeedMeter.js";

/**
 * 会话输出速度计量器组装（本地定制，见 outputSpeedMeter.ts 的口径说明）。
 *
 * 数据源是投影 store 的 live delta 旁路（onLiveDeltas）：只统计 `path === "text"` 的追加——
 * 它对应 assistantText 与 reasoning 两类行的模型输出文本；工具参数（inputText）、工具输出
 * （output.text）和子代理摘要（summaryText）不属于"模型输出速度"，不参与统计。
 * snapshot 帧（冷恢复/重订阅基线）不触发 live delta，因此恢复不会把历史内容计成新输出。
 *
 * 计量器生命周期与 store 绑定：lease 切换（换会话）时重置，避免旧会话样本污染新会话。
 */
export function useConversationOutputSpeed(
  store: ConversationProjectionStore | null,
): OutputSpeedMeter | null {
  const [meter] = useState(() => createOutputSpeedMeter());
  useEffect(() => {
    meter.reset();
    if (!store) {
      return undefined;
    }
    return store.onLiveDeltas((deltas) => {
      for (const delta of deltas) {
        if (delta.op === "row.delta" && delta.path === "text") {
          meter.push(delta.append);
        }
      }
    });
  }, [store, meter]);
  return store ? meter : null;
}
