# 会话标题定期自动刷新（定制）

> 本功能是本地定制版新增能力（上游原生只在会话早期生成一次标题）。参考实现：
> `@fish-under-sea/dsh-session-title-refresh`（DeepSeek Harness 生态，v0.3.2）。

## 目标与边界

- **目标**：长会话进行到一定轮次后，标题跟随对话方向定期刷新；提供手动"生成新标题"入口。
- **不改变**：首轮标题生成（原生 `session-title.ts` 链路）、标题提交的持久化与事件协议
  （`titleSource: "generated"` + `SessionTitleUpdated`）、`custom` 来源保护、侧栏刷新路径。
- **不新增**：新的标题来源（`titleSource` 不加新枚举值）。

## 触发规则（绝对轮次网格）

- 刷新发生在「真实用户轮次完成」时（与 `recordTurnUsageFact(status: completed)` 同一个完成区块）。
- 网格：`firstRound`、`firstRound + interval`、`firstRound + 2 * interval`…
  **只认"完成轮次正好落在网格点上"**——中途改参数/重启/恢复旧会话都不补跑历史
  （避免一次性爆发一串辅助调用）。
- 轮次口径：会话消息中**可见真实用户消息**的数量（`role === "user"` 且
  `synthetic !== true` 且 `visibility !== "model-only"`），与首轮标题生成的真实输入口径一致。
- 子代理会话（`parentID` / `taskType !== "interactive"`）永不参与。
- 用户手动改过名的会话（`titleSource === "custom"`）默认不再被自动刷新覆盖
  （沿用 `persistGeneratedSessionTitle` 的既有短路）。

## 配置

| 字段 | 默认 | 硬边界 | 说明 |
|---|---|---|---|
| `enabled` | `true` | — | 总开关 |
| `firstRound` | `3` | 1–50 | 首次刷新轮次 |
| `interval` | `5` | 1–100 | 刷新间隔 |

- 生成输入取样：**首条 + 最近（windowSize-1）条**真实用户消息（默认共 8 条），
  超预算先丢中段、再按比例截断，**首尾永不丢**。
- 生成执行的模型选择、超时、提示词与清洗沿用 `title-generation-sidecar.ts` 现成链路
  （不新增第二条生成路径）。
- 失败（超时 / 无路由 / 空标题）保留旧标题，只记日志。

## 设置与热更新链路

存储：`AppSettings` 三个**平铺**字段（`sessionTitleRefreshEnabled` / `FirstRound` / `Interval`）——
刻意不用嵌套对象：设置补丁是浅合并（`{...current, ...patch}` + schema parse），
平铺字段的单字段提交不会重置其余字段。schema 默认档与上表一致，边界 1–50 / 1–100。

- **设置页**（`SessionTitleRefreshSetting`）：开关 + 两个滑条（拖动只更新本地草稿，
  pointerup / keyup / blur 才提交，避免拖动过程高频写盘）+ "当前规则"预览行。
- **PUSH（resident 会话热更新）**：设置变更经 `useSettings().update` →
  `zcodeAgentService.syncAppRuntimePreferences` → 协议方法
  `workspace/updateSessionTitleRefreshPreferences`（每 workspace 串行队列，排在
  interaction / modelIo 偏好之后）→ CLI handler 写进程级 `appRuntimePreferences.sessionTitleRefresh`
  + 遍历 resident session 调 `app.setSessionTitleRefreshConfig` 写入 runtime 属性。
  旧 CLI 不认识该方法时 host 按 method-not-found **降级忽略**。
- **PULL（冷恢复 / 新会话）**：`session/requestRuntimePreferences` 的返回新增
  `sessionTitleRefresh`（Host 从设置文件读），经 `resolveSessionStartupPreferences`
  注入 `runtimeConfig.sessionTitleRefresh` 作为初始档；旧 Host 缺席时回退进程级 PUSH 缓存，
  再退到默认档。跨窗口由 `APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL` 广播重放。
- **热更新语义**：写属性即生效，但**只影响后续轮次完成时的网格判断**——
  改参数/重启/恢复旧会话都不补跑历史（与上节规则同一约束）。

## 手动生成（重命名对话框）

- 重命名对话框新增「生成新标题」按钮：调用一次生成（不入库、不发事件），
  把候选标题返回给对话框**填入输入框**，由用户确认/编辑后按既有的重命名链路
  （custom 来源）保存。

## 标题生成模型（可选指定）

背景：标题走辅助调用档位（`auxiliaryModelOptions` 取该模型推理档位的最低项 + 输出上限），
部分模型（如 `opencode-go-responses/muse-spark`）不接受最低推理档，provider 直接 400
（`invalid_request`）。原解析只认「会话当前模型」，会让这类会话的所有标题生成静默失败。
允许显式指定标题模型即可绕开不兼容档位。

| 字段 | 默认 | 说明 |
|---|---|---|
| `modelSelection` | `null` | 标题生成模型；`null`/缺席 = 跟随会话当前模型 |

- **生效范围**：首轮标题生成、定期刷新、手动「生成新标题」**全部**使用它（单一解析点：
  `title-generation-sidecar.generateTitleCandidateImpl`）。
- **解析优先级**：标题设置里的 `modelSelection` → `config.titleGeneration.modelSelection`
  （TUI/显式注入）→ 会话当前模型。
- **存储与通道**：随既有的标题设置对象同行，不新增协议方法——
  `workspace/updateSessionTitleRefreshPreferences`（PUSH）+ `session/requestRuntimePreferences`
  （PULL）新增同名字段；设置落 `AppSettings.sessionTitleModelSelection`（单字段原子对象，
  替换式提交，不受浅合并影响）。
- **热更新语义**：与刷新参数一致——写属性即对**后续**标题生成生效，不补跑、不改已生成标题。
- **失败处理不变**：仍按上文的静默回退（保留旧标题 / 保留对话框原输入）。

## 验收场景

1. 第 3 个真实用户轮次完成后，标题被刷新（侧栏更新）；第 4–7 轮不刷新；第 8 轮再刷新。
2. 中途把 `firstRound` 从 5 改成 3：已过轮次不补跑，落到新网格（3、8、13…）时正常刷新。
3. 手动改过名的会话：自动刷新不覆盖；手动点「生成新标题」仍可生成候选交给用户保存。
4. 子代理会话：从不自动命名。
5. 生成失败：标题保持原样，不产生空标题、不报错打扰用户。