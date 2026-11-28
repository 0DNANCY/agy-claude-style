# Changelog

All notable changes to **AGY Claude Style (`agy-claude-style`)** are documented in this file.

## [v4.1.0] - 2026-11-28

`v4.1.0` 新增 **插件内在线检查更新与热重载升级、控制室极简重构与外置联动跳转、动态壁纸首页字符波纹透明度/全量还原默认设置、上下文模型名完整展示**，同时修复自签回环端口 / TUN 代理导致的控制室 `HTTP 500`，并将 GitHub Actions 精简为纯源码极速打包工作流。

### 🔄 在线检查更新、一键热升级与遗留清理
- **全端检查更新与零停机升级（`sidecars/panel/lib/updater.mjs`）**：
  - 在控制室顶部与原生 **「设置 → 外观」** 面板及 CLI（`npm run check-update` / `npm run update`）提供版本检测与一键在线更新，内置 6 小时静默缓存（`autoCheckUpdate`）与竞速多源探测（GitHub API / Release 重定向 / jsDelivr + TUN/代理直连回退），超时上限压缩至 `4.5s` 内。
  - 采用纯 Node PKZIP 安全解压（校验 CRC32、拦截 Zip-Slip 与解压炸弹），自动保留 `config.json` 与 `wallpapers/` 目录；升级完成后触发 Antigravity Language Server 热重载并注入更新后脚本。
- **升级清理旧版外置程序与废弃文件**：
  - 自动清理旧版安装遗留的 Windows 卸载器 `agy-claude-style-uninstaller.exe`、旧版独立目录、旧版 watcher/快捷方式/注册表及 macOS `LaunchAgent`，并依据新版压缩包清单修剪插件目录内残留的过时文件；同时自动终止占用 `.watch.pid` 的陈旧独立 `mcp-host.js` 进程并支持 `inject.js` 磁盘变更热重载。

### 🎛 控制室重构、壁纸波纹控制与一键还原
- **单行精简顶栏与 5 类导航**：控制室重排为极简头部（低频操作收进 `⋯` 菜单）+ 5 个分类胶囊（`🎨 主题` / `🎬 壁纸` / `🎛 交互` / `📊 HUD` / `⚡ 效率`），壁纸关闭时自动折叠衍生滑块；原生 **「设置 → 外观」** 缺失功能区新增一键跳转按钮（直达对应控制室模块并高亮脉冲提示）。
- **动态壁纸波纹透明度（`wpRippleOpacity`）与全量恢复默认**：
  - 启用动态壁纸时可自由调节首页字符矩阵波纹不透明度（`0%–100%`，默认推荐 `35%`；设为 `0%` 时彻底卸载波纹画布释放 GPU/CPU）。
  - 在控制室与「设置 → 外观」同步提供二次确认 **「↺ 恢复默认」**，一键重置 `config.json` 与全窗口 `localStorage` 本地覆盖项。

### 🛠 稳定性与界面修复
- **修复控制室 `HTTP 500` 与 TUN 代理兼容**：重构 `plugin/host-lifecycle.js` / `plugin/mcp-host.js` 的回环 `/healthz` 探针为原生 `http/https` 直连并放行回环自签 TLS 证书，在 `sidecar.json` 中显式配置 `NO_PROXY` 白名单，彻底消除 Antigravity 自签 HTTPS 端口引发的 Sidecar 频繁重启与网关 `500`。
- **完整显示上下文浮窗模型名称**：将 `.ag-cs-ctx-popover` 顶部重排为双行结构，使模型徽章独占整行宽度，完整呈现如 `Gemini 4 Hydrogen (High)` 的模型全称。

### ⚙️ 精简纯源码 CI / Release 工作流
- 删除冗余的 `_build-and-test.yml` 与 Windows/macOS 多系统矩阵，将 `ci.yml` 与 `release.yml` 统一收敛为单台 `ubuntu-latest` 直接校验并打包纯源码 `agy-claude-style-v<version>.zip` + `SHA256SUMS.txt`；Action 升级至 `@v6`、`scripts/build-package.mjs` 支持同步写入打包版本号，并修复普通正式版 Release 被误标为 `prerelease` 的问题。

---

## [v4.0.0] - 2026-11-28

`v4.0.0` 为重大架构与视觉体验升级版本：**全面弃用 `.exe` / `.dmg` 二进制安装器并切换为零依赖一串命令极速部署体系**，同时新增 **主题高度自定义工作坊（6 套新双态预设 + 8 项核心令牌实时调色）** 与 **本地视频/图片动态壁纸系统**（基于最新 `main` 整合 Rewind 主题令牌修复 #27）。

### 💥 Breaking Changes & 迁移指南
- **全面移除二进制安装器**：彻底删除 `installer/`（Windows C# `.exe` 与 macOS Swift `.app`/`.dmg` 源码）、`scripts/build-installer.mjs`、`scripts/build-macos.mjs` 及对应的二进制打包测试；不再在 GitHub Release 发布 `.exe` 或 `.dmg`。
- **老用户无损平滑升级**：通过新版 `install.ps1` / `install.sh` 一键安装或升级时，自动保留 `~/.gemini/antigravity/plugin_data/agy-claude-style/config.json` 与 `wallpapers/` 目录，自动迁移旧版遗留配置（并剔除已废弃的 `exitOnHostClose`），同时清理旧版 Windows `HKCU\...\Uninstall\AgyClaudeStyle` 注册表项、`agy-claude-style-uninstaller.exe`、旧版 `agy-claude-style-watcher`、快捷方式与 macOS `LaunchAgent` 残留。

### ⚡ 一串命令极速部署 & 跨平台 CLI
- **零外部依赖一键脚本（无需 Git / 无需外部 Node.js）**：
  - **Windows (PowerShell)**：`install.ps1` 支持 `irm https://raw.githubusercontent.com/0DNANCY/agy-claude-style/main/install.ps1 | iex` 一键安装/升级，以及传入 `-Uninstall` / `-Status` / `-Version` / `-ArchivePath` 参数；兼容 PowerShell 5.1+ 与 PowerShell 7+，自动通过运行中的 Antigravity Language Server (`JetboxWriteState` / `DeletePlugin`) 热启用或热卸载。
  - **macOS / Linux (Bash / Zsh)**：`install.sh` 支持 `curl -fsSL https://raw.githubusercontent.com/0DNANCY/agy-claude-style/main/install.sh | bash` 一键安装/升级及 `--uninstall` / `--status` 参数。
- **跨平台 Node CLI & 轻量归档打包**：
  - 新增 `scripts/cli.mjs`（支持 `npm run setup`、`npm run status`、`npm run uninstall` 与 `bin` 入口 `agy-claude-style`）及 `scripts/build-package.mjs`（`npm run build:package`）。
  - 精简 `scripts/build-common.mjs`（移除 `.ico`/`.icns` 像素编码器），GitHub Actions 工作流（`.github/workflows/_build-and-test.yml` 与 `release.yml`）改为跨三平台验证后发布单一轻量归档包 `agy-claude-style-v4.0.0.zip` + `SHA256SUMS.txt`。

### 🎨 主题高度自定义方案（`features/theme-engine.js`）
- **新增 6 套精选双态（暗/亮）预设**：除 `obsidian`、`claude`、`host` 外，新增 `nord`（Nord 极夜）、`catppuccin`、`rosepine`（Rosé Pine）、`tokyo`（Tokyo Night）、`dracula` 与 `emerald`（翠影暗绿），每套预设均具备完整暗色与亮色双态色板。
- **8 项核心色彩令牌实时定制（`palette = 'custom'`）**：
  - 在右侧 `Claude Style` 控制室新增 **「主题调色工作坊」**（色板速选条、取色器 + `#RRGGBB` 输入框、明暗底色切换 `auto`/`dark`/`light`、从预设吸色与重置），并在原生「设置 → 外观」同步提供全部预设选项。
  - 支持定制 `accent`（主强调色）、`canvas`（主画布）、`sidebar`（侧栏）、`composer`（输入框）、`bubble`（消息气泡）、`fg`（主文字）、`mutedFg`（次文字）与 `border`（边框线），通过色彩混合算法自动推导 40+ 衍生宿主/Onyx/VS Code CSS 变量、首页 ASCII 波纹水波色与 4 档思考强度色阶。
  - 严格校验 `customTheme` 结构与 6 位十六进制色值，拦截一切非 hex CSS 注入载荷；满载配置仍严格保持 `<2KB` 轻量热更新预算。

### 🎬 本地动态壁纸系统（`wallpaper-server.js` + `features/wallpaper.js`）
- **本地视频与图片媒体库**：
  - 支持在控制室点击选文件、拖拽分片上传（512KB/片，单文件上限 128MB）或输入本机路径秒级导入，支持 `.mp4`、`.webm`、`.gif`、`.webp`、`.png`、`.jpg`/`.jpeg`。
  - 媒体文件独立持久化至 `~/.gemini/antigravity/plugin_data/agy-claude-style/wallpapers/`（`sidecars/panel/lib/wallpaper-store.mjs`），执行扩展名 + 文件头 Magic Bytes 双重校验，绝不占用 `config.json` 热更新载荷体积。
- **双模式渲染、流媒体穿透与失焦省电**：
  - 支持 `wpMode` 切换 `off`（关闭）、`global`（全局窗口背景，对话画布/侧栏/输入框以 `color-mix` 按 `wpSurfaceAlpha` 半透明穿透）与 `home`（仅欢迎首页背景，可与字符波纹叠加）。
  - `inject.js` 集成绑定于 `127.0.0.1:0` 的随机 128-bit Token HTTP `206 Partial Content` `Range` 流媒体服务，前端实现 `vscode-file:` / 回环 Range HTTP / CDP `__wallpaperRead` 分片 Blob 三重弹性加载。
  - 控制室提供壁纸不透明度（`wpOpacity`）、高斯模糊（`wpBlur`）、可读性压暗/柔亮遮罩（`wpDim`）、全局面板透光度（`wpSurfaceAlpha`）、视频倍速（`wpRate`）与 **失焦/隐藏自动暂停省电（`wpPauseBlur`）** 开关；停用或卸载插件时无痕清理全部 DOM、样式变量与 `ObjectURL`。

### 🧪 自动化测试扩充
- 新增 `test/cli-install.test.mjs`（覆盖 `scripts/cli.mjs`、`install.ps1`、`install.sh` 沙盒端到端安装/迁移/保留壁纸升级/状态查询/卸载清理及归档打包校验）与 `test/theme-wallpaper.test.mjs`（覆盖新预设、`customTheme` 校验防注入、满载配置 `<2KB` 热更新、Magic Bytes 校验、HTTP `206 Range` 流服务、双模式 DOM 挂载与失焦暂停/恢复）。
- 同步更新 `test/cdp-watcher.test.mjs`、`test/powertools-suite.test.mjs` 与 5 语言词典（`i18n-locales.js`），全量自动化测试通过率 100%（Windows 下 146 项通过、1 项 POSIX `install.sh` 测试按平台跳过）。

**Full Changelog**: https://github.com/0DNANCY/agy-claude-style/compare/v3.1.1...v4.0.0

---

## [v3.1.1] - 2026-11-28

- **Sidecar 与监视器稳定性修复（#25，@NoFires）**：避免 `inject.js` 备用锁轮询阻塞事件循环，并兼容 `sidecar_sdk` 单参数 API 处理函数与路由守卫校验。

## [v3.1.0] - 2026-11-28

`v3.1.0` 全面优化 **左侧选项卡（Left Sidebar）视觉层级、选中态与空项目折叠体验**，并同步完善原生外观设置面板与控制室的双向开关联动。

### 🎨 左侧选项卡（Left Sidebar）体验重构
- **层级对比与树状导引线（`features/sidebar-polish.js`）**：
  - 强化项目分组标题字重与悬停高亮反馈（修复原先悬停透明无底色问题），为展开的会话列表绘制左侧 `1px` 树状缩进导引线，并在悬停或包含当前激活会话时柔和提亮/着色。
  - 当前选中会话（支持属性与 URL `cascadeId` 匹配）呈现独立强调色胶囊与左侧 `2.5px` 圆角指示条，同时联动高亮所属父项目文件夹图标与标题。
  - 收紧顶部导航（「新对话 / 自动化 / 自定义」）间距并同步激活态高亮，为「扩展」折叠区补齐底部对称分割线，统一左侧栏三段视觉节奏，并对相对时间启用 `tabular-nums` 等宽对齐。
- **空项目「还没有对话」默认收起（`sidebarFoldEmpty`）**：
  - 新增 `sidebarFoldEmpty` 配置项（默认 `true`），自动收起隐藏无会话项目下方的「还没有对话 / No conversations yet」多语言占位行，大幅减少无效纵向占屏并轻度柔化空项目标题降噪。
  - 单击空项目标题可随时展开查看紧凑版空状态提示（再次点击收起），同时完整保留悬停 `+` 新建对话与操作菜单；一旦该项目新建会话即自动解除折叠态。
- **双入口设置对齐**：
  - 在原生 **「设置 → 外观」** 面板补齐 **`sidebarCompact`（紧凑侧边栏）** 与 **`sidebarFoldEmpty`（默认收起空项目）** 联动子项（受 `sidebarRestyle` 控制），与右侧 **「控制室 → 外观与版面」** 保持 100% 双向实时同步；无痕卸载时完整清理所有 `data-ag-cs-sb-*` 标记。

### 🧪 自动化测试扩充
- 在 `test/powertools-suite.test.mjs` 新增 `sidebar-polish` 专项单元测试（覆盖树状结构标记、父项目激活联动、多语言空项目默认折叠、原生展开/折叠项目单击切换、附属按钮放行及无痕清理），全量测试套件扩展至 **145 项**。

## [v3.0.0] - 2026-11-28

`v3.0.0` 完成重大架构升级：**全面转向 Antigravity Desktop 原生插件运行架构，彻底废除外部 CDP 守护程序与外置启动脚本**。Windows（`.exe`）与 macOS（`.dmg`）安装器职责降级为纯正的零后台驻留原生插件部署与旧版迁移清理工具，CDP 动态注入与热更新 100% 在原生插件宿主内部完成（目标机器无需安装 Node.js）。

### 🔌 原生插件内部 CDP 注入（零外部程序依赖）
- **Sidecar 内建 Electron CDP 监督器**：在 `sidecars/panel/main.mjs`（随 Antigravity Desktop 内置 Electron Node 运行时自动拉起）中集成 `createWatchController` 与 `STATE_DIR/.watch.pid` 协调锁，与 `plugin/mcp-host.js` 协同托管 CDP 窗口注入、`<2KB` 轻量配置热更新、冷启动自动带参重启以及停用/卸载时的实时无痕还原，普通桌面用户**无需安装外部 Node.js** 即可完整运行。
- **Windows 目录句柄防锁定**：`sidecars/panel/main.mjs` 与 `plugin/mcp-host.js` 启动后自动切换工作目录至 `STATE_DIR`（`~/.gemini/antigravity/plugin_data/agy-claude-style`），避免锁住 `~/.gemini/config/plugins/agy-claude-style` 导致更新或卸载被占用。
- **核心模块纯化与进程归属校验升级**：`inject.js` 剥离全部 CLI 参数与 `launchWithCdp`/`watch` 入口；`cdp.js` 的 `evaluateWatcherOwnership` 改为仅识别原生插件双宿主进程（`plugin/mcp-host.js` 与 `sidecars/panel/main.mjs`，支持 Sidecar `--max-old-space-size` / `--import` 运行参数与 macOS `/private` 软链规范化），保留 Fail-Closed 防误杀锁策略。

### 📦 安装器轻量化重构（纯原生插件安装 / 更新 / 卸载）
- **安装包聚焦纯部署职能**：Windows `Program.cs` 与 macOS `Setup/main.swift` 统一将完整原生插件包（含 `plugin.json`、`mcp_config.json`、`plugin/`、`sidecars/panel/`、`features/`、`assets/` 与全部运行时）部署至 `~/.gemini/config/plugins/agy-claude-style`，用户配置统一存放于 `~/.gemini/antigravity/plugin_data/agy-claude-style/config.json`。
- **自动迁移与旧版清理**：安装/升级时自动迁移旧版 `%LOCALAPPDATA%\agy-claude-style\config.json` / `~/Library/Application Support/agy-claude-style/config.json`（自动剔除废弃字段 `exitOnHostClose`），并自动停止和清理旧版 `agy-claude-style-watcher`、Windows Startup / macOS `LaunchAgent` 开机自启项与桌面/程序坞托管快捷方式。
- **免重启热启用**：若本地 Antigravity Language Server 正在运行，安装器通过 `JetboxWriteState` / `DeletePlugin` RPC 自动完成插件与侧栏的热加载/热卸载（离线时原子写入 `~/.gemini/config/config.json`）。

### 💥 Breaking Changes（清理废弃组件）
- 删除外部 C#/Swift CDP 守护源码：`installer/watcher/`、`installer/common/CdpClient.cs`、`installer/macos/Watcher/`、`installer/macos/Common/CdpClient.swift`。
- 删除全部根目录外置启动与卸载脚本：`*.bat`、`*.sh`、`watch-hidden.vbs`、`remove.js` 以及 `package.json` 中的 `launch` / `relaunch` / `managed` / `inject` / `watch` / `remove` 脚本。
- 移除废弃配置字段 `exitOnHostClose` 与辅助函数 `STARTUP_GRACE_SECONDS`、`ensureAntigravityWithCdp`、`readEffectiveLaunchConfig`、`cleanupLegacyMacLauncher`。

## [v2.2.0] - 2026-11-27

`v2.2.0` 正式整合 **原生 Antigravity 插件宿主、侧栏 3 页签控制室与 Powertools 效率套件**（基于 PR #19 @NoFires 扩展并完成全量安全与稳定性加固），以及 **打开长对话时的强制布局读取性能优化**（PR #21 @liuhaodongliu990-cmyk，Fixes #20）。同时完整保留 **「设置 → 外观」原生设置面板** 与 **右侧边栏 3 页签控制室** 双入口并实现双向同步，并恢复 Windows / macOS 独立安装器、Launcher 与 CDP 运行时的跨平台一致性。

### 🚀 原生插件模式、侧栏 3 页签控制室与双入口设置同步
- **方式四：Antigravity 原生插件宿主（Plugin Host + Aux Pane）**：
  - 新增 `plugin.json`、`plugin/mcp-host.js`（零工具极简 MCP 宿主）与 `plugin/host-lifecycle.js`（随插件宿主启动/退出自动拉起并托管 `inject.js --watch` 与独立 `sidecars/panel` 侧栏）。
  - 在原生插件宿主、Windows `.exe`、macOS `.dmg` 与 Node CLI 四种安装/运行模式间保持完整兼容；卸载或恢复原生时清理全部附加 DOM 节点、样式与全局属性。
- **右侧栏 3 页签控制室 (`sidecars/panel/`)**：
  - **仪表盘 (Dashboard)**：本地 + SSH 远程 JSONL 流式遥测聚合（支持 UTF-8 分片边界解码与超大单行前后缀投影）、53 周跨夏令时日历热力图、缓存骤降异常检测、模型健康度时间线与 TTFT / Streaming TPS 分离统计（区分 `stream` / `buffered` / `toolOnly`）、LiteLLM 动态定价刷新与 5 小时 / 周配额追踪。
  - **控制室 (Control)**：全量外观、HUD、Powertools、阶段汇报提示词注入开关及窗口标题未读统计的可视化调教（支持 3-way 配置合并、轮询期间表单防覆盖与即时轻量化热更新）。
  - **远程与代理 (Remote & Proxy)**：SSH 多主机发现与远程 `.jsonl` 遥测拉取，以及独立非 TUN 代理与冷启动/断连告警。
- **双入口实时同步**：
  - 同时保留 Antigravity 原生 **`设置 → 外观`** 底部全量可视化设置组（`#ag-cs-settings-sec`）与 **右侧栏「控制室」页签**，双方共同读写 `config.json` 并在 5 种界面语言间同步切换。

### 🧰 Powertools 效率套件与界面打磨（模块化拆分 `features/*`）
- **交互增强模块**：
  - **时间旅行撤销 (`ui-rewind.js`)**：`双击 Esc` 或点击消息撤销触发两步安全回退（支持「恢复对话 + 代码 / 仅恢复对话 / 仅恢复代码」及异步 diff 预览）。
  - **对话分支与消息原地编辑 (`features/branch-edit.js`)**：支持从任意助手回复分叉创建新会话（保留工作区）及双击用户消息内联编辑重发（兼容 Lexical 编辑器）。
  - **文件链接菜单 (`features/file-menu.js`)**：点击文件引用弹出右键/快捷操作菜单，支持「本地打开 / 资源管理器定位 / 复制路径 / 外部编辑器或终端打开（带行列号跳转）/ 插入到输入框」，拦截 UNC 网络路径与批处理敏感字符注入。
  - **浮动任务进度卡片 (`features/task-progress.js`)**：悬浮/停靠双形态追踪任务步骤、`[x]` 清单进度、重试原因分类及实时等待计时。
  - **扩展坞固定栏 (`features/extensions-dock.js`)**：支持将常用扩展侧栏固定到顶栏或左侧边栏快捷打开。
  - **窗口后台未读徽章 (`features/unread-title.js`)** 与 **关闭隐藏托盘拦截 (`features/hide-on-close.js`)**。
  - **阶段自动折叠与可选提示词注入 (`features/stage-collapse.js`)**：默认启用 **`stageCollapse`（UI 自动折叠阶段工具组与汇报）**；并将「向发送请求附加 `agy_cs_stage_updates` 系统提示规则」拆分为独立开关 **`stagePromptInjection`（默认 `false` 关闭，透明可控）**。
- **玻璃拟态、紧凑布局与细节修复**：
  - 新增 **液态玻璃效果 (`glassEffect`)**、**对话紧凑排版 (`compactChatLayout`)**、**配额显示周期 (`quotaCycleMode`: `auto` / `5h` / `weekly`)**、**边框进度数据源 (`hudRimSource`)**；优化 `200k` / `1M` 同后缀模型思考强度匹配（`effort-core.js`）与媒体预览关闭按钮层级。

### ⚡ 长对话性能与全链路安全加固
- **零强制同步布局读取（整合 PR #21，Fixes #20）**：
  - 在输入框未获焦时跳过平滑光标 `measureEditorCaretBox` / `getBoundingClientRect()` 测量，并在空闲检查时将轻量下标守卫置于 `getBoundingClientRect()` 之前，消除打开或切换长对话时的卡顿。
- **安全性与稳定性修复（PR #19 深度审查闭环）**：
  - 修复 Windows/macOS 原生安装器对 `features/*.js` 嵌套子目录的打包与递归复制；修复 C# 5 编译器兼容性（`Program.cs` 移除 `?.`、`$"`, 替换 `System.Windows.Forms`）。
  - 加固侧栏 HTTP 服务（Fail-Closed `Host` / `Origin` 校验并移除无鉴权 `/api/file/action`）、`file-actions.mjs` UNC/符号注入拦截与 `wt.exe` 分号转义、`ssh-remote.mjs` EPIPE/TDZ 防护、`cdp.js` 日志脱敏，以及 `extensions-dock.js` DOM XSS 消除。

## [v2.1.0] - 2026-11-22

`v2.1.0` 新增 **Swarm 蜂群侧栏（`/swarm` 面板）与 Plan / Orchestrator 模式完整 5 语言本地化**（#15），并修复了长对话虚拟列表及模型思考阶段输出下方轮次 HUD（`#T` 徽章）可能出现历史或残缺虚假信息的问题。

### 🌐 语言支持增强（Swarm UI 侧栏 & Plan / Orchestrator 模式，#15）
- **Swarm 蜂群侧栏（`/swarm` 面板）完整 5 语言本地化**：
  - Node（`cdp.js`）、Windows C#（`CdpClient.cs`）与 macOS Swift（`CdpClient.swift`）三端 CDP 目标过滤统一支持 `plugin://swarm--` 侧栏 OOPIF `iframe` 目标，并自动随主窗口语言切换通过轻量 `refreshConfig` 实时同步。
  - 新增 `sidecar-core.js` 侧栏精简运行时：在 `plugin:` 协议上下文下跳过主窗口 `style.css` 与 UI 增强，仅挂载可逆 DOM 翻译器，精准保护帖子正文、成员句柄、任务描述与叙述者视图，同时放行 `<select><option>` 筛选选项翻译，卸载时无损还原。
- **Plan / Orchestrator / Coordinator / Plugins 词典补齐**：
  - 扩充 `i18n-locales.js` 约 180+ 条 5 语言静态词条与 25 条动态正则规则，覆盖 Swarm 面板（Overview / Board / Members / Graph / Raw / Hive / Replay / GIF 导出）及主窗口新版 Orchestrator 模型设置、Coordinator/Subagent 控件、Pause/Resume 提示与插件管理界面。

### 🐛 Token HUD 轮次徽章（`#T`）精准对齐与思考态防串位修复
- **消除长对话思考阶段 `#T` 徽章盗用历史轮次问题**：
  - 修复在长对话虚拟列表仅挂载最近若干轮次（如 `#T12`～`#T20`）时，新提问处于“工作中 / 思考中”阶段因 `matchTurnByFiber` 返回 `null` 而掉入 `remainingTurns` 尾部回退队列、导致 `#T20` 下方的思考中节点错误挂载未渲染历史轮次（如 `#T11`）的问题。
  - 对缺失 Fiber 定位器的降级匹配施加严格的 DOM 先后单调性约束，并禁止自身已携带 Fiber 索引/时间戳的新轮次节点进入降级回退队列。
- **禁止进行中（思考中 / 流式生成中 / 工具执行中）轮次提前挂载残缺 HUD**：
  - 在 `usage-core.js` 中为仍包含 `status === 1` / `status === 2` 步骤或正在等待工具调用后模型响应的轮次标记 `inProgress: true`；在 `ui-runtime.js` 的 `extractFiberTurnContainer` 与多响应合并 `mergeFiberInfo` 中追踪 `hasRunningStep` / `isEmptySteps`（同时覆盖主会话与子智能体面板），确保模型思考期间下方不出现半成品或虚假 HUD，待生成完成后立即挂载完整 `#T` 统计。
- **防御发送瞬间缓存窗口期抢占与 0-Token 启动占位**：
  - 防止刚按下发送键、轨迹轮询尚未闭合上一轮 `nextUserStepIdx`（仍为 `Infinity`）的瞬间，新插入的 DOM 轮次节点覆盖抢占上一轮的 `#T` 徽章。
  - 过滤 `generatorMetadata` 启动期仅有 `chatStartMetadata` 尚无 `usage` token 的占位条目进入 `callList`（同时保留其实时上下文窗口占用更新）。

### 🧪 自动化测试扩充
- 全平台自动化测试扩展至 **90 项**（新增 Swarm 侧栏翻译器与 OOPIF 目标发现测试、20 轮虚拟列表 + 第 21 轮思考中四阶段防串位回归测试及未完成调用过滤测试）。

**Full Changelog**: https://github.com/0DNANCY/agy-claude-style/compare/v2.0.0...v2.1.0

---

## [v2.0.0] - 2026-11-21

`v2.0.0` 为重大架构与体验升级版本：正式引入 **「启动器托管模式（随宿主生灭、零后台常驻）」**（#4、#14），并全面整合 **PR #13**（@zhyan0603 / ZihanYAN）在守护进程安全加固、轻量配置热更新与 Token HUD 方面的深度优化。

### 🚀 启动器托管模式与双模式切换（#4、#14）
- **三端统一无窗启动器（`--launch` / `--managed`）**：
  - Windows `agy-claude-style-watcher.exe` 与 macOS `agy-claude-style-watcher` 新增 `--launch`、`--relaunch`、`--replace`、`--startup-grace <sec>`（默认 `90` 秒），Node 端 `inject.js` 同步新增 `--managed` 一键组合参数与 `npm run managed`。
  - 启动时优先复用并激活已有 CDP 窗口；未运行或未开启 CDP 时按参数/配置以 `--remote-debugging-port=0` 启动或温和重启，随后直接进入 `--exit-on-host-close` 监听并在宿主关闭后自动退出。
  - 新增重复实例去重（托管启动不重复驻留）与 **90 秒启动宽限保护**：若在首个窗口附着前宿主启动失败或中途关闭，watcher 会在宽限期后自动退出并清理 `.watch.pid`，避免孤儿进程挂起；普通 `--watch` 守护模式即使配置了 `exitOnHostClose: true` 也不会误触发宽限退出。
- **Windows 与 macOS 独立安装器双模式改造**：
  - 安装器 GUI 与 CLI 均默认推荐 **托管启动模式（免后台常驻）**，同时完整保留 **常驻守护模式（开机自启）**，支持 `--mode=managed|daemon`、`--managed`、`--daemon`、`--desktop-shortcut` / `--no-desktop-shortcut`（Windows）、`--app-launcher` / `--no-app-launcher`（macOS），并兼容 `--no-autostart`。
  - 托管模式下平时 **0 后台进程常驻**：不写入 Windows Startup / macOS `LaunchAgent`；仅当安装时检测到 Antigravity 已开启 CDP 会话才拉起一次性 `--exit-on-host-close` 监听接管当前会话。
  - 升级自动保留已有 `config.json` 并通过 `.install-mode` 记录当前模式；从常驻模式切换至托管模式时，主动删除旧版 Startup 快捷方式 / `LaunchAgent` plist 并停止原常驻进程；卸载时一并清理所有启动入口。
  - 统一启动入口：Windows 安装目录、开始菜单及桌面生成 `Antigravity (AGY Claude Style).lnk`（指向无黑框 watcher `--launch --relaunch --exit-on-host-close`）；macOS 生成 `Antigravity (AGY Claude Style).app` 与 `launch-antigravity.command`。
- **脚本模式升级**：
  - `launch.bat` 与 `launch.sh` 默认以托管模式启动并在关闭宿主后自动退出，传入 `--daemon` 可切回常驻守护模式；`watch-hidden.vbs` 支持命令行参数透传（无参保持默认 `--watch --replace`）。
- **零侵入安全原则**：全程不改动 Antigravity 原版安装目录，不使用 DLL 劫持或 IFEO 映像劫持，避免安全软件误报并保持 Windows / macOS / Linux 跨平台统一。

### 🛡️ 守护进程安全加固与轻量配置热更新（整合自 #13，致谢 @zhyan0603）
- **Fail-Closed PID 归属校验**：
  - 在 `cdp.js`、`inject.js`、`remove.js` 与 Windows C# / macOS Swift 安装器及守护进程中引入严格进程归属判定，综合校验可执行文件路径、命令行参数、`--dir` 及 macOS `/private/(var|tmp|etc)` 软链路径（支持 `--watch` 与 `--managed`）。
  - 仅终止确认属于目标安装目录的守护进程；遇到失效或属于其他程序的 PID 仅清理锁文件而不误杀；进程信息无法确认时执行 **Fail-Closed 拒绝策略**，既不发信号也不覆盖 `.watch.pid`。
  - `watch.sh` 与 `launch.sh` 统一改用 `$PWD/inject.js` 绝对路径启动，消除相对路径判重盲区；Windows 卸载自删除改用编码 PowerShell `-LiteralPath` 安全处理特殊路径字符。
- **`<2KB` 轻量配置热更新与三方配置合并**：
  - 将页面注入脚本拆分为不可变完整运行时（`bootstrapScriptId`）与独立短配置脚本（`configScriptId`）。仅编辑 `config.json` 或在面板切换设置时，仅下发 `<2KB` 配置脚本并触发 `window.__agClaudeStyle.refreshConfig()`，避免重复传输整包运行时与样式表；新开窗口、页面重载及轻量刷新回退时均保持最新配置生效。
  - 共享 `CONFIG_VALIDATORS` 单一校验源并消除重复校验表；`config.json` 改用临时文件原子替换写入（替换失败保留原文件）；前端 `loadSettings` 对前后配置快照与 `localStorage` 执行 **3-way 合并**，保留本地 UI 偏好不被外部非相关变更覆盖；对齐三端 `autoRelaunchWithCdp` 缺省值为 `true`，Windows `MiniJson.cs` 补齐 `\u2028`/`\u2029` 转义。

### 📊 Token HUD 增强与运行时性能优化（整合自 #13）
- **低上下文预警与精准 `/compact`**：上下文剩余 `<= 20%`（琥珀色预警）及 `<= 10%`（红色紧急）时，状态环、顶部 HUD `/compact` 按钮与详情浮窗同步展示提醒并支持点击一键填充 `/compact`；多会话视图下优先向当前卡片关联输入框填入指令。
- **配额联动与剪贴板反馈**：开启底部 HUD（`hudBottomBar`）时，即使圆环处于 `context` 模式也会同步拉取模型配额；点击复制遥测报告在剪贴板拒绝或失败时显示明确 `✕ 失败` 状态反馈。
- **绘制与缓存优化**：草稿输入时的弹层数据刷新通过 `requestAnimationFrame` 合并并优先局部更新数字节点；过滤非输入区的 `.monaco-editor` 与 `.xterm` 高频 DOM 变更；为主会话与子代理轨迹缓存增加 LRU 淘汰；首页字符波纹静止时跳过冗余计算并在零尺寸容器下安全创建与卸载绘制资源。

### 🧪 自动化测试扩充
- 全平台自动化测试扩展至 **84 项**（覆盖托管启动、90s 启动宽限、重复实例去重、Windows/macOS 双模式切换与卸载 E2E、fail-closed PID 归属保护、原子配置替换、`<2KB` 轻量热更新、低上下文预警及零尺寸波纹卸载）。

**Full Changelog**: https://github.com/0DNANCY/agy-claude-style/compare/v1.3.0...v2.0.0

---

## [v1.3.0] - 2026-11-20

- **Remote（Cloud）模式 Token HUD 与用量遥测支持（#11）**：接入 `AgentState` 流式遥测与状态订阅，解决 Remote 会话下 HUD、状态条、内联统计与 `#T` 轮次徽章缺失的问题，并支持带有 `v1/default/jetski_remote_agents_3p/...` 前缀的 `cascadeId` 与更准确的模型上下文上限/速度统计。
- **CI / Release 工作流优化与产物命名统一（#12）**：引入共享工作流 `.github/workflows/_build-and-test.yml`，统一输出 `AGY-Claude-Style-v<version>-Windows-x64.exe`、`AGY-Claude-Style-v<version>-macOS-universal.dmg` 与 `SHA256SUMS.txt`。

**Full Changelog**: https://github.com/0DNANCY/agy-claude-style/compare/v1.1.1...v1.3.0

---

## [v1.1.1] - 2026-11-20

- 修复 PR #8 复查反馈的问题（#9、#10）：加固 CDP 自动重启接管前对原生可执行路径的校验，修复流式回复阶段 `#T` 徽章跳位与用量统计双倍计数，并降低全局 DOM 监听开销。

**Full Changelog**: https://github.com/0DNANCY/agy-claude-style/compare/v1.1.0...v1.1.1

---

## [v1.1.0] - 2026-11-20

- 适配 **Antigravity 2.33.0+** 默认关闭 CDP 调试端口的变更（#2、#3、#5、#6、#7、#8）：新增 `--launch` / `--relaunch`、默认启用 `autoRelaunchWithCdp`、Windows 开始菜单启动快捷方式与 macOS `launch-antigravity.command`，修复 Token HUD 实时刷新、对话轮次统计与侧边栏样式。

**Full Changelog**: https://github.com/0DNANCY/agy-claude-style/compare/v1.0.0...v1.1.0

---

## [v1.0.0] - 2026-11-15

- 首个公开版本（#1）：基于 CDP 的 Antigravity 无损实时样式注入、Studio 首页与字符波纹场、Token HUD、5 语言翻译、像素螃蟹 `Clawd`、思考强度滑块，以及 Windows（C#）与 macOS（Swift Universal）独立免 Node.js 安装器。
