// Tab 1: Control Room module for AGY Claude Style Aux Pane (v4.0.0).
// Preserves AGYPanelControlSchema 4-group structure while adding Theme Studio & Dynamic Wallpaper Studio.
(function (root) {
  const I18N = {
    'zh-CN': {
      tabControl: '⚙ 控制室', tabDashboard: '📊 用量看板', tabRemote: '🌐 代理与远程',
      connected: (p, n) => `CDP :${p} · ${n} 目标`,
      waitingPort: '等待 CDP', disconnected: '未连接',
      btnReinject: '✦ 立即应用并刷新', btnRemove: '还原原生', btnReset: '恢复默认', btnRefresh: '刷新状态',
      btnRelaunch: '立即重启启用', relaunching: '正在重启 Antigravity…',
      cdpTitle: '未检测到 Antigravity 调试端口',
      cdpDesc: '正常打开原版 Antigravity 时可开启「冷启动自动重启启用」，或点击下方按钮立即带参安全重启。',
      cdpTrippedDesc: '冷启动自动重启连续 2 次未能连上调试端口，已触发熔断保护。请点击下方按钮手动重启启用。',
      cdpCooldownDesc: (sec) => `冷启动自动重启冷却保护中（约 ${sec}s），也可随时点击下方按钮立即手动重启启用。`,
      proxyColdTitle: '独立代理本次冷启动未生效',
      proxyColdRelaunch: '✦ 一键带代理与 CDP 重启',
      studioConflictTitle: '检测到与 agy-claude-studio 插件冲突',
      studioConflictDesc: '同时启用 agy-claude-studio 会移除本插件样式表导致任务进度、配额环与扩展栏排版错乱，请在插件管理中停用或卸载 agy-claude-studio。',
      searchPlaceholder: '搜索设置项…',
      expandAll: '展开全部', collapseAll: '收起全部',
      emptySearch: '没有找到匹配的设置项',
      hudDetailsLabel: '环绕 HUD 细节开关',
      badgeClaude: '仅 Claude Code',
      badgeLwf: '仅 梁武峰',
      grpAppearance: '外观、主题与动态壁纸',
      grpInteraction: '交互与思考滑块',
      grpTelemetry: 'Token 用量与环绕 HUD',
      grpPowertools: '效率增强与扩展',
      metaLine: (v, alive) => `v${v} · 宿主${alive ? '运行中' : '未就绪'}`,
      chipTargets: (w, s) => `窗口 ${w}${s ? ` · Swarm ${s}` : ''}`,
      savedToast: (k) => `已更新 ${k} 并实时同步`,
      saveErrToast: (e) => `保存失败: ${e}`,
      actionOk: (a) => `${a} 完成`, actionFail: (a, e) => `${a} 失败: ${e}`,
      themeStudioTitle: '主题调色工作坊',
      themeStudioHint: '速选预设或切换至「自定义色板」精细调色',
      themeModeAuto: '跟随宿主明暗', themeModeDark: '强制暗色底色', themeModeLight: '强制亮色底色',
      themeCloneBtn: '从预设吸色', themeResetBtn: '重置色板',
      themeTokens: {
        accent: '主强调色', canvas: '主画布', sidebar: '侧边栏', composer: '输入框',
        bubble: '消息气泡', fg: '主文字', mutedFg: '次文字', border: '边框线',
      },
      wpStudioTitle: '动态壁纸媒体库',
      wpDropTitle: '点击选择或拖拽视频 / 图片到此处',
      wpDropSub: '支持 MP4 / WebM / GIF / WebP / PNG / JPG（最大 128MB）',
      wpPathPlaceholder: '或粘贴本机视频/图片绝对路径…',
      wpImportBtn: '导入路径',
      wpEmpty: '尚未导入本地壁纸，拖拽或选择文件即可开始',
      wpDelBtn: '删除',
      wpUploading: (pct) => `正在导入壁纸 ${pct}%…`,
      wpImportedToast: '壁纸导入成功并已应用',
      labels: {
        language: ['界面语言', '切换 Antigravity 界面与插件面板语言（简繁粤英日）'],
        homeLayout: ['首页版面', '切换新对话首页布局（仪表盘、居中或原生关闭）'],
        palette: ['配色方案', '选择内置精选主题、自定义色板或跟随宿主主题'],
        glassEffect: ['全局毛玻璃材质', '为顶栏、输入框、弹层与侧栏启用细腻磨砂玻璃效果'],
        wpMode: ['动态壁纸范围', '关闭、作为全局窗口背景（对话区+侧栏透出）或仅欢迎首页'],
        wpOpacity: ['壁纸不透明度', '调节动态壁纸本身的不透明程度'],
        wpBlur: ['壁纸背景模糊', '为动态壁纸叠加高斯模糊，减少画面杂讯'],
        wpDim: ['壁纸可读性遮罩', '正值为暗色压暗遮罩，负值为柔亮雾化遮罩'],
        wpSurfaceAlpha: ['全局面板透光度', '仅全局壁纸模式生效：调节对话画布与侧栏底色覆盖比例（越低透出越多）'],
        wpRate: ['视频播放倍速', '调节 MP4 / WebM 动态壁纸的播放速率'],
        wpPauseBlur: ['失焦自动暂停省电', '切出或最小化 Antigravity 窗口时自动暂停视频解码'],
        logoInk: ['Antigravity Logo 着色', '首页问候图标使用主题强调色或前景色'],
        sidebarRestyle: ['侧栏 Claude 风格', '统一侧边栏行高、图标与悬停高亮样式'],
        sidebarCompact: ['紧凑侧边栏', '压缩对话行高，同屏展示更多会话'],
        sidebarFoldEmpty: ['默认收起空项目', '默认隐藏「还没有对话」占位行节省空间，点击项目可按需展开'],
        composerRestyle: ['极简输入框重排', '极简圆角输入框卡片与画布底栏样式'],
        placeholderStyle: ['输入框占位提示', '使用工作台提示文案或跟随宿主原生'],
        compactChatLayout: ['紧凑对话正文排版', '保持字号不变，收紧正文行高与段落间距提高单屏信息密度'],
        effortSliderStyle: ['思考强度滑块风格', '选择推理强度滑块样式（Claude Code / ChatGPT Codex / 梁武峰）'],
        effortAccent: ['Claude 推理色阶强调', '在 Claude 滑块与像素矩阵上启用蓝紫色阶高亮'],
        performanceBackdrop: ['梁武峰 性能人像背景', '选择梁武峰模式下 31 帧人像剪影的渲染区域'],
        smoothCaret: ['平滑输入光标', '输入框启用流畅过渡光标动画'],
        mascot: ['输入框像素螃蟹挂件', '在输入框/首页展示像素风小螃蟹动态彩蛋'],
        homeRipple: ['首页字符矩阵波纹', '在欢迎页呈现柔和字符矩阵水波背景'],
        inlineStats: ['对话内嵌统计与剩余用量环', '在输入框底栏展示 Token 统计与剩余用量圆环'],
        ringMode: ['右下角圆环显示模式', '切换上下文剩余、模型配额剩余或双圆环模式'],
        quotaCycleMode: ['配额周期显示来源', '配额圆环与流光边框使用自动（较低项）、周限额或 5 小时限额'],
        turnBadges: ['对话轮次 Token 徽章', '在每轮 AI 回复旁展示耗时与 Token 徽章'],
        hudTopBar: ['输入框顶部 HUD 进度条', '在输入框顶部显示轻量上下文占用分段条'],
        hudBottomBar: ['输入框底部 HUD 统计栏', '在输入框外下方显示详细上下文与配额统计条'],
        hudRimProgress: ['输入框流光边框进度', '沿输入框边线渲染实时占比进度光带'],
        hudRimSource: ['流光边框数据源', '选择流光边框跟随圆环模式、固定显示上下文或固定显示所选配额周期'],
        hudFooterChip: ['底栏剩余容量胶囊', '在输入框工具栏显示剩余可用容量与配额胶囊'],
        hudCompact: ['HUD 紧凑显示模式', '缩小环绕 HUD 与底栏胶囊内边距，节省垂直空间'],
        taskProgressCard: ['任务进度浮窗', '实时阶段环、等待计时、工具时间轴与子智能体展开'],
        stageCollapse: ['阶段汇报与自动折叠', '在原生对话中开启阶段自动折叠，整轮结束后自动收拢进原生用时栏并内联展示步骤计数'],
        stagePromptInjection: ['阶段汇报提示词注入', '向模型追加英文阶段汇报指令（仅当开启「阶段自动折叠」时生效，默认关闭，开启会微幅增加系统提示词上下文）'],
        windowUnreadTitle: ['窗口标题未读数提醒', '后台会话完成回复或等待权限审批时在窗口标题显示未读角标'],
        branchSession: ['原生分支会话', '在 AI 回复操作栏添加分支按钮，保留上下文分叉'],
        messageEdit: ['原位消息编辑', '在已发消息操作栏添加编辑按钮，原位修改重发'],
        fileContextMenu: ['文件右键菜单', '右键文件链接或文件树可引用、打开、定位与复制'],
        rewindPanel: ['Rewind 回退面板', '侧边回退目录与一键撤销到历史节点'],
        undoConfirmMode: ['撤销确认方式', '回退前弹出模式选择器、二次确认或直接执行'],
        headerExtensionsBar: ['顶栏扩展菜单与收藏', '工具栏扩展菜单（右键关闭侧栏），★ 收藏固定至顶栏'],
        sidebarExtensionsSection: ['左侧栏「扩展」收藏区', '默认收起，已收藏扩展常驻显示并可直达主面板'],
        hideOnClose: ['关闭窗口挂后台', '仅拦截关闭窗口行为并隐藏至后台免重载，绝不劫持 Cmd+W/Ctrl+W 关闭标签页（Cmd+Q / Alt+F4 正常退出）'],
        autoRelaunchWithCdp: ['冷启动自动重启启用', '直接打开原版 Antigravity 未检测到 CDP 时，自动带调试端口与代理重启一次（120s 冷却 + 2 次失败熔断）'],
      },
      options: {
        language: [['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['yue', '粵語'], ['en', 'English'], ['ja', '日本語']],
        homeLayout: [['studio', '仪表盘'], ['classic', '居中'], ['off', '关闭']],
        palette: [
          ['obsidian', '深邃蓝黑'], ['claude', 'Claude'], ['nord', 'Nord 极夜'],
          ['catppuccin', 'Catppuccin'], ['rosepine', 'Rosé Pine'], ['tokyo', 'Tokyo Night'],
          ['dracula', 'Dracula'], ['emerald', '翠影暗绿'], ['custom', '自定义色板'], ['host', '跟随宿主'],
        ],
        wpMode: [['off', '关闭'], ['global', '全局窗口背景'], ['home', '仅欢迎首页']],
        logoInk: [['accent', '主题色'], ['foreground', '前景色']],
        placeholderStyle: [['studio', '工作台'], ['host', '跟随原生']],
        effortSliderStyle: [['claude', 'Claude Code'], ['chatgpt', 'ChatGPT Codex'], ['liangwufeng', '梁武峰']],
        performanceBackdrop: [['card', '仅滑块卡片'], ['page', '全窗口背景'], ['off', '关闭']],
        ringMode: [['context', '上下文剩余'], ['quota', '配额剩余'], ['both', '双圆环']],
        quotaCycleMode: [['auto', '自动（较低项）'], ['weekly', '仅周限额'], ['5h', '仅 5 小时限额']],
        hudRimSource: [['auto', '跟随圆环'], ['context', '上下文进度'], ['quota', '配额周期进度']],
        undoConfirmMode: [['picker', '模式选择弹窗'], ['prompt', '二次确认'], ['auto_both', '直接撤回全部'], ['auto_chat', '仅撤回对话']],
      },
    },
    en: {
      tabControl: '⚙ Studio', tabDashboard: '📊 Dashboard', tabRemote: '🌐 Proxy & SSH',
      connected: (p, n) => `CDP :${p} · ${n} targets`,
      waitingPort: 'Waiting for CDP', disconnected: 'Disconnected',
      btnReinject: '✦ Apply & Refresh Now', btnRemove: 'Restore Native', btnReset: 'Reset Defaults', btnRefresh: 'Refresh',
      btnRelaunch: 'Relaunch Now', relaunching: 'Relaunching Antigravity…',
      cdpTitle: 'Antigravity Debug Port Not Detected',
      cdpDesc: 'Enable Cold-Start Auto-Relaunch below or click to relaunch Antigravity with CDP safely.',
      cdpTrippedDesc: 'Cold-start auto-relaunch hit 2 consecutive failures (circuit breaker active). Click below to relaunch manually.',
      cdpCooldownDesc: (sec) => `Auto-relaunch cooldown active (~${sec}s remaining). You can still relaunch manually below.`,
      proxyColdTitle: 'Standalone Proxy Not Active on Cold Start',
      proxyColdRelaunch: '✦ Relaunch with Proxy & CDP',
      studioConflictTitle: 'Conflict with agy-claude-studio Detected',
      studioConflictDesc: 'Running agy-claude-studio alongside agy-claude-style deletes this plugin stylesheet and breaks UI layout. Please disable or uninstall agy-claude-studio.',
      searchPlaceholder: 'Search settings…',
      expandAll: 'Expand all', collapseAll: 'Collapse all',
      emptySearch: 'No matching settings',
      hudDetailsLabel: 'Surround HUD Details',
      badgeClaude: 'Claude Code',
      badgeLwf: 'Liang Wufeng',
      grpAppearance: 'Appearance, Theme & Wallpaper',
      grpInteraction: 'Slider, Caret & Mascot',
      grpTelemetry: 'Usage Ring & HUD',
      grpPowertools: 'Productivity & Extensions',
      metaLine: (v, alive) => `v${v} · Host ${alive ? 'Running' : 'Idle'}`,
      chipTargets: (w, s) => `Win ${w}${s ? ` · Swarm ${s}` : ''}`,
      savedToast: (k) => `Updated ${k}`, saveErrToast: (e) => `Save failed: ${e}`,
      actionOk: (a) => `${a} succeeded`, actionFail: (a, e) => `${a} failed: ${e}`,
      themeStudioTitle: 'Theme Color Studio',
      themeStudioHint: 'Quick-pick a preset or switch to Custom to fine-tune tokens',
      themeModeAuto: 'Follow Host Mode', themeModeDark: 'Force Dark', themeModeLight: 'Force Light',
      themeCloneBtn: 'Load Preset', themeResetBtn: 'Reset',
      themeTokens: {
        accent: 'Accent', canvas: 'Canvas', sidebar: 'Sidebar', composer: 'Composer',
        bubble: 'Bubble', fg: 'Text', mutedFg: 'Muted', border: 'Border',
      },
      wpStudioTitle: 'Dynamic Wallpaper Library',
      wpDropTitle: 'Click or drag & drop video / image here',
      wpDropSub: 'MP4 / WebM / GIF / WebP / PNG / JPG (up to 128 MB)',
      wpPathPlaceholder: 'Or paste a local video/image path…',
      wpImportBtn: 'Import Path',
      wpEmpty: 'No local wallpapers yet — drop or pick a file to start',
      wpDelBtn: 'Delete',
      wpUploading: (pct) => `Importing wallpaper ${pct}%…`,
      wpImportedToast: 'Wallpaper imported & activated',
      labels: {
        language: ['Interface Language', 'Switch display language for Antigravity UI and plugin panels'],
        homeLayout: ['Home Layout', 'Switch new-conversation home layout'],
        palette: ['Color Palette', 'Pick a built-in theme preset, customize your own palette, or follow host'],
        glassEffect: ['Frosted Glass Material', 'Subtle frosted glass blur for bars, composer and menus'],
        wpMode: ['Dynamic Wallpaper Scope', 'Off, full-window translucent backdrop, or welcome home view only'],
        wpOpacity: ['Wallpaper Opacity', 'Opacity of the rendered background video or image'],
        wpBlur: ['Wallpaper Blur', 'Gaussian blur radius applied to the wallpaper media'],
        wpDim: ['Readability Scrim', 'Positive dims dark overlay; negative adds soft light mist'],
        wpSurfaceAlpha: ['Global Surface Opacity', 'Global mode only: background opacity of chat canvas and sidebar'],
        wpRate: ['Playback Speed', 'Playback speed multiplier for MP4 / WebM wallpapers'],
        wpPauseBlur: ['Pause on Blur / Hidden', 'Automatically pause video decoding when window loses focus'],
        logoInk: ['Logo Color', 'Tint of the Antigravity greeting mark'],
        sidebarRestyle: ['Sidebar Restyle', 'Apply Claude-style row height and hover plates to sidebar'],
        sidebarCompact: ['Compact Sidebar', 'Tighter row height for more sessions'],
        sidebarFoldEmpty: ['Collapse Empty Projects', 'Hide "No conversations yet" rows by default; click a project to peek'],
        composerRestyle: ['Composer Restyle', 'Minimalist rounded input box and canvas footer'],
        placeholderStyle: ['Input Placeholder', 'Studio workspace copy or host native'],
        compactChatLayout: ['Compact Chat Prose', 'Tighten line-height and paragraph gaps without shrinking font size'],
        effortSliderStyle: ['Thinking Effort Slider Style', 'Effort slider popover style (Claude Code, ChatGPT Codex, Liang Wufeng)'],
        effortAccent: ['Claude Effort Color Accent', 'Use blue-violet effort tint ramp on Claude slider & pixel matrix'],
        performanceBackdrop: ['Liang Wufeng Portrait Backdrop', 'Where the 31-frame cutout portrait renders in Liang Wufeng mode'],
        smoothCaret: ['Smooth Caret', 'Animated caret transitions in composer'],
        mascot: ['Pixel Crab Mascot', 'Show pixel crab easter egg near composer/home'],
        homeRipple: ['Home Matrix Ripple', 'Subtle ambient matrix ripple on welcome canvas'],
        inlineStats: ['Inline Stats & Remaining Ring', 'Show token stats and remaining usage ring in footer'],
        ringMode: ['Bottom-Right Ring Mode', 'Context remaining, model quota remaining, or dual rings'],
        quotaCycleMode: ['Quota Cycle Window', 'Use lowest window (auto), weekly quota, or 5h quota for rings & rim'],
        turnBadges: ['Per-Turn Token Badges', 'Show duration and token badges next to each turn'],
        hudTopBar: ['Composer Top HUD Bar', 'Show context progress bar above composer'],
        hudBottomBar: ['Composer Bottom HUD Bar', 'Show detailed HUD telemetry bar below composer'],
        hudRimProgress: ['Composer Rim Progress', 'Render usage rim progress around composer'],
        hudRimSource: ['Rim Progress Source', 'Follow active ring, lock to context, or lock to quota cycle'],
        hudFooterChip: ['Footer Remaining Chip', 'Show remaining context/quota chip in composer footer'],
        hudCompact: ['Compact HUD Mode', 'Use compact padding and condensed typography for Token HUD'],
        taskProgressCard: ['Task Progress Panel', 'Live phase ring, wait timer, tool timeline & subagents'],
        stageCollapse: ['Stage Updates & Auto-Collapse', 'Auto-fold completed execution steps into the native duration header with inline step counts'],
        stagePromptInjection: ['Stage Update Prompt Injection', 'Append concise agy_cs_stage_updates prompt instructions when Stage Collapse is enabled (default OFF)'],
        windowUnreadTitle: ['Window Title Unread Badge', 'Show unread count in window title when background chats finish or await approval'],
        branchSession: ['Session Branching', 'Add Branch icon in native action bar to fork conversation'],
        messageEdit: ['In-Place Message Edit', 'Add Edit icon on sent prompts to edit inline & resend'],
        fileContextMenu: ['File Context Menu', 'Right-click file links or tree to attach, open, reveal or copy'],
        rewindPanel: ['Rewind Panel', 'Sidebar turn directory with one-click rewind'],
        undoConfirmMode: ['Undo Confirm Mode', 'Mode picker, prompt, or instant revert'],
        headerExtensionsBar: ['Header Extensions Menu & Pins', 'Extensions menu (right-click closes side pane); ★ pins stay on bar'],
        sidebarExtensionsSection: ['Sidebar Extensions & Favorites', 'Collapsed by default; ★ favorites stay visible for main panel'],
        hideOnClose: ['Hide to Background on Close', 'Intercepts window close only (never hijacks Cmd+W/Ctrl+W tab closing; Cmd+Q / Alt+F4 quits)'],
        autoRelaunchWithCdp: ['Cold-Start Auto-Relaunch', 'Auto-relaunch stock Antigravity once with CDP (+ proxy) if debug port is missing (120s cooldown & 2-fail breaker)'],
      },
      options: {
        language: [['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['yue', '粵語'], ['en', 'English'], ['ja', '日本語']],
        homeLayout: [['studio', 'Studio'], ['classic', 'Classic'], ['off', 'Off']],
        palette: [
          ['obsidian', 'Obsidian'], ['claude', 'Claude'], ['nord', 'Nord'],
          ['catppuccin', 'Catppuccin'], ['rosepine', 'Rosé Pine'], ['tokyo', 'Tokyo Night'],
          ['dracula', 'Dracula'], ['emerald', 'Emerald'], ['custom', 'Custom'], ['host', 'Host'],
        ],
        wpMode: [['off', 'Off'], ['global', 'Global Window'], ['home', 'Home Only']],
        logoInk: [['accent', 'Accent'], ['foreground', 'Ink']],
        placeholderStyle: [['studio', 'Studio'], ['host', 'Native']],
        effortSliderStyle: [['claude', 'Claude Code'], ['chatgpt', 'ChatGPT Codex'], ['liangwufeng', 'Liang Wufeng']],
        performanceBackdrop: [['card', 'Card'], ['page', 'Window'], ['off', 'Off']],
        ringMode: [['context', 'Context'], ['quota', 'Quota'], ['both', 'Dual Rings']],
        quotaCycleMode: [['auto', 'Auto (Lowest)'], ['weekly', 'Weekly Only'], ['5h', '5h Window Only']],
        hudRimSource: [['auto', 'Follow Ring'], ['context', 'Context'], ['quota', 'Quota Cycle']],
        undoConfirmMode: [['picker', 'Mode Picker'], ['prompt', 'Prompt'], ['auto_both', 'Instant (All)'], ['auto_chat', 'Instant (Chat)']],
      },
    },
  };

  const GROUPS = [
    {
      id: 'appearance',
      icon: '🎨',
      titleKey: 'grpAppearance',
      defaultOpen: true,
      keys: [
        'language', 'homeLayout', 'palette', 'glassEffect',
        'wpMode', 'wpOpacity', 'wpBlur', 'wpDim', 'wpSurfaceAlpha', 'wpRate', 'wpPauseBlur',
        'logoInk', 'sidebarRestyle', 'sidebarCompact', 'sidebarFoldEmpty',
        'composerRestyle', 'placeholderStyle', 'compactChatLayout',
      ],
    },
    {
      id: 'interaction',
      icon: '🎛',
      titleKey: 'grpInteraction',
      defaultOpen: true,
      keys: ['effortSliderStyle', 'effortAccent', 'performanceBackdrop', 'smoothCaret', 'mascot', 'homeRipple'],
    },
    {
      id: 'telemetry',
      icon: '📊',
      titleKey: 'grpTelemetry',
      defaultOpen: true,
      keys: ['inlineStats', 'ringMode', 'quotaCycleMode', 'turnBadges'],
      hudKeys: ['hudTopBar', 'hudBottomBar', 'hudRimProgress', 'hudRimSource', 'hudFooterChip', 'hudCompact'],
    },
    {
      id: 'powertools',
      icon: '⚡',
      titleKey: 'grpPowertools',
      defaultOpen: true,
      keys: ['taskProgressCard', 'stageCollapse', 'stagePromptInjection', 'windowUnreadTitle', 'branchSession', 'messageEdit', 'fileContextMenu', 'rewindPanel', 'undoConfirmMode', 'headerExtensionsBar', 'sidebarExtensionsSection', 'hideOnClose', 'autoRelaunchWithCdp'],
    },
  ];

  const SLIDER_SPECS = {
    wpOpacity: { min: 5, max: 100, step: 1, unit: '%', def: 35 },
    wpBlur: { min: 0, max: 48, step: 1, unit: 'px', def: 0 },
    wpDim: { min: -50, max: 85, step: 1, unit: '%', def: 25 },
    wpSurfaceAlpha: { min: 15, max: 100, step: 1, unit: '%', def: 76 },
    wpRate: { min: 25, max: 200, step: 5, unit: '%', def: 100 },
  };

  const SUBROW_RULES = {
    wpOpacity: { dim: (cfg) => !cfg.wpMode || cfg.wpMode === 'off' },
    wpBlur: { dim: (cfg) => !cfg.wpMode || cfg.wpMode === 'off' },
    wpDim: { dim: (cfg) => !cfg.wpMode || cfg.wpMode === 'off' },
    wpSurfaceAlpha: { dim: (cfg) => cfg.wpMode !== 'global' },
    wpRate: { dim: (cfg) => !cfg.wpMode || cfg.wpMode === 'off' },
    wpPauseBlur: { dim: (cfg) => !cfg.wpMode || cfg.wpMode === 'off' },
    sidebarCompact: { dim: (cfg) => cfg.sidebarRestyle === false },
    sidebarFoldEmpty: { dim: (cfg) => cfg.sidebarRestyle === false },
    placeholderStyle: { dim: (cfg) => !cfg.composerRestyle },
    effortAccent: { badgeKey: 'badgeClaude', dim: (cfg) => (cfg.effortSliderStyle || 'claude') !== 'claude' },
    performanceBackdrop: { badgeKey: 'badgeLwf', dim: (cfg) => cfg.effortSliderStyle !== 'liangwufeng' },
    stagePromptInjection: { dim: (cfg) => cfg.stageCollapse === false },
    undoConfirmMode: { dim: (cfg) => cfg.rewindPanel === false },
    quotaCycleMode: { dim: (cfg) => (cfg.ringMode || 'context') === 'context' && !(cfg.hudRimProgress === true && cfg.hudRimSource === 'quota') },
    hudRimSource: { dim: (cfg) => !cfg.hudRimProgress },
    hudCompact: { dim: (cfg) => !cfg.hudTopBar && !cfg.hudBottomBar && !cfg.hudRimProgress && !cfg.hudFooterChip },
  };

  const PRESET_SWATCHES = [
    { id: 'obsidian', accent: '#4d6bfe', bg: '#13161d' },
    { id: 'claude', accent: '#d97757', bg: '#191919' },
    { id: 'nord', accent: '#88c0d0', bg: '#242933' },
    { id: 'catppuccin', accent: '#cba6f7', bg: '#1e1e2e' },
    { id: 'rosepine', accent: '#ebbcba', bg: '#191724' },
    { id: 'tokyo', accent: '#7aa2f7', bg: '#1a1b26' },
    { id: 'dracula', accent: '#bd93f9', bg: '#1e1f29' },
    { id: 'emerald', accent: '#34d399', bg: '#0f1715' },
  ];

  const PRESET_DEFAULTS = {
    obsidian: { accent: '#4d6bfe', canvas: '#13161d', sidebar: '#13161d', composer: '#0e1117', bubble: '#262b36', fg: '#f4f9ff', mutedFg: '#88929f', border: '#23262e' },
    claude: { accent: '#d97757', canvas: '#191919', sidebar: '#1f1f1f', composer: '#141414', bubble: '#292929', fg: '#fdfdfd', mutedFg: '#9c9395', border: '#2c2c2c' },
    nord: { accent: '#88c0d0', canvas: '#242933', sidebar: '#20242e', composer: '#2e3440', bubble: '#3b4252', fg: '#eceff4', mutedFg: '#9aa5b8', border: '#3b4252' },
    catppuccin: { accent: '#cba6f7', canvas: '#1e1e2e', sidebar: '#181825', composer: '#11111b', bubble: '#313244', fg: '#cdd6f4', mutedFg: '#a6adc8', border: '#313244' },
    rosepine: { accent: '#ebbcba', canvas: '#191724', sidebar: '#15131f', composer: '#1f1d2e', bubble: '#26233a', fg: '#e0def4', mutedFg: '#908caa', border: '#2a273f' },
    tokyo: { accent: '#7aa2f7', canvas: '#1a1b26', sidebar: '#16161e', composer: '#13141c', bubble: '#24283b', fg: '#c0caf5', mutedFg: '#787c99', border: '#292e42' },
    dracula: { accent: '#bd93f9', canvas: '#1e1f29', sidebar: '#191a23', composer: '#15161e', bubble: '#2d303f', fg: '#f8f8f2', mutedFg: '#9da5c4', border: '#343746' },
    emerald: { accent: '#34d399', canvas: '#0f1715', sidebar: '#0b1210', composer: '#131d1a', bubble: '#1a2a25', fg: '#ecfdf5', mutedFg: '#86a399', border: '#1f332c' },
  };

  const DEFAULT_TRUE_KEYS = new Set([
    'glassEffect',
    'wpPauseBlur',
    'sidebarRestyle',
    'sidebarFoldEmpty',
    'stageCollapse',
    'windowUnreadTitle',
    'branchSession',
    'messageEdit',
    'fileContextMenu',
    'taskProgressCard',
    'headerExtensionsBar',
    'sidebarExtensionsSection',
    'hideOnClose',
    'autoRelaunchWithCdp',
    'rewindPanel',
  ]);

  function allKeysOfGroup(group) {
    return [...(group.keys || []), ...(group.hudKeys || [])];
  }

  function isSwitchChecked(key, cfg) {
    if (key === 'mascot') return cfg[key] === 'crab';
    if (DEFAULT_TRUE_KEYS.has(key)) return cfg[key] !== false;
    return Boolean(cfg[key]);
  }

  function countEnabledInGroup(group, cfg, optionsMap) {
    let switches = 0;
    let enabled = 0;
    for (const k of allKeysOfGroup(group)) {
      if (optionsMap[k] || SLIDER_SPECS[k]) continue;
      switches++;
      if (isSwitchChecked(k, cfg)) enabled++;
    }
    return switches > 0 ? `${enabled}/${switches}` : `${allKeysOfGroup(group).length}`;
  }

  root.AGYPanelControlSchema = { I18N, GROUPS, allKeysOfGroup };

  root.AGYPanelControl = function initControlTab(app) {
    const collapsedGroups = new Set(GROUPS.filter((g) => !g.defaultOpen).map((g) => g.id));
    let hudDetailsOpen = false;
    let searchQuery = '';
    let wallpaperItems = [];
    let wallpaperLoaded = false;
    let wpUploading = false;

    function getT() {
      const lang = app.getConfig().language || 'zh-CN';
      return lang === 'en' ? I18N.en : I18N['zh-CN'];
    }

    function fmtSize(bytes) {
      const n = Number(bytes) || 0;
      if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
      if (n >= 1024) return `${Math.round(n / 1024)} KB`;
      return `${n} B`;
    }

    async function refreshWallpapers(rerender = true) {
      try {
        const res = await app.apiFetch('/api/wallpaper/list', { method: 'GET' });
        if (!res.ok) return;
        const data = await res.json();
        wallpaperItems = Array.isArray(data.items) ? data.items : [];
        wallpaperLoaded = true;
        if (rerender) renderForm(app.getConfig());
      } catch {}
    }

    function arrayBufferToBase64(buf) {
      const bytes = new Uint8Array(buf);
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    }

    async function uploadWallpaperFile(file, progressEl, barEl, t) {
      if (!file || wpUploading) return;
      wpUploading = true;
      if (progressEl) progressEl.classList.add('show');
      if (barEl) barEl.style.width = '5%';
      try {
        const chunkSize = 524288;
        const total = Math.max(1, Math.ceil(file.size / chunkSize));
        const uploadId = `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        let lastData = null;
        for (let index = 0; index < total; index++) {
          const slice = file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize));
          const buf = await slice.arrayBuffer();
          const chunkBase64 = arrayBufferToBase64(buf);
          const res = await app.apiFetch('/api/wallpaper/upload-chunk', {
            method: 'POST',
            body: JSON.stringify({ uploadId, index, total, fileName: file.name, chunkBase64 }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
          lastData = data;
          const pct = Math.round(((index + 1) / total) * 100);
          if (barEl) barEl.style.width = `${pct}%`;
        }
        if (lastData?.items) wallpaperItems = lastData.items;
        wallpaperLoaded = true;
        app.showToast(t.wpImportedToast);
        await app.refreshStatus();
      } catch (err) {
        app.showToast(t.saveErrToast(err?.message || String(err)));
      } finally {
        wpUploading = false;
        if (progressEl) progressEl.classList.remove('show');
        if (barEl) barEl.style.width = '0%';
      }
    }

    function syncFoldButton() {
      const btn = document.getElementById('btn-ctrl-fold');
      if (!btn) return;
      const t = getT();
      const allOpen = collapsedGroups.size === 0;
      btn.textContent = allOpen ? t.collapseAll : t.expandAll;
    }

    function renderCompanions(lastStatus, t) {
      const strip = document.getElementById('header-companions');
      if (!strip) return;
      if (!lastStatus) {
        strip.style.display = 'none';
        return;
      }
      const pages = lastStatus.cdp?.pages || [];
      const w = pages.filter((p) => p.kind === 'window').length;
      const s = pages.filter((p) => p.kind === 'swarm').length;
      const cap = lastStatus.companions?.capsule;
      const br = lastStatus.companions?.bridge;
      const chips = [
        { text: t.chipTargets(w, s), on: w + s > 0 },
        ...(cap?.installed ? [{ text: `agy-capsule${cap.version ? ' v' + cap.version : ''}`, on: cap.enabled }] : []),
        ...(br?.installed ? [{ text: `bridge${br.version ? ' v' + br.version : ''}`, on: br.enabled }] : []),
      ];
      strip.innerHTML = '';
      for (const c of chips) {
        const el = document.createElement('span');
        el.className = 'chip' + (c.on ? ' on' : '');
        el.textContent = c.text;
        strip.appendChild(el);
      }
      strip.style.display = chips.length > 0 ? 'flex' : 'none';
    }

    function renderStaticChrome() {
      const t = getT();
      const lastStatus = app.getLastStatus();
      document.getElementById('tab-control').textContent = t.tabControl;
      document.getElementById('tab-dashboard').textContent = t.tabDashboard;
      document.getElementById('tab-remote').textContent = t.tabRemote;
      document.getElementById('btn-reinject').textContent = t.btnReinject;
      document.getElementById('btn-remove').textContent = t.btnRemove;
      document.getElementById('btn-reset').textContent = t.btnReset;
      document.getElementById('btn-refresh').textContent = t.btnRefresh;
      document.getElementById('cdp-banner-title').textContent = t.cdpTitle;
      document.getElementById('cdp-banner-desc').textContent = t.cdpDesc;
      document.getElementById('btn-relaunch').textContent = t.btnRelaunch;
      const searchEl = document.getElementById('ctrl-search');
      if (searchEl) searchEl.placeholder = t.searchPlaceholder;
      syncFoldButton();

      if (lastStatus) {
        const pill = document.getElementById('status-pill');
        const stText = document.getElementById('status-text');
        const cdp = lastStatus.cdp || {};
        const isConnected = Boolean(cdp.connected || (cdp.port && !cdp.needsCdpRestart));
        const targetCount = cdp.pagesCount ?? cdp.pageCount ?? (Array.isArray(cdp.pages) ? cdp.pages.length : 0);
        pill.className = 'status-pill ' + (isConnected ? 'ok' : 'warn');
        stText.textContent = isConnected
          ? t.connected(cdp.port, targetCount)
          : cdp.port
          ? t.waitingPort
          : t.disconnected;
        document.getElementById('meta-line').textContent = t.metaLine(lastStatus.version || '4.0.0', Boolean(lastStatus.watcher?.alive));
        document.getElementById('cdp-banner').classList.toggle('show', !isConnected);
        if (!isConnected) {
          const guard = lastStatus.relaunchGuard || null;
          const descEl = document.getElementById('cdp-banner-desc');
          if (descEl) {
            if (guard?.tripped) {
              descEl.textContent = t.cdpTrippedDesc;
            } else if (guard?.lastAttemptAt && Date.now() - guard.lastAttemptAt < 120000) {
              const remSec = Math.max(1, Math.ceil((120000 - (Date.now() - guard.lastAttemptAt)) / 1000));
              descEl.textContent = t.cdpCooldownDesc(remSec);
            } else {
              descEl.textContent = t.cdpDesc;
            }
          }
        }
        const proxyBanner = document.getElementById('proxy-cold-banner');
        const pr = lastStatus.proxyRuntime || null;
        const cfg = app.getConfig();
        const showProxyCold = Boolean(cfg.proxyColdStartAlert !== false && pr?.coldStartMismatch);
        if (proxyBanner) {
          proxyBanner.classList.toggle('show', showProxyCold);
          if (showProxyCold) {
            document.getElementById('proxy-cold-title').textContent = t.proxyColdTitle;
            document.getElementById('proxy-cold-desc').textContent = pr.reason || '';
            document.getElementById('btn-proxy-cold-relaunch').textContent = t.proxyColdRelaunch;
          }
        }
        const studioBanner = document.getElementById('studio-conflict-banner');
        const studioConflict = Boolean(lastStatus.conflicts?.studio?.installed && lastStatus.conflicts?.studio?.enabled);
        if (studioBanner) {
          studioBanner.classList.toggle('show', studioConflict);
          if (studioConflict) {
            document.getElementById('studio-conflict-title').textContent = t.studioConflictTitle;
            document.getElementById('studio-conflict-desc').textContent = t.studioConflictDesc;
          }
        }
        renderCompanions(lastStatus, t);
      }
    }

    function buildThemeStudioCard(cfg, t) {
      const card = document.createElement('div');
      card.className = 'studio-subcard';
      const head = document.createElement('div');
      head.className = 'studio-subcard-head';
      head.innerHTML = `<span>🎨 ${t.themeStudioTitle}</span><span style="font-size:10px;color:var(--muted-fg);font-weight:400;">${t.themeStudioHint}</span>`;
      card.appendChild(head);

      const swatches = document.createElement('div');
      swatches.className = 'theme-swatches';
      const optLabelMap = new Map(t.options.palette || []);
      for (const sw of PRESET_SWATCHES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'theme-swatch-btn' + (cfg.palette === sw.id ? ' is-active' : '');
        btn.innerHTML = `<span class="theme-swatch-dot" style="background:linear-gradient(135deg,${sw.bg} 45%,${sw.accent} 55%);"></span><span>${optLabelMap.get(sw.id) || sw.id}</span>`;
        btn.addEventListener('click', () => app.saveOne('palette', sw.id));
        swatches.appendChild(btn);
      }
      const customBtn = document.createElement('button');
      customBtn.type = 'button';
      customBtn.className = 'theme-swatch-btn' + (cfg.palette === 'custom' ? ' is-active' : '');
      const curCt = cfg.customTheme && typeof cfg.customTheme === 'object' ? cfg.customTheme : {};
      customBtn.innerHTML = `<span class="theme-swatch-dot" style="background:${curCt.accent || '#4d6bfe'};"></span><span>${optLabelMap.get('custom') || 'Custom'}</span>`;
      customBtn.addEventListener('click', () => app.saveOne('palette', 'custom'));
      swatches.appendChild(customBtn);
      card.appendChild(swatches);

      if (cfg.palette === 'custom') {
        const panel = document.createElement('div');
        panel.className = 'theme-custom-controls';

        const baseId = PRESET_DEFAULTS[curCt.base] ? curCt.base : 'obsidian';
        const baseColors = PRESET_DEFAULTS[baseId];

        const toolbar = document.createElement('div');
        toolbar.className = 'theme-custom-toolbar';

        const modeSel = document.createElement('select');
        for (const [mVal, mLbl] of [['auto', t.themeModeAuto], ['dark', t.themeModeDark], ['light', t.themeModeLight]]) {
          const o = document.createElement('option');
          o.value = mVal;
          o.textContent = mLbl;
          if ((curCt.mode || 'auto') === mVal) o.selected = true;
          modeSel.appendChild(o);
        }
        modeSel.addEventListener('change', () => {
          app.saveOne('customTheme', { ...curCt, mode: modeSel.value });
        });
        toolbar.appendChild(modeSel);

        const cloneSel = document.createElement('select');
        const defOpt = document.createElement('option');
        defOpt.value = '';
        defOpt.textContent = t.themeCloneBtn + '…';
        cloneSel.appendChild(defOpt);
        for (const sw of PRESET_SWATCHES) {
          const o = document.createElement('option');
          o.value = sw.id;
          o.textContent = optLabelMap.get(sw.id) || sw.id;
          cloneSel.appendChild(o);
        }
        cloneSel.addEventListener('change', () => {
          const pick = cloneSel.value;
          if (!pick || !PRESET_DEFAULTS[pick]) return;
          app.saveOne('customTheme', { base: pick, mode: curCt.mode || 'auto', ...PRESET_DEFAULTS[pick] });
        });
        toolbar.appendChild(cloneSel);

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.textContent = t.themeResetBtn;
        resetBtn.style.minHeight = '26px';
        resetBtn.style.fontSize = '11px';
        resetBtn.addEventListener('click', () => app.saveOne('customTheme', {}));
        toolbar.appendChild(resetBtn);
        panel.appendChild(toolbar);

        const grid = document.createElement('div');
        grid.className = 'theme-color-grid';
        for (const tokenKey of Object.keys(t.themeTokens)) {
          const curVal = /^#[0-9a-fA-F]{6}$/.test(String(curCt[tokenKey] || ''))
            ? curCt[tokenKey]
            : baseColors[tokenKey];
          const item = document.createElement('label');
          item.className = 'theme-color-item';
          const colorIn = document.createElement('input');
          colorIn.type = 'color';
          colorIn.value = curVal;

          const meta = document.createElement('div');
          meta.className = 'theme-color-meta';
          const lbl = document.createElement('span');
          lbl.className = 'theme-color-name';
          lbl.textContent = t.themeTokens[tokenKey];
          const hexIn = document.createElement('input');
          hexIn.type = 'text';
          hexIn.className = 'theme-color-hex';
          hexIn.value = curVal;
          hexIn.maxLength = 7;

          colorIn.addEventListener('input', () => {
            hexIn.value = colorIn.value;
          });
          colorIn.addEventListener('change', () => {
            app.saveOne('customTheme', { ...curCt, base: baseId, [tokenKey]: colorIn.value });
          });
          hexIn.addEventListener('change', () => {
            const v = hexIn.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(v)) {
              colorIn.value = v;
              app.saveOne('customTheme', { ...curCt, base: baseId, [tokenKey]: v.toLowerCase() });
            } else {
              hexIn.value = colorIn.value;
            }
          });

          meta.appendChild(lbl);
          meta.appendChild(hexIn);
          item.appendChild(colorIn);
          item.appendChild(meta);
          grid.appendChild(item);
        }
        panel.appendChild(grid);
        card.appendChild(panel);
      }
      return card;
    }

    function buildWallpaperStudioCard(cfg, t) {
      if (!wallpaperLoaded) {
        wallpaperLoaded = true;
        void refreshWallpapers(true);
      }
      const card = document.createElement('div');
      card.className = 'studio-subcard';

      const head = document.createElement('div');
      head.className = 'studio-subcard-head';
      head.innerHTML = `<span>🎬 ${t.wpStudioTitle}</span><span style="font-size:10px;color:var(--muted-fg);">${wallpaperItems.length}</span>`;
      card.appendChild(head);

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.mp4,.webm,.gif,.webp,.png,.jpg,.jpeg,video/mp4,video/webm,image/*';
      fileInput.style.display = 'none';

      const progressWrap = document.createElement('div');
      progressWrap.className = 'wp-progress';
      const progressBar = document.createElement('div');
      progressBar.className = 'wp-progress-bar';
      progressWrap.appendChild(progressBar);

      const dropzone = document.createElement('div');
      dropzone.className = 'wp-dropzone';
      dropzone.innerHTML = `<div class="wp-drop-title">${t.wpDropTitle}</div><div class="wp-drop-sub">${t.wpDropSub}</div>`;
      dropzone.addEventListener('click', () => fileInput.click());
      dropzone.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        dropzone.classList.add('is-dragover');
      });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
      dropzone.addEventListener('drop', (ev) => {
        ev.preventDefault();
        dropzone.classList.remove('is-dragover');
        const f = ev.dataTransfer?.files?.[0];
        if (f) void uploadWallpaperFile(f, progressWrap, progressBar, t);
      });
      fileInput.addEventListener('change', () => {
        const f = fileInput.files?.[0];
        fileInput.value = '';
        if (f) void uploadWallpaperFile(f, progressWrap, progressBar, t);
      });

      card.appendChild(fileInput);
      card.appendChild(dropzone);
      card.appendChild(progressWrap);

      const pathRow = document.createElement('div');
      pathRow.className = 'wp-path-row';
      const pathInput = document.createElement('input');
      pathInput.type = 'text';
      pathInput.placeholder = t.wpPathPlaceholder;
      const importBtn = document.createElement('button');
      importBtn.type = 'button';
      importBtn.textContent = t.wpImportBtn;
      importBtn.addEventListener('click', async () => {
        const fp = pathInput.value.trim();
        if (!fp) return;
        importBtn.disabled = true;
        try {
          const res = await app.apiFetch('/api/wallpaper/import-path', {
            method: 'POST',
            body: JSON.stringify({ filePath: fp }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
          pathInput.value = '';
          if (data.items) wallpaperItems = data.items;
          app.showToast(t.wpImportedToast);
          await app.refreshStatus();
        } catch (err) {
          app.showToast(t.saveErrToast(err?.message || String(err)));
        } finally {
          importBtn.disabled = false;
        }
      });
      pathRow.appendChild(pathInput);
      pathRow.appendChild(importBtn);
      card.appendChild(pathRow);

      const gallery = document.createElement('div');
      gallery.className = 'wp-gallery';
      if (wallpaperItems.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:11px;color:var(--muted-fg);text-align:center;padding:6px 0;';
        empty.textContent = t.wpEmpty;
        gallery.appendChild(empty);
      } else {
        for (const it of wallpaperItems) {
          const row = document.createElement('div');
          row.className = 'wp-item' + (cfg.wpFile === it.name ? ' is-active' : '');
          if (it.previewUrl && it.kind === 'video') {
            const v = document.createElement('video');
            v.className = 'wp-thumb';
            v.src = it.previewUrl;
            v.muted = true;
            v.playsInline = true;
            v.preload = 'metadata';
            row.appendChild(v);
          } else if (it.previewUrl) {
            const img = document.createElement('img');
            img.className = 'wp-thumb';
            img.src = it.previewUrl;
            img.alt = '';
            row.appendChild(img);
          }
          const meta = document.createElement('div');
          meta.className = 'wp-item-meta';
          const nameEl = document.createElement('div');
          nameEl.className = 'wp-item-name';
          nameEl.textContent = it.name;
          const subEl = document.createElement('div');
          subEl.className = 'wp-item-sub';
          subEl.textContent = `${it.kind === 'video' ? 'VIDEO' : 'IMAGE'} · ${fmtSize(it.size)}`;
          meta.appendChild(nameEl);
          meta.appendChild(subEl);
          row.appendChild(meta);

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'wp-item-del';
          delBtn.textContent = t.wpDelBtn;
          delBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const res = await app.apiFetch('/api/wallpaper/delete', {
              method: 'POST',
              body: JSON.stringify({ name: it.name }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) {
              wallpaperItems = data.items || [];
              await app.refreshStatus();
            }
          });
          row.appendChild(delBtn);

          row.addEventListener('click', () => {
            const updates = { wpFile: it.name };
            if (!cfg.wpMode || cfg.wpMode === 'off') updates.wpMode = 'global';
            void app.saveUpdates(updates);
          });
          gallery.appendChild(row);
        }
      }
      card.appendChild(gallery);
      return card;
    }

    function buildSettingRow(key, cfg, t) {
      const [name, desc] = t.labels[key] || [key, ''];
      const options = t.options[key];
      const sliderSpec = SLIDER_SPECS[key] || null;
      const rule = SUBROW_RULES[key] || null;
      const isSubrow = Boolean(rule);
      const dimmed = rule && typeof rule.dim === 'function' ? Boolean(rule.dim(cfg)) : false;
      const badgeText = rule?.badgeKey ? t[rule.badgeKey] : '';

      const row = document.createElement('div');
      row.className = 'row' + (isSubrow ? ' is-subrow' : '') + (dimmed ? ' is-dimmed' : '');
      const labelDiv = document.createElement('div');
      labelDiv.className = 'row-label';
      const badgeHtml = badgeText ? `<span class="row-badge">${badgeText}</span>` : '';
      labelDiv.innerHTML = `<div class="row-name">${name}${badgeHtml}</div>${desc ? `<div class="row-desc">${desc}</div>` : ''}`;
      row.appendChild(labelDiv);

      if (sliderSpec) {
        const wrap = document.createElement('div');
        wrap.className = 'range-ctl';
        const range = document.createElement('input');
        range.type = 'range';
        range.min = String(sliderSpec.min);
        range.max = String(sliderSpec.max);
        range.step = String(sliderSpec.step);
        const curVal = Number.isFinite(Number(cfg[key])) ? Number(cfg[key]) : sliderSpec.def;
        range.value = String(curVal);
        range.disabled = dimmed;
        const valSpan = document.createElement('span');
        valSpan.className = 'range-val';
        valSpan.textContent = `${curVal}${sliderSpec.unit}`;
        range.addEventListener('input', () => {
          valSpan.textContent = `${range.value}${sliderSpec.unit}`;
        });
        range.addEventListener('change', () => {
          app.saveOne(key, parseInt(range.value, 10));
        });
        wrap.appendChild(range);
        wrap.appendChild(valSpan);
        row.appendChild(wrap);
      } else if (!options) {
        const sw = document.createElement('label');
        sw.className = 'switch';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = isSwitchChecked(key, cfg);
        cb.disabled = dimmed;
        cb.addEventListener('change', () => app.saveOne(key, key === 'mascot' ? (cb.checked ? 'crab' : 'off') : cb.checked));
        const track = document.createElement('span');
        track.className = 'switch-track';
        sw.appendChild(cb);
        sw.appendChild(track);
        row.appendChild(sw);
      } else {
        const sel = document.createElement('select');
        sel.disabled = dimmed;
        for (const [val, text] of options) {
          const opt = document.createElement('option');
          opt.value = val;
          opt.textContent = text;
          if (cfg[key] === val) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.addEventListener('change', () => app.saveOne(key, sel.value));
        row.appendChild(sel);
      }
      return row;
    }

    function renderForm(cfg) {
      const t = getT();
      const container = document.getElementById('sections');
      const q = searchQuery.trim().toLowerCase();
      container.innerHTML = '';
      let matchedGroups = 0;

      const matchesKey = (key) => {
        const [name, desc] = t.labels[key] || [key, ''];
        return `${key} ${name} ${desc}`.toLowerCase().includes(q);
      };

      for (const group of GROUPS) {
        const groupTitle = String(t[group.titleKey] || '');
        const groupMatches = q && groupTitle.toLowerCase().includes(q);
        const visibleMainKeys = q
          ? group.keys.filter((key) => groupMatches || matchesKey(key))
          : group.keys;
        const visibleHudKeys = Array.isArray(group.hudKeys)
          ? q
            ? group.hudKeys.filter((key) => groupMatches || matchesKey(key))
            : group.hudKeys
          : [];
        if (visibleMainKeys.length === 0 && visibleHudKeys.length === 0) continue;
        matchedGroups++;

        const isCollapsed = !q && collapsedGroups.has(group.id);
        const sec = document.createElement('div');
        sec.className = 'section' + (isCollapsed ? ' collapsed' : '');

        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'section-head';
        const badgeText = q
          ? `${visibleMainKeys.length + visibleHudKeys.length}`
          : countEnabledInGroup(group, cfg, t.options);
        head.innerHTML = `<span class="section-title"><span>${group.icon}</span><span>${groupTitle}</span></span><span style="display:inline-flex;align-items:center;gap:6px;"><span class="section-badge">${badgeText}</span><span class="section-chev">▾</span></span>`;
        head.addEventListener('click', () => {
          if (collapsedGroups.has(group.id)) collapsedGroups.delete(group.id);
          else collapsedGroups.add(group.id);
          sec.classList.toggle('collapsed');
          syncFoldButton();
        });
        sec.appendChild(head);

        const body = document.createElement('div');
        body.className = 'section-body';
        for (const key of visibleMainKeys) {
          body.appendChild(buildSettingRow(key, cfg, t));
          if (key === 'palette' && !q) {
            body.appendChild(buildThemeStudioCard(cfg, t));
          }
          if (key === 'wpMode' && !q) {
            body.appendChild(buildWallpaperStudioCard(cfg, t));
          }
        }

        if (visibleHudKeys.length > 0) {
          const details = document.createElement('details');
          details.className = 'ctrl-subdetails';
          details.open = Boolean(q) || hudDetailsOpen;
          details.addEventListener('toggle', () => {
            if (!q) hudDetailsOpen = details.open;
          });
          const toggleHudKeys = visibleHudKeys.filter((k) => !t.options[k]);
          const enabledHud = toggleHudKeys.filter((k) => isSwitchChecked(k, cfg)).length;
          const summary = document.createElement('summary');
          summary.innerHTML = `<span>${t.hudDetailsLabel}</span><span class="section-badge">${enabledHud}/${toggleHudKeys.length}</span>`;
          details.appendChild(summary);
          const subList = document.createElement('div');
          subList.className = 'ctrl-subdetails-body';
          for (const key of visibleHudKeys) {
            subList.appendChild(buildSettingRow(key, cfg, t));
          }
          details.appendChild(subList);
          body.appendChild(details);
        }

        sec.appendChild(body);
        container.appendChild(sec);
      }

      if (matchedGroups === 0) {
        const empty = document.createElement('div');
        empty.className = 'ctrl-empty';
        empty.textContent = t.emptySearch;
        container.appendChild(empty);
      }
      syncFoldButton();
    }

    const searchInput = document.getElementById('ctrl-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value || '';
        renderForm(app.getConfig());
      });
    }
    const foldBtn = document.getElementById('btn-ctrl-fold');
    if (foldBtn) {
      foldBtn.addEventListener('click', () => {
        if (collapsedGroups.size === 0) {
          for (const g of GROUPS) collapsedGroups.add(g.id);
        } else {
          collapsedGroups.clear();
        }
        renderForm(app.getConfig());
      });
    }

    document.getElementById('btn-reinject').addEventListener('click', () => app.postAction('/api/reinject', 'btnReinject'));
    document.getElementById('btn-remove').addEventListener('click', () => app.postAction('/api/remove', 'btnRemove'));
    document.getElementById('btn-reset').addEventListener('click', () => app.postAction('/api/reset', 'btnReset'));
    document.getElementById('btn-refresh').addEventListener('click', () => {
      wallpaperLoaded = false;
      void app.refreshStatus();
    });
    document.getElementById('btn-relaunch').addEventListener('click', () => app.postAction('/api/relaunch', 'btnRelaunch'));
    const proxyColdBtn = document.getElementById('btn-proxy-cold-relaunch');
    if (proxyColdBtn) {
      proxyColdBtn.addEventListener('click', () => app.postAction('/api/relaunch', 'btnRelaunch'));
    }

    return { getT, renderStaticChrome, renderForm };
  };
})(typeof window !== 'undefined' ? window : globalThis);
