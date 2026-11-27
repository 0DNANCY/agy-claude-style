<div align="center">

<img src="assets/clawd-banner.svg" alt="AGY Claude Style — Clawd Mascot Banner" width="880" />

# 🦀✨ AGY Claude Style (`agy-claude-style`)

**让会眨眼、会摸鱼、还能被挠痒痒的像素小螃蟹 `Clawd` 陪你在 Google Antigravity 里写代码** `(๑•̀ㅂ•́)و✧`

为 **Google Antigravity**（Windows / macOS / Linux）打造的一体化界面重塑、多语言本地化与 Token HUD 遥测增强插件。<br/>
基于 Antigravity 内置 **Chrome DevTools Protocol（CDP）** 调试端口实现无损动态注入——**不改动任何原版安装文件**，支持热更新与一键无痕退潮还原 🌊

<p>
  <a href="#clawd-饲养指南"><img src="https://img.shields.io/badge/Clawd_Mascot-19_Animations-D97757?style=flat-square" alt="Clawd Mascot: 19 Animations" /></a>
  <a href="#快速开始"><img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-4D6BFE?style=flat-square" alt="Platform: Windows | macOS | Linux" /></a>
  <a href="#核心特性"><img src="https://img.shields.io/badge/Powertools-Control_Room_%2B_Plugin-9A77FF?style=flat-square" alt="Powertools: Control Room + Plugin" /></a>
  <a href="#核心特性"><img src="https://img.shields.io/badge/i18n-5_Languages-E2A45F?style=flat-square" alt="i18n: 5 Languages" /></a>
  <a href="#环境要求"><img src="https://img.shields.io/badge/Zero--Mod-CDP_Live_Inject-63C59A?style=flat-square" alt="Zero-Mod: CDP Live Inject" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-8FA4FF?style=flat-square" alt="License: MIT" /></a>
</p>

[✨ 核心特性](#核心特性) · [🧰 Powertools & 控制室](#powertools-控制室) · [🦀 Clawd 饲养指南](#clawd-饲养指南) · [🔄 运行模式](#运行模式对比) · [🚀 马上领养](#快速开始) · [⚙️ 配置调教](#配置说明) · [🗂️ 项目结构](#项目结构) · [💌 来源声明](#来源声明)

</div>

> [!NOTE]
> **来源与贡献致谢**：本项目灵感及部分源码来源于 [Nwflower/dsh-claude-style](https://github.com/Nwflower/dsh-claude-style)；Codex 思考强度滑杆样式来源于 [Microqian2th/dsh-codex-effort-slider](https://github.com/Microqian2th/dsh-codex-effort-slider)；梁武峰思考强度滑杆样式来源于 [mobius/dsh-performance-slider](https://github.com/mobius/dsh-performance-slider)。原生插件宿主、三页签控制室与 Powertools 效率套件源自 [@NoFires](https://github.com/0DNANCY/agy-claude-style/pull/19)，长对话布局性能优化源自 [@liuhaodongliu990-cmyk](https://github.com/0DNANCY/agy-claude-style/pull/21)。详见 [来源声明](#来源声明)。

---

<a id="目录"></a>
## 🗺️ 目录

- [✨ 核心特性](#核心特性)
  - [🧰 Powertools 效率套件 & 3 页签控制室 (`v2.2.0`)](#powertools-控制室)
  - [📢 阶段汇报提示词注入说明 (`stagePromptInjection`)](#阶段汇报提示词注入说明)
- [🦀 小螃蟹 Clawd 饲养指南](#clawd-饲养指南)
- [🎒 环境要求](#环境要求)
- [🚀 快速开始](#快速开始)
  - [🔄 运行模式对比：托管启动 vs 常驻守护 vs 原生插件](#运行模式对比)
  - [🪟 方式一：Windows 独立安装器（目标机器无需 Node.js）](#方式一windows-独立安装器目标机器无需-nodejs)
  - [🍎 方式二：macOS 独立应用（目标机器无需 Node.js）](#方式二macos-独立应用目标机器无需-nodejs)
  - [💻 方式三：Node.js 脚本模式（Windows / macOS / Linux）](#方式三nodejs-脚本模式windows--macos--linux)
  - [🔌 方式四：Antigravity 原生插件模式（Plugin Host + 右侧控制室面板）](#方式四antigravity-原生插件模式plugin-host--右侧控制室面板)
- [⚙️ 配置说明 (`config.json`)](#配置说明)
- [🗂️ 项目结构](#项目结构)
- [🧪 开发、测试与构建](#开发测试与构建)
- [💌 来源声明](#来源声明)
- [📜 开源协议](#开源协议)

---

<a id="核心特性"></a>
## ✨ 核心特性

### 🌌 1. Studio 首页、液态玻璃与会呼吸的字符波纹海
- **保留原生特征与主题配色**：首页顶部保留 Antigravity 原生拱形 Logo（支持 `accent` / `foreground` 配色切换），与问候语水平对齐；提供 `obsidian`（黑曜石蓝暗色）、`claude` 与 `host`（跟随宿主）三套调色板，自动适配深色与浅色主题 🎨。
- **液态玻璃 & 对话紧凑排版 (`glassEffect` / `compactChatLayout`)**：为浮窗、卡片、输入胶囊与菜单提供细腻的液态玻璃半透明磨砂质感；开启 `compactChatLayout` 可收窄对话气泡、工具卡片与标题行留白，一屏浏览更多内容。
- **实时字符矩阵波纹场 (`homeRipple`)**：在首页铺设等宽字母数字二维波动网格，带云雾漂移氛围效果；轻点空白处就像把小石子丢进字符星空，触发柔和的阻尼水波纹扩散动画 `~(˘▾˘~)`。
- **编程用量仪表盘 (`概览` / `模型` · `全部` / `30 天` / `7 天`)**：自动聚合本地对话轨迹并剔除子代理重复会话计数，展示 6 项核心指标（会话数、消息数、Token 总量、活跃天数、高峰时段、最常用模型）、`26×7` 周日历热力图、30d/7d 模型堆叠柱状图，以及**60+ 本经典著作 Token 折算标尺**——悄悄告诉你今天写的代码相当于读了几本《爱丽丝漫游奇境》或《哈利·波特》📖✨。

### ⌨️ 2. 极简重排输入框、丝滑光标与温柔侧栏
- **极简输入框 (`composerRestyle`)**：将工作区与环境选择胶囊重排为 `28px` 极简细边样式，底栏控件轻巧落于画布之上，支持 `studio` / `host` 提示占位风格（`placeholderStyle`）。
- **丝滑打字光标 (`smoothCaret`)**：为输入框渲染平滑插值位移动画光标（`.ag-cs-smooth-caret`），兼容多行换行与中文输入法（IME）候选输入态，并在输入框未聚焦时自动跳过布局测量，零强制同步重排（`Fixes #20`）🍫。
- **侧栏样式优化 (`sidebarRestyle` / `sidebarCompact`)**：统一侧边栏行高与悬停高亮板，支持开启更紧凑的条目间距。

### 🎚️ 3. 三风格交互式思考强度滑块 (`effortSliderStyle`)
点击模型名旁的思考强度徽章（`Low` / `Medium` / `High` / `XHigh` / `Max` 等级映射，精准匹配同上下文窗口档位如 `200k` / `1M` 并保留宿主 `Extra` 标识），弹出可视化推理档位滑块调节器：
- **Claude Code (`claude`)**：5 行动态矩阵噪声点阵、发光竖向胶囊滑块与 `effortAccent` 蓝紫渐变色阶。
- **ChatGPT Codex (`chatgpt`)**：蓝→紫渐变进度条、高档位星云扫光、星空粒子及阻尼刻度手感 ✨。
- **梁武峰 (`liangwufeng`)**：内置 31 帧 320×320 WebP 抠像人像背景，支持 `performanceBackdrop`（`card` 卡片内 / `page` 全窗口 / `off` 关闭）三种渲染模式。

### 📊 4. 贴心 Token HUD 与右下角电量小圆环
- **右下角剩余用量圆环 (`ringMode` / `quotaCycleMode`) & 低余量告警**：支持在**当前上下文剩余可用百分比 (`context`)** 与**模型配额剩余百分比 (`quota`)** 之间切换，支持 `quotaCycleMode`（`auto` 自动 / `5h` 5 小时配额 / `weekly` 周配额）按需查看；随剩余容量动态变色提示（🔵 `>30%` 元气满满 · 🟡 `≤30%` 注意补水 · 🔴 `≤10%` 快见底啦）；当上下文余量 **`≤20%`（黄色提醒）** 或 **`≤10%`（红色紧急告警）** 时，支持一键点击横幅或 `/compact` 向当前对话精准填入 `/compact`。
- **每轮对话 Token 徽章 (`turnBadges`)**：在每轮 AI 回复底部展示 `#T{n}` 模型名、上下文总量与本轮增量、输出与思考 Token、工具调用次数、子代理汇总、输出速率（`tok/s`）及缓存命中率。
- **4 标签页深度遥测浮窗**：支持上下文拆分、对话轮次、工具与子代理统计、模型配额池剩余百分比与 5h / 周重置倒计时 ⏳。
- **可选环绕式 HUD**：提供 `hudTopBar`、`hudBottomBar`、`hudRimProgress`（配合 `hudRimSource`: `auto` / `context` / `quota`）、`hudFooterChip`、`hudCompact` 五项可折叠增强开关，默认关闭，按需启用。

### 🦀 5. 像素螃蟹小跟班 `Clawd` (`mascot`)
- 在输入框右上角蹲着一只超有戏的像素小螃蟹 `Clawd`（内置 **19 套双层精灵图动画**），会跟着对话节奏在 `idle`、`thinking`、`typing`、`error`、`sleeping`、`waking` 等状态间切换，无聊了还会自己抱着小本本摸鱼或对你招手 👋。
- **礼貌满分**：当输入框上方出现排队消息、`/` 命令菜单或问答确认卡片时，Clawd 会自觉调整留白或悄悄躲起来，绝不遮挡发送、编辑、删除等按钮。

### 🌐 6. 5 语言全局切换 & 双入口设置实时同步
- **5 语言全局本地化 (`language`)**：支持 **简体中文 (`zh-CN`) / 繁體中文 (`zh-TW`) / 粵語 (`yue`) / English (`en`) / 日本語 (`ja`)** 实时切换，作用于 Antigravity 主界面、Plan / Orchestrator 编排模式、插件面板以及 **Swarm 蜂群侧栏 (`plugin://swarm--` OOPIF)**；自动跳过代码编辑器、终端、对话/帖子正文与 `data-ag-no-i18n` 保护区，移除插件时无损还原。
- **双入口实时同步**：同时保留 **Antigravity 原生 `设置 → 外观` 底部完整可视化设置组** 与 **右侧栏「控制室」页签**——无论你在哪一处修改设置，均通过校验与原子写入持久化到 `config.json`，并在 3-way 合并机制下即时双向同步生效。

---

<a id="powertools-控制室"></a>
### 🧰 7. Powertools 效率套件 & 右侧 3 页签控制室 (`v2.2.0`)

`v2.2.0` 新增模块化效率增强套件 (`features/*.js`) 与独立侧栏控制室 (`sidecars/panel/`)：

- **⏳ 时间旅行撤销 (`rewindPanel` / `doubleEscRewind`)**：支持在输入框连按两次 `Esc` 呼出快捷回退条，或点击历史消息原生 `Undo` 按钮打开「**对话 + 代码 / 仅恢复对话 / 仅恢复代码 / 取消**」确认面板（支持 `undoConfirmMode`: `picker` / `auto-conversation` / `auto-both`），自动异步加载代码 diff 预览并完整保留 Lexical 编辑器中的换行、缩进与文件引用。
- **🌿 对话分叉与原地编辑 (`branchSession` / `messageEdit`)**：
  - 在任意助手回复工具栏一键**从此处分叉会话**（调用 `forkConversation` 并保留工作区，新开分支尝试不同方案）；
  - 双击或点击用户消息的编辑按钮即可**原地编辑并重发**，自动回退轨迹到对应步骤。
- **📎 文件链接右键菜单 (`fileContextMenu`)**：点击对话里的文件/路径引用直接弹出操作菜单——「本地打开 / 在访达或资源管理器定位 / 复制完整路径 / 用已检测的外部编辑器或终端打开（自动携带 `:行:列` 跳转参数）/ 作为 `@引用` 插入当前输入框」，内置 UNC 网络路径与 Windows `.cmd` 敏感字符拦截。
- **📋 任务进度浮动卡片 (`taskProgressCard`)**：自动汇总当前任务的工具执行步骤、Markdown `- [x]` 清单完成度、重试原因分类（EOF / 超时 / 限流 / 上游繁忙 / 区域受限）与实时等待计时，支持自由拖拽悬浮位置或停靠在顶部。
- **📌 扩展坞快捷固定 (`headerExtensionsBar` / `sidebarExtensionsSection`)**：将常用扩展侧栏固定在顶部标题栏或左侧边栏快捷开关。
- **🔔 窗口后台未读提醒 (`windowUnreadTitle`) & 关闭隐藏托盘 (`hideOnClose`)**：对话在后台等待审批或完成时自动更新窗口标题角标，聚焦后清除或继续跟踪其余后台会话；点击关闭按钮时支持最小化隐藏而非直接杀进程。
- **📂 阶段自动折叠与进度汇报 (`stageCollapse` & `stagePromptInjection`)**：在长任务多轮执行过程中自动把阶段更新与中间工具组折叠收纳，完成回合默认收起为原生可展开组件；是否向模型追加进度汇报提示词可由 `stagePromptInjection` 单独控制（详见下方透明说明）。
- **🎛️ 侧栏 3 页签控制室 (`sidecars/panel/`)**（通过原生插件模式或控制面板访问）：
  - **仪表盘 (Dashboard)**：本地 + SSH 远程 JSONL 流式遥测统计、53 周贡献日历热力图、缓存骤降异常检测、模型健康度时间线与 TTFT / Streaming TPS 分离分析、LiteLLM 官方参考定价同步与 5 小时 / 周配额追踪。
  - **控制室 (Control)**：一站式调节全量视觉样式、HUD、Powertools、阶段提示词注入开关与代理参数。
  - **远程与代理 (Remote & Proxy)**：SSH 远端工作站历史轨迹汇总（支持 `~/.ssh/config` 主机发现），以及面向 Windows 非 TUN 代理环境的独立代理配置与冷启动告警。

<a id="阶段汇报提示词注入说明"></a>
> [!WARNING]
> **透明机制说明：关于「阶段汇报提示词注入（`stagePromptInjection`）」**
>
> 为了配合 **阶段自动折叠（`stageCollapse`）** 让模型在长任务执行期间输出结构化中间进度，本插件内置了可选的 `agy_cs_stage_updates` 系统提示词附加机制。**从 `v2.2.0` 起，UI 折叠与提示词注入已严格解耦：**
> - **`stageCollapse`（默认 `true` 开启）**：仅负责前端渲染层——实时内联展示阶段日志并在回合完成后自动折叠归档工具与阶段分组，**不会改动任何发送给模型的提示词**。
> - **`stagePromptInjection`（默认 `false` 关闭）**：只有当你**主动开启**此开关时，插件才会 Hook Antigravity 发送管线并将 `noToolExplanation`/`noToolSummary` 设为 `false`，同时在 `CascadeConfig.plannerConfig.promptSectionCustomizationConfig.appendPromptSections` 末尾追加如下英文提示段（标题为 `agy_cs_stage_updates`）：
>   ```text
>   During this task, communicate brief visible progress updates in the user-facing response alongside tool calls. Before the first substantial tool action, write one concise sentence explaining the immediate next action and its purpose. After a meaningful finding, change of direction, or a few execution steps, write one or two concise sentences stating the result and next action. These are intermediate updates, not final answers: continue executing the task after each update. Do not narrate every command. Do not put updates only in private thinking, tool summaries, task artifacts, or notify_user. Use the user language. Never invent progress or expose private reasoning.
>   ```
> - **Token 与缓存提示**：注入上述约 100 词规则会略微增加每次请求的输入上下文与输出阶段文本；仅建议在希望模型按阶段汇报长任务进展时开启，平时保持默认关闭即可获得零额外 Token 开销。你可以在 **`设置 → 外观`** 或 **侧栏「控制室」** 中随时开关，也可直接从 `config.json` 移除。

---

<a id="clawd-饲养指南"></a>
## 🦀 小螃蟹 Clawd 饲养指南

Clawd 是由 [crab-assets.js](crab-assets.js) 与 [mascot-core.js](mascot-core.js) 驱动的双层像素小生命，住在你的输入框右上角 🏡：

<div align="center">
  <img src="assets/clawd-moods.svg" alt="Clawd 5 Iconic Pixel Moods" width="880" />
</div>

### 🎮 怎么和 Clawd 互动？（彩蛋全收录）

| 互动方式 | 触发方法 | Clawd 的反应 |
| --- | --- | --- |
| 👉 **轻戳小钳子** | 单击 Clawd 的左半边或右半边身体 | 害羞扭头给你看不同方向的小动作 (`poke-left` / `poke-right`) |
| 🤭 **疯狂挠痒痒** | `450ms` 内快速连点 Clawd **4 下** | 触发爆笑踢腿大反应 (`tickle`)，眼睛笑成 `^ ^`！ |
| 🤏 **拎起来晃一晃** | 按住鼠标左键拖拽 Clawd | 进入悬空手舞足蹈模式 (`drag`)，松手才乖乖落地 |
| 💤 **挂机小憩** | 对话安静超过 **60 秒** | 自动缩成一团进入 `sleeping` 呼呼模式，点一下或发消息立刻伸懒腰 `waking` |
| 🎉 **任务报喜** | AI 回复完成或出现错误时 | 成功了开心蹦跶 (`happy`)，出错了也会陪你慌张一下 (`error`) |

<details>
<summary>🎀 <b>点此展开：偷看 Clawd 的全部 19 套双层精灵图档案</b></summary>

- **日常发呆 & 随机彩蛋**：`idle`（待机呼吸）、`idle-look`（左顾右盼）、`idle-wave`（举钳打招呼）、`idle-laptop`（抱着迷你笔记本敲代码）
- **认真营业中**：`thinking`（托腮冒气泡思考）、`typing`（哒哒哒飞速打字）、`building`（敲敲打打搞建设）、`compacting`（打包整理上下文）、`music`（戴上小耳机听歌）、`conducting`（挥舞指挥棒）
- **心情与睡眠**：`happy`（撒花蹦跶）、`notification`（来新消息啦）、`error`（哎呀报错了）、`sleeping`（冒着 `Zzz` 睡觉）、`waking`（睡醒伸懒腰）
- **玩家互动专属**：`poke-left`（被戳左边）、`poke-right`（被戳右边）、`tickle`（怕痒爆笑）、`drag`（被拎起来晃）

</details>

---

<a id="环境要求"></a>
## 🎒 环境要求

- **Google Antigravity Desktop**：运行中且开启了内置 CDP 调试端口（插件会自动读取系统用户目录下的 `Antigravity/DevToolsActivePort` 文件，也可通过环境变量 `AG_CDP_PORT` 或安装器 `--cdp-port` 参数显式指定端口）：
  - Windows：`%APPDATA%\Antigravity\DevToolsActivePort`
  - macOS：`~/Library/Application Support/Antigravity/DevToolsActivePort`
  - Linux：`${XDG_CONFIG_HOME:-~/.config}/Antigravity/DevToolsActivePort`

> [!IMPORTANT]
> **Antigravity 2.33.0+ 启动说明**：从 `2.33.0` 起，Antigravity 不再默认生成 `DevToolsActivePort`，需附加 `--remote-debugging-port=0` 启动参数：
> - **macOS**：推荐使用安装器生成的 `Antigravity (AGY Claude Style).app`、`launch-antigravity.command`，或在脚本模式运行 `npm run managed` / `./launch.sh --relaunch`（自动附加 `--remote-debugging-port=0` 启动或温和重启，并拉起随宿主退出 watcher）。也可手动 `open -a Antigravity --args --remote-debugging-port=0`。
> - **Windows**：推荐使用安装器创建的桌面 / 开始菜单「`Antigravity (AGY Claude Style)`」快捷方式（`Antigravity (AGY Claude Style).lnk`），或在脚本模式运行 `npm run managed` / `launch.bat --relaunch`（自动附加 `--remote-debugging-port=0` 启动或温和重启，并拉起随宿主退出 watcher）。
> - **默认自动接管**：默认启用 `"autoRelaunchWithCdp": true`，在**托管一键启动**（原生快捷方式 / `.app` / `.command` / `npm run managed`）与**常驻守护**模式下，检测到 Antigravity 已运行但未开启 CDP（且未携带 `--remote-debugging-port` 启动参数）时都会自动温和重启一次并附加调试参数；如需关闭可在 `config.json` 中设为 `false`。

> [!TIP]
> **Windows 非 TUN / 进程级代理环境使用提示**（对 TUN 或直连用户零影响）：
> - **方式 A（推荐 · 控制室内置独立代理）**：直接在右侧 `Claude Studio / Claude Style` 控制室面板开启「独立代理」，插件重启时会自动注入 `--proxy-server`、`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`、`GODEBUG=http2client=0` 与 `NODE_USE_ENV_PROXY=1`。
> - **方式 B（外部进程级代理启动器，如 `antigravity-proxy-fix` / `Antigravity-Proxy.cmd`）**：
>   - 建议在启动脚本中添加 `set NODE_USE_ENV_PROXY=1` 与 `set NO_PROXY=localhost,127.0.0.1,::1`（让 Node 原生 `fetch()` 同样走代理且本地 CDP 直连），并在启动 `Antigravity.exe` 时附带 `%*` 以透传 `--remote-debugging-port=0`；
>   - 插件执行带调试端口重启时会自动保留现有进程上的 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / `NODE_USE_ENV_PROXY` 等变量；
>   - 如希望「带调试端口重启」或托管启动器始终通过你的自定义代理脚本拉起，可设置环境变量 `AGY_CLAUDE_STYLE_LAUNCH_CMD` 指向该脚本路径（支持 `.exe` / `.cmd` / `.bat` / `.ps1`）。
- **Node.js >= 22**（仅脚本模式、测试与从源码构建安装器需要）：项目零第三方 npm 依赖，直接使用 Node.js 内置的 `fetch`、`WebSocket` 与 `node:test`。
- **.NET Framework 4.x (`csc.exe`)**（仅在 Windows 上从源码构建独立安装包时需要，Windows 10/11 系统默认自带）。
- **Xcode Command Line Tools (`swiftc`)**（仅在 macOS 上从源码构建 `.app` / `.dmg` 时需要，macOS 安装命令行工具后自带）。

---

<a id="快速开始"></a>
## 🚀 快速开始

> [!TIP]
> **开箱即用**：不想自己编译？可直接前往仓库 [Releases](https://github.com/0DNANCY/agy-claude-style/releases) 下载 GitHub Actions 自动编译发布的 `AGY-Claude-Style-v<version>-Windows-x64.exe`（Windows）或 `AGY-Claude-Style-v<version>-macOS-universal.dmg`（macOS Universal，支持 Apple Silicon 与 Intel），目标机器无需安装 Node.js！

<a id="运行模式对比"></a>
### 🔄 运行模式对比：托管启动 vs 常驻守护 vs 原生插件

AGY Claude Style 提供四种使用方式与三种核心运行形态。平时推荐 **托管启动模式**（独立安装器默认，0 后台常驻），也可一键切换 **常驻守护模式**，或通过 **方式四：Antigravity 原生插件** 直接在右侧栏挂载 **3 页签控制室** 面板：

| 对比维度 | 🦀 托管启动模式（免后台常驻 · **推荐默认**） | 🛰️ 常驻守护模式（开机自启 · 兼容原习惯） | 🔌 原生插件模式（Plugin Host + 控制室侧栏） |
| --- | --- | --- | --- |
| **开机/启动方式** | ❌ 不注册开机自启，随插件专属入口拉起 | ✅ 注册开机自启（Windows Startup / macOS `LaunchAgent`） | 🧩 随 Antigravity 插件宿主自动拉起，退出时自动清理 |
| **平时后台驻留** | **0 进程常驻**（关闭宿主后自动退出） | 1 个轻量原生守护进程在后台持续监听 | 随插件宿主生命周期托管（无需单独维护后台常驻服务） |
| **日常入口** | Windows「`Antigravity (AGY Claude Style)`」快捷方式 / macOS `.app` 或 `.command` / `npm run managed` | 直接点击系统原版 Antigravity 桌面或程序坞图标 | Antigravity 插件管理器加载本地仓库或安装包，侧栏挂载 `3 页签控制室` |
| **CDP 启动与接管** | 自动附加 `--remote-debugging-port=0` 启动或温和重启，并拉起 `--exit-on-host-close` watcher | 后台持续监听 CDP；发现未开 CDP 实例且 `autoRelaunchWithCdp: true` 时自动温和重启 | 若宿主已开启 CDP（或配置 `--remote-debugging-port=0` 启动），插件宿主自动拉起 `inject.js --watch` 与独立控制室 HTTP 服务 |
| **关闭后行为与宽限保护** | 全部窗口关闭后自动退出（内置 **90 秒启动宽限保护**） | 持续后台待命（除非在 `config.json` 手动设置 `"exitOnHostClose": true`） | 宿主断开标准输入 / 停止插件时，子进程触发干净注销与回退还原 |

> [!NOTE]
> **零侵入安全原则与自由切换**：
> - 各种模式均严格遵守**零修改 Antigravity 安装目录文件**、**不使用 DLL 劫持或 IFEO 映像劫持**、**零安全误报**的原则。
> - 安装后可**随时重新运行安装器**（在界面直接切换模式，或传入 `--mode=managed` / `--mode=daemon`）在托管与常驻模式间自由切换；从常驻守护切回托管启动时，安装器会自动卸载并删除开机自启项、停止原常驻后台进程。

---

<a id="方式一windows-独立安装器目标机器无需-nodejs"></a>
### 🪟 方式一：Windows 独立安装器（目标机器无需 Node.js）

1. 直接从 [Releases](https://github.com/0DNANCY/agy-claude-style/releases) 下载 `AGY-Claude-Style-v2.2.0-Windows-x64.exe`（对应版本），或在已安装 Node.js >= 22 的 Windows 环境克隆仓库从源码构建：
   ```bash
   git clone https://github.com/0DNANCY/agy-claude-style.git
   cd agy-claude-style
   npm run build:installer
   ```
   构建完成后会在项目根目录生成带有像素螃蟹图标的单文件 `AGY-Claude-Style-v<version>-Windows-x64.exe` 🦀。

2. 双击运行 `AGY-Claude-Style-v<version>-Windows-x64.exe`（可分发到未安装 Node.js 的 Windows 电脑直接运行）：
   - **GUI 模式选择**：安装器界面提供运行模式切换单选框——**「免后台常驻 · 随 Antigravity 启动并自动退出（推荐）」**（托管启动模式）与**「开机自启 · 后台常驻监听」**（常驻守护模式），并可勾选**「在桌面创建「`Antigravity (AGY Claude Style)`」启动快捷方式」**（默认勾选）。选择后点击「开始安装」（已安装时显示「应用模式 / 升级」）即可安装或无损切换模式。
   - **资源部署与配置保留**：自动检测本机 Antigravity Desktop，将独立运行环境与插件资源（含 `features/*.js` 与 `sidecar-core.js`）部署至 `%LOCALAPPDATA%\agy-claude-style`（记录模式状态至 `.install-mode`；若已存在 `config.json` 则自动保留原有用户配置）。
   - **统一托管启动快捷方式 (`Antigravity (AGY Claude Style).lnk`)**：安装器会在安装目录、开始菜单（及可选桌面）生成 `Antigravity (AGY Claude Style).lnk`，直接指向 `agy-claude-style-watcher.exe --launch --relaunch --exit-on-host-close --dir "<installDir>"`。双击即可带 CDP 启动（或温和重启接管）Antigravity，并在宿主关闭后自动退出 watcher。
   - **两种模式行为**：
     - **托管启动模式（默认）**：不注册 Windows Startup 开机自启（若此前安装过常驻模式，会自动清理 `AGY-Claude-Style.lnk` 并停止旧常驻守护）；安装完成时仅在检测到 Antigravity 已开启 CDP 端口的情况下才临时拉起 `--exit-on-host-close` watcher 完成注入，否则保持后台 0 进程常驻。
     - **常驻守护模式**：额外注册 Windows 开机自启快捷方式（`Startup\AGY-Claude-Style.lnk`）并立即启动后台静默守护进程 `agy-claude-style-watcher.exe` 持续监听。
   - **卸载还原**：两种模式均会注册 Windows「设置 → 应用」卸载项；在安装器界面点击「卸载并恢复原版」或在系统「设置 → 应用」中卸载，可自动停止守护、删除 Startup / 开始菜单 / 桌面快捷方式并恢复原生界面。

3. 安装器支持的命令行参数：
   ```text
   AGY-Claude-Style-v2.2.0-Windows-x64.exe [--silent | /S | -s] [--uninstall] [--status]
                                           [--mode=managed | --mode=daemon | --managed | --daemon]
                                           [--desktop-shortcut | --no-desktop-shortcut]
                                           [--no-autostart] [--no-kill-legacy]
                                           [--install-dir <路径>] [--cdp-port <端口>]
                                           [--out <结果JSON路径>] [--popup]
   ```
   - `--mode=managed` / `--managed`：以托管启动模式安装或切换（默认模式，不写入 Startup 自启）。
   - `--mode=daemon` / `--daemon`：以常驻守护模式安装或切换（写入 Startup 开机自启并常驻后台）。
   - `--desktop-shortcut` / `--no-desktop-shortcut`：控制是否在桌面创建 `Antigravity (AGY Claude Style).lnk` 启动快捷方式（默认创建）。
   - `--no-autostart`：跳过 Startup、开始菜单、桌面快捷方式及卸载注册表写入（未显式传 `--mode` 时按 `managed` 模式处理）。

---

<a id="方式二macos-独立应用目标机器无需-nodejs"></a>
### 🍎 方式二：macOS 独立应用（目标机器无需 Node.js）

1. 直接从 [Releases](https://github.com/0DNANCY/agy-claude-style/releases) 下载 `AGY-Claude-Style-v2.2.0-macOS-universal.dmg`（对应版本），或在已安装 Node.js >= 22 与 Xcode Command Line Tools 的 macOS 环境从源码构建：
   ```bash
   git clone https://github.com/0DNANCY/agy-claude-style.git
   cd agy-claude-style
   npm run build:macos
   ```
   构建完成后会在项目根目录生成通用架构（`arm64` + `x86_64`）的 `AGY Claude Style.app` 与 `AGY-Claude-Style-v<version>-macOS-universal.dmg` 🦀。

2. 打开 `.dmg`，将 `AGY Claude Style.app` 拖入「应用程序」（或直接双击运行）：
   - 若首次打开时 macOS 提示“无法验证开发者”（Release 构建采用 Ad-hoc 签名），请**右键点击 `AGY Claude Style.app` → 打开**，或在终端执行 `xattr -cr "/Applications/AGY Claude Style.app"`。
   - **GUI 模式选择**：打开 `AGY Claude Style.app` 后，可在界面选择运行模式——**「免后台常驻 · 随 Antigravity 启动并自动退出（推荐）」**（托管启动模式）或**「开机自启 · 后台常驻监听」**（常驻守护模式），并勾选**「在 `~/Applications` 创建「`Antigravity (AGY Claude Style).app`」启动器」**（默认勾选），然后点击「开始安装」（已安装时显示「应用模式 / 升级」）。
   - **资源部署与托管启动入口**：自动检测本机 `Antigravity.app`，将独立运行时与嵌套插件资源（含 `features/*.js` 与 `sidecar-core.js`）递归部署至 `~/Library/Application Support/agy-claude-style`（升级时自动保留已有 `config.json`，并写入 `.install-mode`），同时生成两个托管启动入口：
     - **`Antigravity (AGY Claude Style).app`**：生成在安装目录与 `~/Applications/`（默认），点击后在后台脱离启动 `agy-claude-style-watcher --launch --relaunch --exit-on-host-close --dir "<installDir>"`，自动附加 CDP 参数启动或温和重启 Antigravity 并在宿主关闭后自动退出。
     - **`launch-antigravity.command`**：位于安装目录 `~/Library/Application Support/agy-claude-style/launch-antigravity.command`，内部同样调用上述托管启动命令并在后台脱离运行，方便在访达或终端中直接启动。
   - **两种模式行为**：
     - **托管启动模式（默认）**：**不注册 `LaunchAgent`**（若此前存在 `~/Library/LaunchAgents/io.github.0dnancy.agy-claude-style.plist` 会自动 unload 并删除），平时后台 0 进程常驻；日常通过 `Antigravity (AGY Claude Style).app` 或 `launch-antigravity.command` 启动即可。
     - **常驻守护模式**：注册 `LaunchAgent`（`~/Library/LaunchAgents/io.github.0dnancy.agy-claude-style.plist`）实现登录自启，并立即启动原生 Swift 后台守护进程 `agy-claude-style-watcher` 实时注入及热更新。
   - **卸载还原**：重新打开 `AGY Claude Style.app` 点击「卸载并恢复原版」，即可自动停止守护、卸载并删除 `LaunchAgent`、清理 `~/Applications/Antigravity (AGY Claude Style).app` 与安装目录并恢复原版界面。

3. 安装器支持的命令行参数：
   ```text
   "/Applications/AGY Claude Style.app/Contents/MacOS/AGY Claude Style" \
     [--silent | /S | -s] [--uninstall] [--status] \
     [--mode=managed | --mode=daemon | --managed | --daemon] \
     [--app-launcher | --no-app-launcher] \
     [--no-autostart] [--no-kill-legacy] \
     [--install-dir <路径>] [--cdp-port <端口>] \
     [--out <结果JSON路径>] [--popup]
   ```
   - `--mode=managed` / `--managed`：以托管启动模式安装或切换（默认模式，不注册 `LaunchAgent`）。
   - `--mode=daemon` / `--daemon`：以常驻守护模式安装或切换（写入 `LaunchAgent` 登录自启并常驻后台）。
   - `--app-launcher` / `--no-app-launcher`：控制是否在 `~/Applications` 创建 `Antigravity (AGY Claude Style).app` 启动器（默认创建）。
   - `--no-autostart`：跳过 `LaunchAgent` 与 `~/Applications` 启动器写入（未显式传 `--mode` 时按 `managed` 模式处理）。

---

<a id="方式三nodejs-脚本模式windows--macos--linux"></a>
### 💻 方式三：Node.js 脚本模式（Windows / macOS / Linux）

1. 克隆仓库并准备配置文件（可选，若不创建 `config.json` 将自动使用内置默认配置）：
   ```bash
   git clone https://github.com/0DNANCY/agy-claude-style.git
   cd agy-claude-style
   cp config.example.json config.json
   ```

2. 按操作系统选择对应启动方式：

   - **Windows**：
     - `launch.bat [--relaunch] [--daemon]`：
       - **默认托管模式**（不带 `--daemon`）：调用 `node inject.js --launch` 以 `--remote-debugging-port=0` 启动 Antigravity（若已运行且未开 CDP，需附带 `--relaunch` 才会温和重启，或直接改用 `npm run managed` 按配置自动接管），并通过 `watch-hidden.vbs` 无黑框拉起带 `--watch --exit-on-host-close --skip-if-running` 的 watcher；宿主关闭后自动退出（含 90 秒启动宽限保护），平时不留常驻后台进程。
       - **常驻守护模式**（`launch.bat --daemon`）：通过 `watch-hidden.vbs --watch --replace` 启动常驻后台守护进程（不随宿主关闭自动退出）。
       - **`watch-hidden.vbs` 参数转发**：支持将传入的命令行参数原样转发给 `node inject.js`；不传参数直接运行（如 `watch.bat` / `autostart-on.bat`）时默认回退为 `--watch --replace`。
     - `npm run managed`：跨平台等价于 `node inject.js --managed`（即 `--launch --watch --exit-on-host-close`），一条命令完成带 CDP 启动/接管与随宿主退出监听（`npm run launch` / `npm run relaunch` 则仅执行单次带 CDP 启动/重启 `node inject.js --launch [--relaunch]`）。
     - `watch.bat`（或 `npm run watch`）：无黑框后台启动常驻守护进程（`watch-hidden.vbs` 默认 `--watch --replace`），持续检测并注入新窗口/重载页面，并在 `style.css`、`*.js`、`config.json` 变动时自动热更新。日志输出至 `watch.log`。
     - `inject.bat`（或 `npm run inject`）：单次立即注入当前所有 Antigravity 窗口（窗口刷新后失效）。
     - `remove.bat`（或 `npm run remove`）：停止后台守护进程并无损清除所有注入节点与属性，恢复原生界面。
     - `autostart-on.bat` / `autostart-off.bat`：为当前脚本目录开启或取消 Windows 开机自启（通过 `watch-hidden.vbs` 启动常驻守护）。

   - **macOS / Linux**：
     ```bash
     chmod +x *.sh
     ./launch.sh              # 默认托管模式：以绝对路径 "$PWD/inject.js" 带 CDP 启动 Antigravity 并拉起 --watch --exit-on-host-close --skip-if-running（关闭宿主后自动退出，含 PID 归属校验去重）
     ./launch.sh --relaunch   # 若 Antigravity 已运行但未开 CDP，自动温和重启后再接管
     ./launch.sh --daemon     # 常驻守护模式：以绝对路径 "$PWD/inject.js" 拉起 --watch --replace 后台常驻监听
     npm run managed          # 跨平台一站式托管启动（等价于 node inject.js --managed）
     ./watch.sh               # 以绝对路径启动常驻后台守护（nohup node "$PWD/inject.js" --watch --replace）
     ./inject.sh              # 单次注入
     ./remove.sh              # 停止守护（Fail-Closed 校验 PID 归属）并恢复原生界面
     ```

> [!TIP]
> 只是想先尝鲜看看小螃蟹？先运行一次 `npm run inject` 就能立刻在 Antigravity 里看到 Clawd；平时推荐使用 `npm run managed`（或 `launch.bat` / `./launch.sh`）免常驻随开随用，随时想恢复原貌只需 `npm run remove`，干干净净不留痕迹 `(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧`

---

<a id="方式四antigravity-原生插件模式plugin-host--右侧控制室面板"></a>
### 🔌 方式四：Antigravity 原生插件模式（Plugin Host + 右侧控制室面板）

从 `v2.2.0` 起，仓库根目录包含完整的原生插件清单 [plugin.json](plugin.json)、极简零工具 MCP 宿主 [plugin/mcp-host.js](plugin/mcp-host.js) 与侧栏面板清单 [sidecars/panel/sidecar.json](sidecars/panel/sidecar.json)，可直接作为 Antigravity 原生插件加载：

1. 确保本机已安装 **Node.js >= 22** 并在本地克隆（或下载解压）本仓库：
   ```bash
   git clone https://github.com/0DNANCY/agy-claude-style.git
   ```
2. 在 Antigravity Desktop 的 **插件管理（Plugins / Add Local Plugin）** 中添加该仓库目录（含 `plugin.json`），启用后 Antigravity 将自动拉起：
   - **MCP 生命周期宿主 (`node plugin/mcp-host.js`)**：随宿主开启自动拉起并托管 `inject.js --watch`，并在宿主退出时干净退出且恢复原版 DOM；
   - **独立控制室侧栏 (`sidecars/panel/main.mjs`)**：仅监听 `127.0.0.1` 随机端口并挂载到右侧 Aux Pane（标题为 `Claude Studio`），提供「仪表盘 / 控制室 / 远程与代理」三大页签。
3. **环境变量自定义**：如需指定非默认数据目录或关闭/控制宿主自动注入，可配置 `AGY_PLUGIN_DATA_DIR` 或 `AG_CDP_PORT`（注意 Antigravity 2.33.0+ 仍需带 `--remote-debugging-port=0` 或通过控制室一键重连重启生效）。

> [!NOTE]
> **原生插件与独立安装器的关系**：当前 Antigravity Desktop 主界面的主题样式、Clawd 挂件与 Powertools 交互仍通过内置 **CDP 无损运行时注入** 实现；原生插件模式为你提供了一键加载与右侧独立 3 页签控制室面板，可独立使用，也可与独立安装器 / 脚本模式共享同一份 `config.json` 配置。

---

<a id="配置说明"></a>
## ⚙️ 配置说明 (`config.json`)

所有配置均可在 Antigravity **`设置 → 外观`** 底部与 **右侧栏「控制室」页签** 中实时可视化调整并双向同步，也可以直接编辑 `config.json`（监听进程会自动执行 `<2KB` 轻量配置热更新）。默认完整键值定义见 [cdp.js](cdp.js) 中的 `DEFAULT_CONFIG`，常用配置模板见 [config.example.json](config.example.json)。

### 🎨 视觉、首页、HUD 与推理配置

| 配置键 | 可选值 / 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `language` | `'zh-CN'` \| `'zh-TW'` \| `'yue'` \| `'en'` \| `'ja'` | `'zh-CN'` | 🌐 全局界面与控制室面板语言（简中/繁中/粤语/英文/日语） |
| `palette` | `'obsidian'` \| `'claude'` \| `'host'` | `'obsidian'` | 🎨 配色方案（黑曜石蓝暗色 / Claude / 跟随宿主） |
| `glassEffect` | `boolean` | `true` | 🫧 为浮窗、卡片、输入胶囊与弹出菜单启用液态玻璃磨砂质感 |
| `homeLayout` | `'studio'` \| `'classic'` \| `'off'` | `'studio'` | 🏠 新会话首页布局模式 |
| `homeRipple` | `boolean` | `true` | 🌊 首页交互式字符矩阵波纹背景 |
| `composerRestyle` | `boolean` | `true` | 💊 极简胶囊工作区栏与输入框重排 |
| `mascot` | `'crab'` \| `'off'` | `'crab'` | 🦀 输入框右上角像素螃蟹挂件 `Clawd` |
| `logoInk` | `'accent'` \| `'foreground'` | `'accent'` | ✒️ 首页 Antigravity Logo 线条色调 |
| `inlineStats` | `boolean` | `true` | 🍩 启用内嵌会话统计与右下角剩余用量圆环 |
| `ringMode` | `'context'` \| `'quota'` | `'context'` | 🔋 右下角圆环显示上下文剩余或模型配额剩余 |
| `quotaCycleMode` | `'auto'` \| `'5h'` \| `'weekly'` | `'auto'` | ⏳ 配额展示周期切换（自动择低 / 5 小时配额 / 周配额） |
| `turnBadges` | `boolean` | `true` | 🏷️ 对话流每轮 AI 回复底部显示 Token 徽章 |
| `hudTopBar` | `boolean` | `false` | 📏 输入框顶部上下文进度条 |
| `hudBottomBar` | `boolean` | `false` | 📊 输入框底部详细 HUD 遥测栏（开启后同步拉取展示模型配额余量） |
| `hudRimProgress` | `boolean` | `false` | 🌈 输入框边框环绕进度条 |
| `hudRimSource` | `'auto'` \| `'context'` \| `'quota'` | `'auto'` | 🎯 边框进度条数据源（跟随圆环 / 上下文 / 配额） |
| `hudFooterChip` | `boolean` | `false` | 💠 底栏剩余容量标签胶囊 |
| `hudCompact` | `boolean` | `false` | 🧩 Token HUD 紧凑排版模式 |
| `effortSliderStyle` | `'claude'` \| `'chatgpt'` \| `'liangwufeng'` | `'claude'` | 🎚️ 思考强度滑块浮窗风格 |
| `effortAccent` | `boolean` | `true` | 💜 Claude 模式下启用蓝紫思考强度色阶 |
| `performanceBackdrop` | `'card'` \| `'page'` \| `'off'` | `'card'` | 🖼️ 梁武峰模式下 31 帧人像背景渲染范围 |
| `smoothCaret` | `boolean` | `true` | ✨ 输入框丝滑插值打字光标（未获焦时零布局读取） |
| `sidebarRestyle` | `boolean` | `true` | 📑 侧边栏 Claude 风格行高与悬停高亮 |
| `sidebarCompact` | `boolean` | `false` | 📏 侧边栏紧凑间距模式 |
| `compactChatLayout` | `boolean` | `false` | 🗜️ 对话消息、卡片与标题行紧凑排版 |
| `placeholderStyle` | `'studio'` \| `'host'` | `'studio'` | 💬 输入框占位提示文本风格 |

### 🧰 Powertools、代理、SSH 与守护配置

| 配置键 | 可选值 / 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `stageCollapse` | `boolean` | `true` | 📂 渲染层自动内联阶段进度并在回合结束后默认折叠收纳 |
| `stagePromptInjection` | `boolean` | `false` | 📢 是否向发送请求追加 `agy_cs_stage_updates` 阶段汇报提示词规则（默认关闭；详见 [透明说明](#阶段汇报提示词注入说明)） |
| `windowUnreadTitle` | `boolean` | `true` | 🔔 后台会话待审批或新回复完成时更新窗口标题未读计数角标 |
| `rewindPanel` | `boolean` | `true` | ⏳ 开启时间旅行回退条与原生 Undo 确认拦截（含 `双击 Esc` 回退） |
| `undoConfirmMode` | `'picker'` \| `'auto-conversation'` \| `'auto-both'` | `'picker'` | 🧭 Undo 确认交互策略（弹窗选择 / 自动仅恢复对话 / 自动恢复对话+代码） |
| `branchSession` | `boolean` | `true` | 🌿 在助手回复工具栏显示「从此处分叉对话」按钮 |
| `messageEdit` | `boolean` | `true` | ✏️ 支持双击或点击按钮就地编辑历史用户消息并分叉重发 |
| `fileContextMenu` | `boolean` | `true` | 📎 点击对话中的文件/路径引用弹出快捷操作与外部应用打开菜单 |
| `taskProgressCard` | `boolean` | `true` | 📋 在会话中展示可拖拽/停靠的浮动任务步骤与清单进度卡片 |
| `headerExtensionsBar` | `boolean` | `true` | 📌 在顶部标题栏固定展示常用扩展侧栏快捷按钮 |
| `sidebarExtensionsSection` | `boolean` | `true` | 🧭 在左侧导航栏展示「已安装扩展」折叠分组 |
| `pinnedHeaderExtensions` | `string[]` | `[]` | 📍 固定到顶栏的扩展 ID 列表 |
| `pinnedSidebarExtensions` | `string[]` | `[]` | 📂 固定到侧栏扩展区的扩展 ID 列表 |
| `sidebarExtensionsExpanded` | `boolean` | `false` | 🔽 左侧栏扩展分组是否默认展开 |
| `hideOnClose` | `boolean` | `true` | 🫥 点击窗口关闭按钮时隐藏窗口而非直接退出应用 |
| `sshRemoteStats` | `boolean` | `false` | 🖥️ 在侧栏仪表盘聚合远端 SSH 工作站的 JSONL 遥测统计 |
| `sshHost` | `string` | `''` | 🌐 `~/.ssh/config` 主机别名或安全格式主机名 |
| `proxyEnabled` | `boolean` | `false` | 🛡️ 为 Antigravity 启动/重启链路启用独立非 TUN 进程代理环境变量 |
| `proxyUrl` | `string` | `''` | 🔗 本地代理地址（如 `http://127.0.0.1:7890`） |
| `proxyBypass` | `string` | `'localhost,127.0.0.1,::1'` | 🚦 不走代理的地址列表（始终保留本机回环地址以保护 CDP 连通） |
| `proxyForceHttp1` | `boolean` | `true` | 🔌 注入 `GODEBUG=http2client=0` 避免部分代理链路下的 HTTP/2 断流 |
| `proxyColdStartAlert` | `boolean` | `true` | 🚨 代理未就绪导致连接异常时给出冷启动提醒 |
| `autoRelaunchWithCdp` | `boolean` | `true` | 🔄 Antigravity 2.33.0+ 运行中未开 CDP 时自动温和重启并附加 `--remote-debugging-port=0` |
| `exitOnHostClose` | `boolean` | `false` | 🛑 常驻守护在已注入的 Antigravity 宿主全部关闭后是否自动退出（托管模式会通过 `--exit-on-host-close` 强制开启） |
| `pollIntervalMs` | `integer`（`250`–`60000`，UI 下限 `1000`） | `2500` | ⏱️ UI 遥测轮询间隔（毫秒） |

> [!NOTE]
> **关于 `exitOnHostClose` 与托管启动模式的行为区别**：
> - **托管启动模式**（Windows `Antigravity (AGY Claude Style).lnk`、macOS `.app` / `launch-antigravity.command`、`launch.bat` / `./launch.sh` / `npm run managed`）：watcher 启动时会显式携带 `--exit-on-host-close`（或 `--managed`），**即使 `config.json` 中 `exitOnHostClose` 为 `false`，也会在 Antigravity 全部窗口及进程关闭后自动退出**，并启用 **90 秒启动宽限保护**（`--startup-grace`）防止宿主启动失败或中途关闭时孤儿进程挂起。
> - **常驻守护模式**（直接运行 `node inject.js --watch` / `launch.bat --daemon` / `./launch.sh --daemon` / 安装器 `daemon` 模式）：默认 `exitOnHostClose: false` 会保持后台常驻；如果你手动在 `config.json` 中将其改为 `true`，守护进程只会在**至少成功注入过一次窗口且之后所有宿主全部关闭**时退出，不会在开机等待 Antigravity 打开期间因启动宽限超时提前退出。

### 🛡️ 热更新、配置合并与守护进程安全机制
- **轻量 `<2KB` 配置热更新**：当仅 `config.json` 变动（或通过设置面板/控制室调整开关）且 `style.css` 与运行时脚本哈希未变时，Node.js 与 Windows/macOS 原生监听进程均仅向页面下发不足 `2KB` 的配置刷新脚本（保留整包启动脚本并独立更新配置脚本），避免重复注入整包运行时与样式表。
- **原子写入与 3-Way 配置合并**：通过设置面板、控制室或安装器保存修改时，先校验字段合法性再通过临时文件重命名**原子写入** `config.json`，防止并发写入损坏；前端加载时将前后 `config.json` 快照与 `localStorage` 本地状态执行 **3-way 合并**，仅将外部实际修改过的键值覆盖到当前界面，完整保留你本地调整过的其他 UI 偏好。
- **Fail-Closed PID 归属校验**：启动、停止（`remove.js` / 安装器卸载）或替换（`--replace`）监听进程时，均校验 `.watch.pid` 对应进程的命令行、可执行文件与目标目录归属——仅终止确认属于本目录的 `--watch` / `--managed` 或原生 watcher；失效或确认属于其他程序的 PID 仅清理锁文件而不误杀；当进程信息无法检查或相对路径无法验证归属时执行 **Fail-Closed 拒绝策略**，绝不误杀未知进程或盲目覆写/删除 `.watch.pid`。

---

<a id="项目结构"></a>
## 🗂️ 项目结构

```text
agy-claude-style/
├── .github/workflows/                 # GitHub Actions CI 测试与自动构建发布 Release 工作流
│   ├── _build-and-test.yml            # 共享可复用工作流（统一版本解析、跨平台测试与产物命名）
│   ├── ci.yml                         # PR / main 分支跨平台测试与编译验证
│   └── release.yml                    # 推送 v* 标签或手动触发自动发布 Windows/macOS 安装包
├── CHANGELOG.md                       # 版本变更日志（Release 工作流自动抽取对应版本说明）
├── plugin.json                        # Antigravity 原生插件清单（MCP 宿主 + sidecars/panel 控制室）
├── assets/                            # README 可爱像素螃蟹 Clawd 视觉插图资源
├── cdp.js                             # CDP 客户端、配置校验/原子写入、PID 归属校验、注入/轻量刷新表达式与 ensureAntigravityWithCdp 启动协调
├── inject.js                          # 单次注入、--managed 托管启动与 --watch 热更新监听进程（含 <2KB 配置刷新与设置/文件操作绑定）
├── remove.js                          # 校验 PID 归属后停止守护/监听进程并清理恢复原生界面
├── config.example.json                # 默认配置文件模板（与 DEFAULT_CONFIG 同步）
├── style.css                          # 全套主题调色板、液态玻璃、首页 Studio、HUD、Powertools 与滑块样式
├── ui-runtime.js                      # 主运行时：Store/Fiber 桥接、首页仪表盘、HUD 浮窗、设置面板集成与 features 编排
├── ui-rewind.js                       # 时间旅行撤销控制器（两步安全回退、异步 Diff 预览、Lexical 无损恢复）
├── features/                          # Powertools 模块化功能套件（v2.2.0）
│   ├── branch-edit.js                 # 对话分叉（forkConversation）与历史消息双击原地编辑
│   ├── extensions-dock.js             # 顶部/侧栏扩展坞快捷固定与弹出菜单
│   ├── file-menu.js                   # 对话文件引用操作菜单、外部应用跳转与 @引用插入
│   ├── hide-on-close.js               # 关闭窗口拦截最小化隐藏（Win / macOS / Linux）
│   ├── stage-collapse.js              # 阶段汇报内联/完成折叠与可选 agy_cs_stage_updates 提示词注入
│   ├── task-progress.js               # 浮动/停靠任务进度卡片、清单进度与等待计时
│   └── unread-title.js                # 窗口后台未读徽章与多标签状态分类
├── plugin/                            # Antigravity 原生插件宿主运行环境
│   ├── mcp-host.js                    # 零工具轻量 MCP stdio 宿主（跟随 IDE 生命周期）
│   └── host-lifecycle.js              # 插件宿主启停协调与子进程托管（inject.js + sidecars/panel）
├── sidecars/panel/                    # 原生 Aux Pane 3 页签控制室（v2.2.0）
│   ├── sidecar.json                   # 侧栏 Aux Pane 注册清单
│   ├── main.mjs                       # 回环 HTTP/API 服务与 LSP/CDP/代理协调（Fail-Closed Host/Origin 校验）
│   ├── index.html                     # 3 页签控制室前端框架（仪表盘 / 控制室 / 远程与代理）
│   ├── lib/                           # 流式 JSONL 遥测、LiteLLM 定价、配额追踪、SSH 遥测、文件操作、独立代理
│   └── ui/                            # control-tab.js / dashboard-tab.js / remote-tab.js / panel.css
├── i18n-core.js                       # 5 语言 DOM 翻译引擎（含保护区与无损还原）
├── i18n-locales.js                    # 简中 / 繁中 / 粤语 / 英文 / 日语多语言词典（含 Swarm、Plan 与 Powertools）
├── sidecar-core.js                    # Swarm 侧栏精简翻译运行时（跳过主样式注入并保护帖子/成员正文）
├── usage-core.js                      # 会话轨迹解析、Token 拆分、配额池与周期匹配、热力图与书籍标尺计算
├── effort-core.js                     # 推理档位与上下文窗口后缀解析、阻尼刻度数学模型与 3 套滑块逻辑
├── mascot-core.js                     # 像素螃蟹 Clawd 状态机（休眠、唤醒、反应、状态优先级）
├── ripple-core.js                     # 首页字符矩阵噪声与二维水波方程求解器
├── crab-assets.js                     # 内置 19 套像素螃蟹双层精灵图（body + ink PNG Data URI）
├── perf-assets.js                     # 内置 31 帧 320×320 WebP 人像序列
├── installer/                         # Windows (C#) 与 macOS (Swift) 独立安装器及原生托管/守护进程源码
│   ├── common/
│   │   ├── CdpClient.cs               # C# 轻量 CDP 客户端、窗口控制、启动协调与配置热更新同步
│   │   └── MiniJson.cs                # 零依赖 JSON 解析与序列化
│   ├── setup/
│   │   ├── Program.cs                 # Windows 安装/托管与常驻模式切换/升级/卸载 GUI 与 CLI 入口
│   │   └── app.manifest               # Windows DPI 与清单配置
│   ├── watcher/
│   │   └── Program.cs                 # Windows 无窗 CDP 托管启动器、文件快捷动作宿主与后台守护进程
│   └── macos/
│       ├── Common/                    # Swift 零依赖 JSON 解析与 URLSession WebSocket CDP 客户端 / 启动协调
│       ├── Setup/main.swift           # macOS Cocoa GUI / 递归 payload 部署 / LaunchAgent 安装与卸载入口
│       └── Watcher/main.swift         # macOS 原生 CDP 托管启动器、文件快捷动作宿主与后台守护进程
├── scripts/
│   ├── build-common.mjs               # 共享构建工具（图标生成、含 features/*.js 清单、ZIP 打包）
│   ├── build-installer.mjs            # 编译生成 Windows 独立 AGY-Claude-Style-v<version>-Windows-x64.exe
│   └── build-macos.mjs                # 编译生成 macOS Universal .app 与 .dmg
├── test/                              # 基于 node:test 的单元测试与安装器 E2E 测试套件
├── launch.bat / launch.sh             # 带 CDP 参数启动 Antigravity（默认托管模式随宿主退出，加 --daemon 切换常驻）
├── watch.bat / watch.sh               # 常驻后台守护启动脚本（watch.sh 使用 "$PWD/inject.js" 绝对路径）
├── watch-hidden.vbs                   # Windows 无黑框隐藏启动封装（透传参数给 inject.js，无参默认 --watch --replace）
├── inject.bat / inject.sh             # 单次注入脚本
├── remove.bat / remove.sh             # 停止监听/守护与还原脚本
└── autostart-on.bat / autostart-off.bat # Windows 开机自启快捷方式管理脚本
```

---

<a id="开发测试与构建"></a>
## 🧪 开发、测试与构建

```bash
# 运行全部单元测试与对应平台的安装器端到端测试（Node.js >= 22）
npm test

# 在 Windows 上从源码编译生成独立 AGY-Claude-Style-v<version>-Windows-x64.exe
npm run build:installer

# 在 macOS 上从源码编译生成 Universal .app 与 AGY-Claude-Style-v<version>-macOS-universal.dmg
npm run build:macos

# 运行单次注入 / 托管启动 / 常驻监听 / 卸载还原
npm run inject
npm run managed
npm run watch
npm run remove
```

### 🚀 自动构建与发布 Release

仓库已配置 GitHub Actions 工作流（[_build-and-test.yml](.github/workflows/_build-and-test.yml)、[release.yml](.github/workflows/release.yml) 与 [ci.yml](.github/workflows/ci.yml)）：
- **推送版本标签自动发布**：推送形如 `v2.2.0` 的标签（`git tag v2.2.0 && git push origin v2.2.0`），会自动在 `ubuntu-latest`、`windows-latest` 与 `macos-latest` 上完成测试、编译 `AGY-Claude-Style-v2.2.0-Windows-x64.exe` 与 `AGY-Claude-Style-v2.2.0-macOS-universal.dmg`（附带 `SHA256SUMS.txt`）并自动创建 GitHub Release（同时抽取 [CHANGELOG.md](CHANGELOG.md) 对应版本日志）。
- **手动触发**：也可以在 GitHub 仓库 **Actions → Release → Run workflow** 手动触发编译并发布。

测试套件包含对注入包语法、模拟 DOM 挂载/无损卸载（含未聚焦编辑器零强制重排验证）、5 语言翻译引擎、思考强度滑块数学模型、用量统计与配额匹配、二维波纹场、螃蟹状态机、Powertools 套件、3 页签控制室与遥测安全防护，以及 Windows `installer.exe` 与 macOS `.app` 编译/静默安装/CDP 注入/设置同步热更新/保留配置升级/卸载清理全流程的自动化验证。

---

<a id="来源声明"></a>
## 💌 来源声明

本项目在设计与实现过程中参考、借鉴或整合了以下开源项目与社区贡献者代码，特此声明并致谢 🌸：

- **项目灵感来源及部分源码来源**：[https://github.com/Nwflower/dsh-claude-style](https://github.com/Nwflower/dsh-claude-style)
- **Codex 思考强度滑杆样式**：[https://github.com/Microqian2th/dsh-codex-effort-slider](https://github.com/Microqian2th/dsh-codex-effort-slider)
- **梁武峰思考强度滑杆样式**：[https://github.com/mobius/dsh-performance-slider](https://github.com/mobius/dsh-performance-slider)
- **社区 PR 贡献致谢**：
  - [@zhyan0603](https://github.com/zhyan0603)（[PR #13](https://github.com/0DNANCY/agy-claude-style/pull/13)：PID 归属校验与 `<2KB` 配置热更新）
  - [@NoFires](https://github.com/NoFires)（[PR #19](https://github.com/0DNANCY/agy-claude-style/pull/19)：原生插件宿主、三页签控制室与 Powertools 效率套件初始实现）
  - [@liuhaodongliu990-cmyk](https://github.com/liuhaodongliu990-cmyk)（[PR #21](https://github.com/0DNANCY/agy-claude-style/pull/21)：消除打开长对话时的强制布局读取性能瓶颈）

---

<a id="开源协议"></a>
## 📜 开源协议

本项目中由项目维护者与开源贡献者编写的代码均基于 [MIT License](LICENSE) 开源。

<div align="center">

```text
      ╭───────────────────────────────────╮
      │  "What's up next? Let's ship it!" │
      ╰─────────────────┬─────────────────╯
                 ████████████████
                 ██▀▀████████▀▀██
             ████████████████████████
                 ████████████████
                 ██ ██      ██ ██
```

<sub>愿每一行代码都有小螃蟹默默陪你加油 `(っ˘ω˘ς ) ☕️` · 喜欢的话欢迎点亮右上角 ⭐ Star！</sub>

</div>
