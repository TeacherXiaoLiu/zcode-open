# 桌面宠物（Desktop Pet）

> 本地定制版新增能力（zcode-open）。格式契约跟随 **Codex pet packs** 公开标准
> （`legeling/awesome-codex-pet`，MIT —— 与 Mikiko / Codex 生态互通，宠物目录可互相拷贝）。
> 交互与状态映射参考 Mikiko 桌面版（1.1.1）实测行为。

## 目标与边界

- **目标**：桌面悬浮一只动画宠物，镜像本机 ZCode 会话状态（跑/等/急/看）；
  可拖动、可切换，宠物资产与 Codex/Mikiko 生态互通。
- **本轮不做**：宠物自制生成技能；市场及多来源导入纳入二期；可调大小与会话汇报气泡纳入三期。
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
  `setAlwaysOnTop(true, "screen-saver")`；尺寸 = 图集格 × `desktopPetScale`（默认 192×208 @ 1.0）。
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
| `desktopPetScale` | `1` | 窗口缩放（0.5–2.0）；尺寸 = 图集格 × scale |

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

1. 打开设置 → 基础设置下的独立「宠物」模块可启用桌宠；打开后主显示器右下角出现宠物。
2. 新建会话发消息期间宠物切 `running`（跑步）；会话失败产生未读 → `failed`；
   完成产生未读 → `review`；全部读完后回 `idle`。
3. 拖动宠物可移动，拖动中播行走/跑动画（水平分左右、垂直原地跑）；松手后位置被记住（重启仍在）。
4. 单击挥手；双击打开主窗；右键菜单可切换宠物（目录内多只时）、隐藏桌宠。
5. 把 Mikiko `~/.mikiko/v2/pets/` 下的宠物拷到 `~/.zcode/v2/pets/`：切换列表可见、可正常播放（格式互通）。
6. 关闭开关：窗口销毁；重开恢复上次宠物与位置。
7. 图集尺寸不符 / 缺 pet.json / id 不匹配目录的宠物：跳过并记日志，不影响其他宠物。

## 设置导航与二期页面

- 设置侧栏在「基础设置」组新增一级 `pets` section，与「常规 / 外观 / 模型设置」同级；仅 `platform.desktopPet` 可用的 Desktop 显示。
- 从「常规」移除桌宠卡，避免重复入口。Pets 首页负责启用开关、当前宠物卡（预览/名称/版本）和「管理宠物」入口。
- 管理视图由设置 section 内部状态持有；通过设置页 breadcrumb 表达「宠物 > 宠物管理」，返回 Pets 首页，不另建 URL 路由或第二份全局导航状态。
- 管理页分为「已安装」「宠物市场」「导入」三部分。卡片显示预览、名称、来源、版本、许可证；已安装项支持使用、删除，市场项支持搜索、分类、分页、预览、安装。

## 市场与导入

### 来源

- Codex：优先读取 `CODEX_HOME/pets`；未设置 `CODEX_HOME` 时尝试用户 home 下 `.codex/pets`。
- 其他 ZCode、Mikiko：提供来源快捷入口，并允许用户选择实际数据目录；不猜测其他实例的私有路径。
- 本地：支持选择单只宠物目录、包含多只宠物的根目录或宠物 ZIP。Main 使用原生选择器并负责读取；UI 不传任意路径给通用文件服务。
- 市场：固定对接 `https://github.com/legeling/awesome-codex-pet` 的公开 catalog 和安装清单；客户端固定 HTTPS base，安装请求只接受 pet id，不接受 UI 传入的 URL。

### 预检与确认

- 导入先扫描并生成短期 review token 和待导入摘要；UI 展示候选、来源、作者/许可证、无效项和重复 id。用户确认后才安装。
- 同 id 默认不覆盖；覆盖前显示现有项与候选项并要求确认。已启用的宠物不能直接删除，先切换到另一只。
- 操作由唯一的 Desktop main pet service 持有：目录扫描、市场网络 IO、校验、暂存、原子安装/覆盖/删除、provenance 和进度。设置 UI 只经 `DesktopPetPlatformPort` 调用。
- 安装进度事件带 `operationId`、阶段、宠物 id 和计数；UI 只接受当前操作的事件。页面切换不会隐式取消已接受操作；取消必须显式发给 Main。

### 安全与许可

- 仅提取/安装 `pet.json`、`spritesheet.webp` 和可选的来源 `submission.json`。拒绝路径穿越、绝对路径、反斜杠路径、符号链接、重复 ZIP 路径、特殊文件、加密 ZIP、超限文件数/展开体积。
- 安装前校验目录 id、manifest、固定图集文件名、实际 WebP 解码尺寸、v1/v2 图集几何；市场安装额外校验 install manifest 的 SHA-256 和字节数。先写 staging，全部校验成功后原子提交；失败回滚且不留下半成品。
- `awesome-codex-pet` 仓库代码为 MIT 不代表每只宠物资产都是 MIT。市场条目须从同一仓库 revision 的 `pets.json` 与 submission 元数据读取逐宠物许可证；保存来源类型、作者、原始许可证文本、来源 URL/ref、资产 SHA-256 和导入时间。未知许可证显示「未知」，不得推断为 MIT。
- 已安装预览使用 main 生成的受限 `petpack://<id>/spritesheet.webp`；市场预览从固定站点限长读取、检查 WebP 后缓存，通过 `petpack://market-preview/<id>/idle.webp` 显示。缺失预览显示占位，不阻塞安装；不允许 UI 加载 submission 中的任意预览 URL。

## 二期页面与导航

- 设置侧栏在「基础设置」组新增一级 `pets` section，与「常规 / 外观 / 模型设置」同级；仅 Desktop 平台显示。
- 从「常规」移除桌宠卡，避免重复入口。Pets 首页按参考图显示：启用开关、当前宠物名称/版本/预览、「管理宠物」按钮。
- 管理视图由 Pets section 内部状态持有；顶栏 breadcrumb 为「宠物 > 宠物管理」。管理页含「已安装」「宠物市场」和导入入口，延续截图中的卡片网格。

## 市场、导入与安全

- 市场 source 固定为 `https://github.com/legeling/awesome-codex-pet` 的 `pets.json` 和 `install-manifest.json`；market install 仅接受 pet id，main 构造固定 HTTPS 下载 URL，不接受 renderer 传入 URL。
- catalog 与 install manifest 必须来自同一固定 revision；每项按 `slug` join 元数据。单宠 license 来自 catalog / `submission.json`，仓库 MIT 不等于每只资产 MIT。许可保留原始文本、作者、来源 URL 和 revision；未知许可显示「未知」，不得推断为 MIT。
- 市场支持搜索、分类、分页；缺少预览资产时显示占位，不阻塞安装。预览只由 main 从固定来源限长读取并校验后提供，renderer 不加载 submission 中的任意 URL。
- 导入来源：Codex（`CODEX_HOME/pets`，未设置时 `~/.codex/pets`）、其他 ZCode/Mikiko 用户选择目录、本地单宠目录/宠物根目录、ZIP。
- Codex / 其他 ZCode / Mikiko 快捷入口仅定位候选目录；若自定义 home 或平台路径无法确定，转交原生目录选择器，不静默递归扫描 home。
- Main 执行扫描并生成短期 review token；UI 预览候选和重复 id，用户确认后再安装。review token 绑定发起窗口和预检时冻结的候选文件字节，五分钟过期、单次消费；renderer 不提交原始任意路径给通用文件服务。
- 只安装 `pet.json`、`spritesheet.webp` 和可选的 `submission.json`。拒绝绝对/越界路径、符号链接、重复 ZIP 路径、特殊文件、加密 ZIP、超限文件数/压缩与展开大小；校验 ID/目录名、固定文件名、WebP 实际解码尺寸及 v1/v2 几何。
- 市场另校验 install manifest 的 SHA-256 和字节数。安装先写 staging，全部校验通过后原子提交；失败回滚且不留半成品。同 ID 默认拒绝；显式确认后才覆盖。活动宠物不可直接删除，要求先切换。
- Main pet service 是目录、市场网络、导入预检、安装/覆盖/删除、provenance 和操作进度的唯一 owner；UI 只走 `DesktopPetPlatformPort`。操作进度带 operationId、阶段、宠物 id 与计数；切页不隐式取消，取消由显式命令完成。

## 二期验收场景

1. Desktop 设置侧栏「基础设置」中，宠物与常规/外观/模型设置同级；Web/手机不显示；常规页不再重复显示桌宠卡。
2. Pets 首页显示启用开关和当前宠物预览；「管理宠物」进入带 breadcrumb 的管理页；breadcrumb 返回 Pets 首页。
3. 已安装网格显示来源/许可证/版本，可切换并标记「使用中」；删除非活动宠物后列表刷新；活动宠物删除被阻止或要求先切换。
4. 市场可搜索、按分类筛选和分页；卡片显示作者与逐宠物许可；没有可验证预览时使用占位；安装显示真实阶段/进度。
5. 从 Codex、其他 ZCode、Mikiko 或本地目录/ZIP 导入时先预览候选；取消不改宠物目录；确认后安装；同 ID 覆盖需显式确认。
6. 恶意 ZIP 路径、符号链接、超限文件、坏 manifest、尺寸错误或 SHA 不符均拒绝；原安装保留，staging 清理。
7. CC BY-NC 明示非商业许可，缺失/不确定许可显示未知；不得把仓库许可误用为宠物资产许可。

## 缩放（三期）

- `desktopPetScale` 为唯一尺寸所有者：main 用「图集格 × scale」计算窗口尺寸，渲染器
  canvas 自适应整窗（无需改渲染逻辑）。范围 0.5–2.0，默认 1.0；越界或非有限值回落到默认。
- 设置页「宠物」首页提供大小滑条（50%–200%），拖动中只改本地草稿并显示目标尺寸文字，
  释放/键盘操作结束才提交（与标题刷新滑条同一模式，避免每步写盘 + 跨进程广播）。
- scale 变更走 `applySettings`：窗口 `setBounds` 换成新尺寸；以窗口**底部中心**为锚
  （宠物"站在地面"上，放大向上生长）；重定位后夹取到最近显示器工作区并持久化新位置。
- 缩放只在桌宠启用且窗口存在时生效；禁用状态下仅保存设置，下次启用按新尺寸创建窗口。

## 会话实时汇报气泡（三期）

- 独立的 `bubble` BrowserWindow：`transparent, frame: false, focusable: false, skipTaskbar,
  resizable: false`，并 `setIgnoreMouseEvents(true)`（纯展示，不挡桌面操作）；
  置顶与可见性规则同宠物窗口；随宠物窗口创建/销毁。
- 位置跟随宠物窗口：优先放在宠物**左侧**（默认宠物在屏幕右下角，气泡朝屏幕内侧），
  左侧空间不足时放右侧；垂直与宠物顶部对齐并夹取到工作区。拖动/缩放宠物时同步重定位。
- 显示规则：汇总活动非 `idle` 且有会话条目时显示，回到 `idle`（或空列表）时隐藏。
  气泡不承载交互（点击穿透），双击宠物打开主窗保持不变。
- 内容：**会话列表**，每条 = 状态色点 + 会话标题 + 最新助手回复摘要（一行，省略号截断）；
  右侧显示该条的状态文字（正在工作 / 等待查看 / 出错了 / 等待中）。
  最多 3 条，按 running → failed → review → waiting 排序、同优先级按活动时间倒序；
  窗口高度随条数自适应（main 在推送前按条数 setBounds，重新挂靠同一位置）。
  文案按主进程 locale 在气泡页内置 zh-CN/en-US 映射（不引入完整 i18n 框架）。
- 数据流（单一写入路径，扩展一期状态上报，不新增第二份会话状态）：

```
renderer（useDesktopPetStateDriver）
   ├─ 任务元数据缓存 taskMetaByEntityKey（status/未读/title/updatedAt）
   └─ 行内 sidecar __zcodeSessionActivity.assistantPreview
        （sessions-index 的 lastAssistantPreview ≤120 字，turn 收口时刷新；
         侧栏不消费，避免列表行随逐 token 流换引用）
   → IPC zcode:pet-state（上报 {state, sessions[]}）
   → main（按 reporter 保存活动，多窗口合并去重、取优先级最高状态，截断 3 条）
   → pet 窗口收 state（动画，语义不变）＋ bubble 窗口收 {state, sessions}
```

- 摘要语义：`lastAssistantPreview` 来自 sessions-index，**不是逐 token 流**——CLI 网关在
  turn 收口/非流式事件时刷新；运行中会话的"当前简要回答"以最近一个收口回合为准。
  未打开的会话只要其 workspace 在列表中被订阅，同样带摘要。
- 气泡初始值：bubble 窗口就绪后 `invoke zcode:pet-get-activity` 拉取当前汇总，之后走推送。

## 三期验收场景

1. 设置 → 宠物首页出现大小滑条；拖动时显示目标百分比/尺寸，释放后桌面宠物立即按新尺寸重绘，
   位置底部中心不跳变；重启后尺寸保留。
2. 滑条设为 200% 时窗口不超出工作区（越界被夹取）；50% 时宠物仍可点击、拖动、右键。
3. 多个会话同时运行时，气泡逐条列出每个会话（标题 + 最新助手回复摘要），最多 3 条；
   拖动宠物气泡跟随；条数变化时高度随之变化。
4. 会话完成产生未读：气泡列出该会话（等待查看）；读完/清空未读后条目消失、全部清空后隐藏。
5. 多窗口/多会话同时上报时按优先级合并去重；助手完成一轮回复后气泡摘要随 sessions-index 刷新。
6. 气泡不拦截鼠标：气泡覆盖区域可以正常点击下方窗口；气泡本身不可获得焦点。

## 范围

- **一期（已完成）**：窗口 + Canvas + 交互 + 本地目录 + 开关/切换 + 状态联动 + 内置 MIT 默认宠物。
- **二期（已完成）**：独立 Pets 设置 section + 首页/管理页 + 已安装/市场 + Codex/ZCode/Mikiko/本地目录/ZIP 导入 + provenance/许可 + 校验、原子安装、删除、操作进度。
- **三期（本规格）**：可调大小（`desktopPetScale` + 设置滑条 + 底部中心锚定缩放）与会话实时汇报气泡（独立穿透窗口，状态 + 会话标题）。
- **后续**：气泡消息摘要/进度细节、宠物气泡任务窗交互、create-pet 生成技能、市场收藏/下载统计，以及 v2 环视体验的视觉验收。