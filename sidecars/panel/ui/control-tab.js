// Tab 1: Control Room module for AGY Claude Style Aux Pane.
// Preserves upstream origin/main's exact 3 base sections, titles, ordering, conditional badges,
// and collapsible HUD sub-section, with PR #19 efficiency & extension features in a dedicated 4th section.
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
      grpAppearance: '外观与版面',
      grpInteraction: '交互与思考滑块',
      grpTelemetry: 'Token 用量与环绕 HUD',
      grpPowertools: '效率增强与扩展',
      metaLine: (v, alive) => `v${v} · 宿主${alive ? '运行中' : '未就绪'}`,
      chipTargets: (w, s) => `窗口 ${w}${s ? ` · Swarm ${s}` : ''}`,
      savedToast: (k) => `已更新 ${k} 并实时同步`,
      saveErrToast: (e) => `保存失败: ${e}`,
      actionOk: (a) => `${a} 完成`, actionFail: (a, e) => `${a} 失败: ${e}`,
      labels: {
        // 1. 外观与版面 (origin/main base order)
        language: ['界面语言', '切换 Antigravity 界面与插件面板语言（简繁粤英日）'],
        homeLayout: ['首页版面', '切换新对话首页布局（仪表盘、居中或原生关闭）'],
        palette: ['配色方案', '选择深邃蓝黑、Claude 暖色或跟随宿主主题'],
        glassEffect: ['全局毛玻璃材质', '为顶栏、输入框、弹层与侧栏启用细腻磨砂玻璃效果'],
        logoInk: ['Antigravity Logo 着色', '首页问候图标使用主题强调色或前景色'],
        sidebarRestyle: ['侧栏 Claude 风格', '统一侧边栏行高、图标与悬停高亮样式'],
        sidebarCompact: ['紧凑侧边栏', '压缩对话行高，同屏展示更多会话'],
        composerRestyle: ['极简输入框重排', '极简圆角输入框卡片与画布底栏样式'],
        placeholderStyle: ['输入框占位提示', '使用工作台提示文案或跟随宿主原生'],
        compactChatLayout: ['紧凑对话正文排版', '保持字号不变，收紧正文行高与段落间距提高单屏信息密度'],
        // 2. 交互与思考滑块 (origin/main base order)
        effortSliderStyle: ['思考强度滑块风格', '选择推理强度滑块样式（Claude Code / ChatGPT Codex / 梁武峰）'],
        effortAccent: ['Claude 推理色阶强调', '在 Claude 滑块与像素矩阵上启用蓝紫色阶高亮'],
        performanceBackdrop: ['梁武峰 性能人像背景', '选择梁武峰模式下 31 帧人像剪影的渲染区域'],
        smoothCaret: ['平滑输入光标', '输入框启用流畅过渡光标动画'],
        mascot: ['输入框像素螃蟹挂件', '在输入框/首页展示像素风小螃蟹动态彩蛋'],
        homeRipple: ['首页字符矩阵波纹', '在欢迎页呈现柔和字符矩阵水波背景'],
        // 3. Token 用量与环绕 HUD (origin/main base order)
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
        // 4. 效率增强与扩展 (PR #19 additions)
        taskProgressCard: ['任务进度浮窗', '实时阶段环、等待计时、工具时间轴与子智能体展开'],
        stageCollapse: ['阶段汇报与自动折叠', '在原生对话中开启简短阶段汇报，整轮结束后自动折叠进原生用时栏并内联展示步骤计数'],
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
        palette: [['obsidian', '深邃蓝黑'], ['claude', 'Claude'], ['host', '跟随宿主']],
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
      grpAppearance: 'Appearance & Layout',
      grpInteraction: 'Slider, Caret & Mascot',
      grpTelemetry: 'Usage Ring & HUD',
      grpPowertools: 'Productivity & Extensions',
      metaLine: (v, alive) => `v${v} · Host ${alive ? 'Running' : 'Idle'}`,
      chipTargets: (w, s) => `Win ${w}${s ? ` · Swarm ${s}` : ''}`,
      savedToast: (k) => `Updated ${k}`, saveErrToast: (e) => `Save failed: ${e}`,
      actionOk: (a) => `${a} succeeded`, actionFail: (a, e) => `${a} failed: ${e}`,
      labels: {
        language: ['Interface Language', 'Switch display language for Antigravity UI and plugin panels'],
        homeLayout: ['Home Layout', 'Switch new-conversation home layout'],
        palette: ['Color Palette', 'Pick Obsidian, Claude palette, or follow host'],
        glassEffect: ['Frosted Glass Material', 'Subtle frosted glass blur for bars, composer and menus'],
        logoInk: ['Logo Color', 'Tint of the Antigravity greeting mark'],
        sidebarRestyle: ['Sidebar Restyle', 'Apply Claude-style row height and hover plates to sidebar'],
        sidebarCompact: ['Compact Sidebar', 'Tighter row height for more sessions'],
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
        stageCollapse: ['Stage Updates & Auto-Collapse', 'Enable concise native stage updates and auto-fold completed steps into the native duration header'],
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
        palette: [['obsidian', 'Obsidian'], ['claude', 'Claude'], ['host', 'Host']],
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

  // Based on upstream origin/main's exact 3 groups + ordering, followed by PR #19 efficiency/extensions group
  const GROUPS = [
    {
      id: 'appearance',
      icon: '🎨',
      titleKey: 'grpAppearance',
      defaultOpen: true,
      keys: ['language', 'homeLayout', 'palette', 'glassEffect', 'logoInk', 'sidebarRestyle', 'sidebarCompact', 'composerRestyle', 'placeholderStyle', 'compactChatLayout'],
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
      keys: ['taskProgressCard', 'stageCollapse', 'windowUnreadTitle', 'branchSession', 'messageEdit', 'fileContextMenu', 'rewindPanel', 'undoConfirmMode', 'headerExtensionsBar', 'sidebarExtensionsSection', 'hideOnClose', 'autoRelaunchWithCdp'],
    },
  ];

  const SUBROW_RULES = {
    sidebarCompact: { dim: (cfg) => !cfg.sidebarRestyle },
    placeholderStyle: { dim: (cfg) => !cfg.composerRestyle },
    effortAccent: { badgeKey: 'badgeClaude', dim: (cfg) => (cfg.effortSliderStyle || 'claude') !== 'claude' },
    performanceBackdrop: { badgeKey: 'badgeLwf', dim: (cfg) => cfg.effortSliderStyle !== 'liangwufeng' },
    undoConfirmMode: { dim: (cfg) => cfg.rewindPanel === false },
    quotaCycleMode: { dim: (cfg) => (cfg.ringMode || 'context') === 'context' && !(cfg.hudRimProgress === true && cfg.hudRimSource === 'quota') },
    hudRimSource: { dim: (cfg) => !cfg.hudRimProgress },
    hudCompact: { dim: (cfg) => !cfg.hudTopBar && !cfg.hudBottomBar && !cfg.hudRimProgress && !cfg.hudFooterChip },
  };

  const DEFAULT_TRUE_KEYS = new Set([
    'glassEffect',
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
      if (optionsMap[k]) continue;
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

    function getT() {
      const lang = app.getConfig().language || 'zh-CN';
      return lang === 'en' ? I18N.en : I18N['zh-CN'];
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
        document.getElementById('meta-line').textContent = t.metaLine(lastStatus.version || '2.1.0', Boolean(lastStatus.watcher?.alive));
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

    function buildSettingRow(key, cfg, t) {
      const [name, desc] = t.labels[key] || [key, ''];
      const options = t.options[key];
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

      if (!options) {
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
        }

        if (visibleHudKeys.length > 0) {
          const details = document.createElement('details');
          details.className = 'ctrl-subdetails';
          details.open = Boolean(q) || hudDetailsOpen;
          details.addEventListener('toggle', () => {
            if (!q) hudDetailsOpen = details.open;
          });
          const enabledHud = visibleHudKeys.filter((k) => isSwitchChecked(k, cfg)).length;
          const summary = document.createElement('summary');
          summary.innerHTML = `<span>${t.hudDetailsLabel}</span><span class="section-badge">${enabledHud}/${visibleHudKeys.length}</span>`;
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
    document.getElementById('btn-refresh').addEventListener('click', () => app.refreshStatus());
    document.getElementById('btn-relaunch').addEventListener('click', () => app.postAction('/api/relaunch', 'btnRelaunch'));
    const proxyColdBtn = document.getElementById('btn-proxy-cold-relaunch');
    if (proxyColdBtn) {
      proxyColdBtn.addEventListener('click', () => app.postAction('/api/relaunch', 'btnRelaunch'));
    }

    return { getT, renderStaticChrome, renderForm };
  };
})(typeof window !== 'undefined' ? window : globalThis);
