// Tab 1: Control Room module for AGY Claude Style Aux Pane.
(function (root) {
  const I18N = {
    'zh-CN': {
      tabControl: '⚙ 控制室', tabDashboard: '📊 用量看板', tabRemote: '🌐 代理与远程',
      connected: (p, n) => `CDP :${p} · ${n} 目标`,
      waitingPort: '等待 CDP', disconnected: '未连接',
      btnReinject: '✦ 立即应用并刷新', btnRemove: '还原原生', btnReset: '恢复默认', btnRefresh: '刷新状态',
      btnRelaunch: '一键带调试端口重启', relaunching: '正在重启 Antigravity…',
      cdpTitle: '未检测到 Antigravity 调试端口',
      cdpDesc: 'Antigravity 2.33+ 默认关闭 CDP 调试端口，点击下方按钮可带参安全重启。',
      grpBasics: '外观与基础', grpPowertools: '会话增强与效率', grpLayout: '界面与布局', grpTelemetry: '用量、圆环与思考深度',
      metaLine: (v, alive) => `v${v} · 宿主${alive ? '运行中' : '未就绪'}`,
      chipTargets: (w, s) => `窗口 ${w}${s ? ` · Swarm ${s}` : ''}`,
      savedToast: (k) => `已更新 ${k} 并实时同步`,
      saveErrToast: (e) => `保存失败: ${e}`,
      actionOk: (a) => `${a} 完成`, actionFail: (a, e) => `${a} 失败: ${e}`,
      labels: {
        language: ['界面语言', '支持中英粤日韩 5 语言实时切换'],
        palette: ['配色主题', '默认遵循 Antigravity 主题，可选 Claude 暖色或黑曜石'],
        glassEffect: ['全局毛玻璃材质', '为顶栏、输入框、弹层与侧栏启用细腻磨砂玻璃效果'],
        homeLayout: ['主页布局', '工作台或经典单栏'],
        homeRipple: ['主页星云水波', '在欢迎页呈现柔和涟漪背景'],
        sidebarRestyle: ['侧边栏风格化', '统一侧边栏间距与柔和边框'],
        sidebarCompact: ['紧凑侧边栏', '压缩项目行高，展示更多对话'],
        composerRestyle: ['输入框卡片美化', '增强输入框圆角与光晕层次'],
        mascot: ['像素小螃蟹', '在主页标题区展示像素风小螃蟹彩蛋'],
        logoInk: ['品牌 Logo 着色', '品牌图标使用主强调色或中性色'],
        placeholderStyle: ['输入框占位提示', '工作台或极简占位文案'],
        rewindPanel: ['Rewind 回退面板', '开启侧边回退目录与一键撤销到历史节点'],
        undoConfirmMode: ['撤销确认方式', '回退前弹出模式选择器、仅提示或立即执行'],
        taskProgressCard: ['任务进度浮窗', '显示实时阶段、进度环、工具时间轴与子智能体二级展开（可拖拽，Overview 打开时自动内嵌）'],
        branchSession: ['原生分支会话', '在每轮 AI 回复原生操作栏添加「分支」图标，保留上下文分叉新会话'],
        messageEdit: ['原位消息编辑', '在已发消息原生操作栏添加「编辑」图标，原位多行修改并重发'],
        fileContextMenu: ['文件右键菜单', '右键消息文件链接或文件树可引用、打开、Finder 定位、复制文件/路径'],
        effortSliderStyle: ['思考深度滑块', 'Claude 分段滑块或原生下拉样式'],
        effortAccent: ['思考深度强调色', '滑块高亮同步当前主色调'],
        performanceBackdrop: ['性能模式背景', '大对话下关闭昂贵模糊特效保持流畅'],
        smoothCaret: ['平滑输入光标', '输入框启用流畅过渡光标动画'],
        inlineStats: ['底栏用量指标', '在输入框底栏展示 Token 与上下文统计'],
        ringMode: ['圆环显示模式', '支持经典单环或 5h/周限额双圆环模式'],
        turnBadges: ['轮次与耗时徽章', '在每轮回复旁展示耗时与轮次标记'],
        hudTopBar: ['顶部上下文进度条', '在对话顶部显示细长上下文占用条'],
        hudBottomBar: ['底部精简 HUD', '在输入框下方显示 Token 摘要'],
        hudRimProgress: ['边缘进度光晕', '以细腻边框光带指示上下文进度'],
        hudFooterChip: ['底栏紧凑胶囊', '保留精简底栏信息芯片'],
        hudCompact: ['紧凑 HUD 排版', '收窄 HUD 内边距与字号'],
      },
      options: {
        language: [['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['yue', '粵語'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어']],
        palette: [['auto', '跟随宿主'], ['claude', 'Claude 暖色'], ['obsidian', '黑曜石']],
        homeLayout: [['studio', '工作台'], ['classic', '经典单栏']],
        logoInk: [['accent', '主题强调色'], ['mono', '中性单色']],
        placeholderStyle: [['studio', '工作台'], ['minimal', '极简'], ['classic', '原生']],
        undoConfirmMode: [['picker', '模式选择弹窗'], ['prompt', '二次确认'], ['instant', '直接撤销']],
        effortSliderStyle: [['claude', 'Claude 滑块'], ['native', '原生样式']],
        performanceBackdrop: [['card', '卡片背景'], ['transparent', '透明背景'], ['off', '关闭']],
        ringMode: [['single', '单环（上下文）'], ['both', '双圆环（+配额）']],
      },
    },
    en: {
      tabControl: '⚙ Studio', tabDashboard: '📊 Dashboard', tabRemote: '🌐 Proxy & SSH',
      connected: (p, n) => `CDP :${p} · ${n} targets`,
      waitingPort: 'Waiting for CDP', disconnected: 'Disconnected',
      btnReinject: '✦ Apply & Refresh Now', btnRemove: 'Restore Native', btnReset: 'Reset Defaults', btnRefresh: 'Refresh',
      btnRelaunch: 'Relaunch with Debug Port', relaunching: 'Relaunching Antigravity…',
      cdpTitle: 'Antigravity Debug Port Not Detected',
      cdpDesc: 'Antigravity 2.33+ disables CDP by default. Click below to relaunch safely with CDP.',
      grpBasics: 'Appearance & Basics', grpPowertools: 'Session & Productivity', grpLayout: 'Layout & UI', grpTelemetry: 'Usage, Rings & Effort',
      metaLine: (v, alive) => `v${v} · Host ${alive ? 'Running' : 'Idle'}`,
      chipTargets: (w, s) => `Win ${w}${s ? ` · Swarm ${s}` : ''}`,
      savedToast: (k) => `Updated ${k}`, saveErrToast: (e) => `Save failed: ${e}`,
      actionOk: (a) => `${a} succeeded`, actionFail: (a, e) => `${a} failed: ${e}`,
      labels: {
        language: ['Interface Language', 'Live switch across 5 languages'],
        palette: ['Color Palette', 'Follow Antigravity theme, Claude warm, or Obsidian'],
        glassEffect: ['Frosted Glass Material', 'Subtle frosted glass blur for bars, composer, and menus'],
        homeLayout: ['Home Layout', 'Studio workspace or classic single column'],
        homeRipple: ['Home Ripple', 'Subtle ambient ripple on welcome canvas'],
        sidebarRestyle: ['Sidebar Styling', 'Unified spacing and soft borders'],
        sidebarCompact: ['Compact Sidebar', 'Tighter row height for more sessions'],
        composerRestyle: ['Composer Card', 'Enhanced radius and elevation'],
        mascot: ['Pixel Crab Mascot', 'Show pixel crab easter egg in header'],
        logoInk: ['Brand Logo Ink', 'Accent or monochrome brand icon'],
        placeholderStyle: ['Input Placeholder', 'Studio, minimal, or native copy'],
        rewindPanel: ['Rewind Panel', 'Sidebar turn directory with one-click rewind'],
        undoConfirmMode: ['Undo Confirm Mode', 'Picker modal, prompt, or instant revert'],
        taskProgressCard: ['Task Progress Panel', 'Live phase ring, tool timeline & expandable subagent menu (draggable; docks in Overview)'],
        branchSession: ['Session Branching', 'Add Branch icon in native action bar to fork conversation'],
        messageEdit: ['In-Place Message Edit', 'Add Edit icon on sent prompts to edit inline & resend'],
        fileContextMenu: ['File Context Menu', 'Right-click chat file links or tree to attach, open, reveal, or copy'],
        effortSliderStyle: ['Effort Slider', 'Claude segmented slider or native dropdown'],
        effortAccent: ['Effort Accent', 'Match effort slider tint to active accent'],
        performanceBackdrop: ['Performance Backdrop', 'Lighter backdrop for large threads'],
        smoothCaret: ['Smooth Caret', 'Animated caret transitions in composer'],
        inlineStats: ['Footer Usage Stats', 'Show token and context metrics in footer'],
        ringMode: ['Ring Mode', 'Single context ring or dual rings (+5h/weekly quota)'],
        turnBadges: ['Turn & Duration Badges', 'Per-turn duration and index pills'],
        hudTopBar: ['Top Progress Bar', 'Thin context bar along chat top'],
        hudBottomBar: ['Bottom Mini HUD', 'Compact token bar below composer'],
        hudRimProgress: ['Rim Progress Halo', 'Subtle perimeter context indicator'],
        hudFooterChip: ['Footer Chip', 'Compact usage chip in footer'],
        hudCompact: ['Compact HUD', 'Tighter padding and typography'],
      },
      options: {
        language: [['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['yue', '粵語'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어']],
        palette: [['auto', 'Follow Host'], ['claude', 'Claude Warm'], ['obsidian', 'Obsidian']],
        homeLayout: [['studio', 'Studio'], ['classic', 'Classic']],
        logoInk: [['accent', 'Accent'], ['mono', 'Monochrome']],
        placeholderStyle: [['studio', 'Studio'], ['minimal', 'Minimal'], ['classic', 'Native']],
        undoConfirmMode: [['picker', 'Mode Picker'], ['prompt', 'Prompt'], ['instant', 'Instant']],
        effortSliderStyle: [['claude', 'Claude Slider'], ['native', 'Native']],
        performanceBackdrop: [['card', 'Card'], ['transparent', 'Transparent'], ['off', 'Off']],
        ringMode: [['single', 'Single Ring'], ['both', 'Dual Rings (+Quota)']],
      },
    },
  };

  const GROUPS = [
    {
      id: 'basics',
      icon: '🎨',
      titleKey: 'grpBasics',
      keys: ['language', 'palette', 'glassEffect', 'performanceBackdrop'],
      showCompanions: true,
    },
    {
      id: 'layout',
      icon: '🧩',
      titleKey: 'grpLayout',
      keys: ['homeLayout', 'homeRipple', 'sidebarRestyle', 'sidebarCompact', 'composerRestyle', 'placeholderStyle', 'mascot', 'logoInk', 'smoothCaret'],
    },
    {
      id: 'powertools',
      icon: '⚡',
      titleKey: 'grpPowertools',
      keys: ['taskProgressCard', 'branchSession', 'messageEdit', 'fileContextMenu', 'rewindPanel', 'undoConfirmMode'],
    },
    {
      id: 'telemetry',
      icon: '📊',
      titleKey: 'grpTelemetry',
      keys: ['inlineStats', 'ringMode', 'turnBadges', 'effortSliderStyle', 'effortAccent', 'hudTopBar', 'hudBottomBar', 'hudRimProgress', 'hudFooterChip', 'hudCompact'],
    },
  ];

  root.AGYPanelControl = function initControlTab(app) {
    const collapsedGroups = new Set(['layout', 'telemetry']);

    function getT() {
      const lang = app.getConfig().language || 'zh-CN';
      return lang === 'en' ? I18N.en : I18N['zh-CN'];
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
      }
    }

    function renderForm(cfg) {
      const t = getT();
      const lastStatus = app.getLastStatus();
      const container = document.getElementById('sections');
      container.innerHTML = '';
      for (const group of GROUPS) {
        const sec = document.createElement('div');
        sec.className = 'section' + (collapsedGroups.has(group.id) ? ' collapsed' : '');

        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'section-head';
        head.innerHTML = `<span class="section-title"><span>${group.icon}</span><span>${t[group.titleKey]}</span></span><span style="display:inline-flex;align-items:center;gap:6px;"><span class="section-badge">${group.keys.length}</span><span class="section-chev">▾</span></span>`;
        head.addEventListener('click', () => {
          if (collapsedGroups.has(group.id)) collapsedGroups.delete(group.id);
          else collapsedGroups.add(group.id);
          sec.classList.toggle('collapsed');
        });
        sec.appendChild(head);

        const body = document.createElement('div');
        body.className = 'section-body';
        for (const key of group.keys) {
          const [name, desc] = t.labels[key] || [key, ''];
          const options = t.options[key];
          const dimmed = key === 'undoConfirmMode' && cfg.rewindPanel === false;

          const row = document.createElement('div');
          row.className = 'row' + (dimmed ? ' is-dimmed' : '');
          const labelDiv = document.createElement('div');
          labelDiv.className = 'row-label';
          labelDiv.innerHTML = `<div class="row-name">${name}</div>${desc ? `<div class="row-desc">${desc}</div>` : ''}`;
          row.appendChild(labelDiv);

          if (!options) {
            const sw = document.createElement('label');
            sw.className = 'switch';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked =
              key === 'glassEffect' || key === 'branchSession' || key === 'messageEdit' || key === 'fileContextMenu' || key === 'taskProgressCard'
                ? cfg[key] !== false
                : key === 'mascot'
                ? cfg[key] === 'crab'
                : Boolean(cfg[key]);
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
          body.appendChild(row);
        }

        if (group.showCompanions && lastStatus) {
          const strip = document.createElement('div');
          strip.className = 'companion-strip';
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
          for (const c of chips) {
            const el = document.createElement('span');
            el.className = 'chip' + (c.on ? ' on' : '');
            el.textContent = c.text;
            strip.appendChild(el);
          }
          body.appendChild(strip);
        }
        sec.appendChild(body);
        container.appendChild(sec);
      }
    }

    document.getElementById('btn-reinject').addEventListener('click', () => app.postAction('/api/reinject', 'btnReinject'));
    document.getElementById('btn-remove').addEventListener('click', () => app.postAction('/api/remove', 'btnRemove'));
    document.getElementById('btn-reset').addEventListener('click', () => app.postAction('/api/reset', 'btnReset'));
    document.getElementById('btn-refresh').addEventListener('click', () => app.refreshStatus());
    document.getElementById('btn-relaunch').addEventListener('click', () => app.postAction('/api/relaunch', 'btnRelaunch'));

    return { getT, renderStaticChrome, renderForm };
  };
})(window);
