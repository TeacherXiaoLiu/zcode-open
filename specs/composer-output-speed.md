# 输入框输出速度与会话统计（定制）

> 本功能是本地定制版新增能力：输入框工具栏内的「实时/平均 tok/s」标签（点击展开"会话统计"），
> 以及上下文面板底部的「Token 用量」明细区块。
> 参考实现：DeepSeek Harness 原生状态行（`用时 · 首 token · tok/s`）、Hermes 生态 `h-stats`
> 插件（`avg_tps` 优先、wall-clock 回退、100k 上限保护）、会话统计弹窗（模型用时/工具调用用时/
> TTFT/输出速度）与 Token 用量明细（缓存命中/未缓存输入/缓存读取/缓存写入/输出）。

## 目标与边界

- **目标**：流式进行中提供"实时速度"反馈（区别于平均口径）；提供点击展开的会话级统计；
  在上下文面板补充累计 token 的分项用量。
- **不改变**：v4 协议与 usage 投影（`snapshot.usage`）、调试面板 TPS（`calculateOutputTps`，权威口径）、
  Highspeed 节省时长统计、`session-debug` 既有字段语义（只新增两个字段）。
- 全部 UI 在 renderer 内派生；`session-debug` 仅新增两个 nullable 字段（同批发布，无兼容包袱）。

## 一、工具栏速度标签（实时 + 平均）

- **位置**：composer 工具栏行内、**紧靠上下文图标左侧**，与模型选择/思考深度同一行
  （`V4ComposerModelControls` 渲染序：速度标签 → ChatContextUsage → 模型 → 思考 → 发送）。
- 显示：`实时 <n> tok/s · 平均 <n> tok/s`（zh）/ `Live <n> tok/s · Avg <n> tok/s`（en）；
  空闲（实时归零）时只显示平均；无任何输出数据时整条不渲染（不占位）。
- 刷新：组件内 1 秒 tick 重算实时读数；计量器最近 10 秒无输出后停止触发渲染。
- **数据源与口径**（同前）：投影 store 的 `onLiveDeltas` 旁路，只统计 `row.delta` 且
  `path === "text"`（assistantText + reasoning）；实时 = 5 秒滑动窗口 ÷ 有效跨度；
  平均 = 会话累计估算 token ÷ 分段生成时长（停顿 >2s 不计入分母）。
  保护：单帧 >20,000 字符跳过、实时钳制 100k tok/s。
- **估算口径**：流式过程中协议只有字符增量，token 数按字符估算（CJK ~1 token/字、
  其余 ~4 字符/token，±30%），tooltip 注明；权威 TPS 以会话统计/调试面板为准。

## 二、点击展开"会话统计"

- 点击速度标签 → Popover（顶端对齐、对齐上下文面板风格）显示四个指标：

  | 指标 | 口径 | 数据源 |
  |---|---|---|
  | 模型用时 | Σ 主轮模型请求总时长（含首 token 等待） | session-debug `rounds[].durationMs` |
  | 工具调用用时 | Σ 各轮工具区间并集时长 | v4 `turnHeader.toolDurationMs`（`rows.window` 求和） |
  | 首 token 平均（TTFT） | avg(每请求 TTFT) | session-debug `rounds[].timeToFirstContentMs` |
  | 输出速度（TPS） | Σ outputTokens ÷ Σ generationDurationMs | session-debug `rounds`（与调试面板同口径） |

- 数据缺失显示 `—`；格式：分钟级 `X分Y秒`/`Xm Ys`，秒级一位小数 `8.9秒`/`8.9s`，TPS 取整。
- **加载时机**：面板只在打开时挂载 → `useSessionDebug` 的 1 秒轮询只在打开期间运行；
  关闭即停止（不打开零开销）。
- **session-debug 扩展**（`packages/shared/src/session-debug.ts` + CLI `observeSessionDebug`）：
  round 新增 `durationMs`、`timeToFirstContentMs`（nullable；`generationDurationMs` 是两者差额，
  无法反推各自分量）。schema 为 `.strict()`，CLI 与 UI 同批发布。
- 工具时长读取走 `snapshotRef` 现读（`readToolDurationMs`），**不把 snapshot 带入工具栏 memo 子树**
  （composer 随流式高频重渲染，控制簇只在语义依赖变化时重建）。

## 三、上下文面板「Token 用量」明细

- 位置：上下文 hover 面板内、"平均缓存命中率"之后（独立区块 + 顶部边框）。
- 内容：标题行 `Token 用量` + 千分位总量；明细 5 行：缓存命中（%）、未缓存输入、缓存读取、
  缓存写入、输出（均千分位完整数字 + `tok`）。
- 口径（`resolveCumulativeTokenUsagePanel`，已用本地 DB 验证 `input + output = computed_total`）：
  - `total = inputTokens + outputTokens`（AI SDK v6 的 inputTokens 是含缓存的 total）；
  - `未缓存输入 = max(0, inputTokens - cacheReadTokens - cacheWriteTokens)`；
  - `缓存命中 = cacheReadTokens ÷ inputTokens`；
  - 数据缺失或全零时不渲染该区块。
- 数据源：`snapshot.usage.cumulative`（CLI 在每次 ModelComplete 累加），经 `usage` prop →
  `ChatContextUsage.cumulativeUsage`。

## 数据流（单一写入路径）

```
投影 store.applyFrame（row.delta / usage 更新）
   ├─ onLiveDeltas 旁路 → useConversationOutputSpeed → outputSpeedMeter → 速度标签（1s tick）
   ├─ usage.cumulative → ChatContextUsage.cumulativeUsage → Token 用量区块
   └─ snapshotRef → readToolDurationMs（仅统计面板打开时读取）
session-debug RPC（rounds：durationMs/TTFT/TPS）→ ComposerSessionStatsPanel（打开时 1s 轮询）
```

- 计量器与统计都不是第二份事实来源：不进入 store、不参与协议、不写盘，仅派生显示值。
- 会话隔离与常驻：每个会话一个计量器（按 sessionId 缓存，最多 50 个）；切走时导出平均口径
  快照（累计 token + 生成时长），回切时恢复——平均速度一直显示；实时样本因时间戳过期不恢复，
  回来后等新输出自然出现。同一会话只允许第一个挂载的 store 订阅 live delta（防分屏重复推送翻倍）。

## 验收场景

1. 发送消息后：工具栏上下文图标左侧出现速度标签，实时读数随输出跳动、平均稳定；
   流式结束后实时读数约 5 秒内消失，平均保留。
2. 点击速度标签：展开"会话统计"，四项指标数量级正确（TPS 与调试面板同口径）；关闭再打开
   无残留；无数据时显示 `—`。
3. 工具执行停顿不计入平均分母；实时读数衰减归零后重新爬升。
4. 打开上下文面板：底部出现"Token 用量"，总 = 未缓存 + 缓存读 + 缓存写 + 输出；
   中文/英文数字格式正确；无用量数据时不出现该区块。
5. 打开无输出的历史会话：速度标签不渲染；切到 B 会话再切回 A：A 的平均速度仍在显示，
   实时读数等新输出出现；新会话从空开始，不携带其他会话的数值。

## 范围

- 本次包含：工具栏速度标签（实时+平均）、点击展开的会话统计（含 session-debug 两字段扩展）、
  上下文面板 Token 用量明细。
- 不包含：轮次/步数展示、按模型校准估算系数、成本（USD）统计、跨会话用量历史页。
