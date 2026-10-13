# 桌面宠物（Desktop Pet）

> 本地定制版新增能力（zcode-open）。格式契约跟随 **Codex pet packs** 公开标准
> （`legeling/awesome-codex-pet`，MIT —— 与 Mikiko / Codex 生态互通，宠物目录可互相拷贝）。
> 交互与状态映射参考 Mikiko 桌面版（1.1.1）实测行为。

## 目标与边界

- **目标**：桌面悬浮一只动画宠物，镜像本机 ZCode 会话状态（跑/等/急/看）；
  可拖动、可切换，宠物资产与 Codex/Mikiko 生态互通。
- **不做**：宠物自制生成（二期 create-pet 技能）、宠物市场 UI（二期）、气泡任务窗（二期）。
- 桌宠窗口不承载任何业务状态；它只是"会话状态 + 宠物资产"的渲染器。

## 格式契约（Codex pet packs）

- 宠物目录：`~/.zcode/v2/pets/<pet-id>/`（可直接放 Mikiko `~/.mikiko/v2/pets/` 拷来的宠物）
- 文件：`pet.json` + `spritesheet.webp`（目录名 = pet.json.id；spritesheetPath 必须为相对名，禁 `..`/绝对路径/反斜杠）
- 图集几何（网格必须精确覆盖，否则拒绝加载）：
  - v1：`1536×1872`，8 列 × 9 行，格 `192×208`，72 帧
  - v2：`1536×2288`，8 列 × 11 行，格 `192×208`，88 帧（第 9-10 行为 16 帧环视 `look`）
- v2 必须显式 `spriteVersionNumber: 2`；v1 可省略。
- 行 → 动画（默认表）：0 idle、1 running-right、2 running-left、3 waving(4帧/one-shot)、4 jumping(5帧/one-shot)、
  5 failed、6 waiting、7 running、8 review、9/10 look(v2)。
- 校验：帧数 ≤ 256、引用帧号在界内、idle 必须存在；运行期加载时做网格精确校验。
- 内置默认宠物：从 awesome-codex-pet 选取 **MIT 许可**的宠物资产随包分发（`packages/desktop/resources/pets/`），
  首次启用桌宠时自动复制到用户目录。

## 窗口规则（main 进程）

- `BrowserWindow`：`transparent, frame: false, resizable: false, hasShadow: false, focusable: false,
  skipTaskbar(非 macOS), visibleOnAllWorkspaces, show: false`；
  `setAlwaysOnTop(true, "screen-saver")`；尺寸 = 图集格 × 1.5 缩放（288×312 @ v1）。
- preload 独立最小面（`window.desktopPet`），`contextIsolation: true`，`nodeIntegration: false`。
- 精灵表通过自定义协议 `petpack://<pet-id>/spritesheet.webp` 加载（main 校验 pet-id 形状 + 只允许
  pet 目录内文件），CSP `img-src petpack:`。
- **不从属于应用主窗集合**：接入与 CUA 浮窗相同的排除逻辑（close-to-tray / 单实例聚焦 / last-window
  判断不得把桌宠当主窗）。
- 位置持久化：`desktopPetPosition: {x, y}`（AppSettings）；拖动结束（防抖）写回；
  启动/显示器变化时夹到可见工作区（`screen.getDisplayNearestPoint` + workArea）。
- 生命周期：设置开关切换时创建/销毁；`app` 退出时随主进程关闭。

## 状态所有权与映射（唯一所有者 = renderer 聚合器）

数据流（单一写入路径，main 只做转发不重新计算）：

```
renderer（useDesktopPetStateDriver，聚合本窗口所有会话）
   → IPC zcode:pet-state（渲染侧上报状态名）
   → main（desktopPetWindow 持有，转发 + 多窗口优先级汇总）
   → pet 窗口（preload onState 订阅）→ 动画控制器 play(state)
```

状态映射（语义与 Mikiko 一致；输入 = 任务元数据缓存 `taskMetaByEntityKey` 的
`status`（running/completed/error）+ 未读（`unreadAt`，叠加 `taskUnreadOverlayByEntityKey`
的乐观覆盖，null = 已读）：

| 条件（按优先级） | 状态 | 动画 |
|---|---|---|
| 有会话 `status = running` | `running` | 跑步 |
| 有会话 `status = error` 且未读 | `failed` | 难过 |
| 有会话 `status = completed` 且未读 | `review` | 检查（提示去看结果） |
| 其他未读 > 0 | `waiting` | 等待 |
| 以上皆无 | `idle` | 待机 |

- 多窗口：main 收多路上报，按同序优先级取最高（等价于把所有上报合并后重算）。

## IPC 面（PlatformChannels 集中登记）

| 频道 | 方向 | 说明 |
|---|---|---|
| `zcode:pet-get-active` | pet → main (invoke) | 取当前宠物 + 精灵表 URL + 初始状态 |
| `zcode:pet-state` | renderer → main (send) | 上报状态名（running/waiting/...） |
| `zcode:desktop-pet-state` | main → pet (push) | 状态下发（waving 为 one-shot，前端 3.2s 后回退） |
| `zcode:pet-drag-start` / `zcode:pet-drag-end` | pet → main | 拖动开始/结束（drag-end 返回 movedPx） |
| `zcode:desktop-pet-drag-direction` | main → pet (push) | 拖动方向动画名（running-left/right/running） |
| `zcode:pet-context-menu` | pet → main | 右键菜单（切换宠物/设置/隐藏） |
| `zcode:pet-open-app` | pet → main | 双击打开主窗口 |
| `zcode:pet-set-active` | 设置页 → main | 切换当前宠物（写 desktopPetId） |

## 设置项（AppSettings）

| 字段 | 默认 | 说明 |
|---|---|---|
| `desktopPetEnabled` | `false` | 桌宠总开关（默认关，避免打扰） |
| `desktopPetId` | 缺省 | 当前宠物 id；缺省 = 目录内第一个 |
| `desktopPetPosition` | 缺省 | `{x, y}`；缺省 = 主显示器右下角 |

## 交互规则（pet 窗口）

- 单击：waving 挥手 3.2s 后回退状态动画。
- 双击（400ms 内两次按下-释放且位移 ≤6px）：打开主窗口。
- 拖拽（位移 >6px）：pointer capture 期间 main 以 16ms 跟随光标 `setPosition` 移动窗口
  （全量 delta 相对起点，不累积漂移），方向变化时推方向动画；`drag-end` 返回累计位移
  供前端区分点击/拖拽，并持久化位置。
- 右键：main 弹出原生菜单（切换宠物子菜单 / 隐藏桌宠 / 打开 ZCode）。
- 空闲环视：idle 且 v2 图集时，每 20–40 秒随机播 `look` 一次。
- 渲染：canvas 2D、dpr 适配、16ms 帧循环；帧表使用图集默认表（每行动画的帧数与节拍内置）。

## 验收场景

1. 打开设置 → 常规区出现"桌面宠物"开关；打开后主显示器右下角出现宠物（idle 动画）。
2. 新建会话发消息期间宠物切 `running`（跑步）；会话失败产生未读 → `failed`；
   完成产生未读 → `review`；全部读完后回 `idle`。
3. 拖动宠物可移动，拖动中播行走/跑动画（水平分左右、垂直原地跑）；松手后位置被记住（重启仍在）。
4. 单击挥手；双击打开主窗；右键菜单可切换宠物（目录内多只时）、隐藏桌宠。
5. 把 Mikiko `~/.mikiko/v2/pets/` 下的宠物拷到 `~/.zcode/v2/pets/`：切换列表可见、可正常播放（格式互通）。
6. 关闭开关：窗口销毁；重开恢复上次宠物与位置。
7. 图集尺寸不符 / 缺 pet.json / id 不匹配目录的宠物：跳过并记日志，不影响其他宠物。

## 一期范围

- 窗口 + 渲染 + 交互（单击/双击/拖拽/右键）+ 本地目录 + 设置项（开关/切换）+ 状态联动 + 内置默认宠物（MIT）。
- 二期：市场 UI（对接 awesome-codex-pet catalog + SHA 校验安装）、气泡任务窗、create-pet 技能、v2 环视全覆盖。