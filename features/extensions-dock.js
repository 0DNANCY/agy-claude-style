// Extensions Quick Dock for AGY Claude Style.
// 1. Top-right titlebar:
//    - Right of [⋮] [≡] [|]: a single Extensions menu button opening a frosted secondary dropdown
//      listing all running UI extensions with Side Pane launch, Main Panel launch, and ★ Favorite toggle.
//    - Left of [⋮] [≡] [|]: displays ONLY header-favorited extensions for 1-click quick access.
// 2. Left sidebar ("扩展 / Extensions"):
//    - Collapsed by default so it stays compact.
//    - When collapsed, still shows sidebar-favorited extensions directly underneath the header.
//    - When expanded, lists all running UI extensions with ★ Favorite toggle and side-pane shortcut.
//    - Clicking a row opens the extension full-page in the Main Panel (clicking again returns to chat).
// 3. Persistence:
//    - Favorites (pinnedHeaderExtensions, pinnedSidebarExtensions) and sidebar expanded state
//      (sidebarExtensionsExpanded) persist into plugin config.json via ctx.saveSetting so they
//      survive Antigravity restarts (where localhost random ports reset localStorage).
// Registers on globalThis.__agCsFeatures.extensionsDock.
(function (root, factory) {
  const feature = factory();
  if (typeof module === 'object' && module.exports) module.exports = feature;
  else {
    root.__agCsFeatures = root.__agCsFeatures || {};
    root.__agCsFeatures.extensionsDock = feature;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const LS_HEADER_PINS = 'agCsPinnedHeaderExtensions';
  const LS_SIDEBAR_PINS = 'agCsPinnedSidebarExtensions';
  const LS_SIDEBAR_EXPANDED = 'agCsSidebarExtExpanded';

  const FALLBACK_EXTENSIONS = [
    { sidecarId: 'agy-claude-style/panel', path: '/', url: '', title: 'Claude Style' },
  ];

  function extractBaseUrlAndPath(rawUrl) {
    const s = String(rawUrl || '').trim();
    if (!s) return { url: '', path: '/' };
    try {
      const u = new URL(s);
      u.searchParams.delete('conversationId');
      const pathname = u.pathname || '/';
      return { url: u.toString(), path: pathname };
    } catch {
      return { url: s.replace(/([?&])conversationId=[^&]*/g, '').replace(/[?&]$/, ''), path: '/' };
    }
  }

  function normalizeSidecarEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const sidecarId = String(raw.sidecarId || '').trim();
    if (!sidecarId) return null;
    const parsed = extractBaseUrlAndPath(raw.url || raw.sidecarUrl || '');
    const path = String(raw.path || parsed.path || '/').trim() || '/';
    const url = parsed.url || String(raw.url || raw.sidecarUrl || '').trim();
    const rawTitle = String(raw.title || raw.iframeTitle || '').trim();
    const fallbackTitle = sidecarId.includes('/') ? sidecarId.split('/')[0] : sidecarId;
    const title = rawTitle || fallbackTitle;
    return { sidecarId, path, url, title };
  }

  function normalizePinnedList(val) {
    if (!Array.isArray(val)) return [];
    const seen = new Set();
    const out = [];
    for (const item of val) {
      const id = String(item || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  function togglePinnedId(list, sidecarId) {
    const clean = normalizePinnedList(list);
    const id = String(sidecarId || '').trim();
    if (!id) return clean;
    if (clean.includes(id)) return clean.filter((x) => x !== id);
    return [...clean, id];
  }

  function extensionPriority(ext) {
    const id = String(ext?.sidecarId || '').toLowerCase();
    if (id.startsWith('agy-claude-style/')) return 0;
    if (id.startsWith('agy-capsule/')) return 1;
    if (id.startsWith('agy-dart/')) return 2;
    if (id.startsWith('swarm/')) return 3;
    if (id.startsWith('agy-claude-capsule-bridge/')) return 4;
    return 10;
  }

  function sortExtensions(list, pinnedIds = []) {
    const pinSet = new Set(normalizePinnedList(pinnedIds));
    return [...(list || [])].sort((a, b) => {
      const aPin = pinSet.has(a.sidecarId) ? 0 : 1;
      const bPin = pinSet.has(b.sidecarId) ? 0 : 1;
      if (aPin !== bPin) return aPin - bPin;
      const pa = extensionPriority(a);
      const pb = extensionPriority(b);
      if (pa !== pb) return pa - pb;
      return String(a.title || a.sidecarId).localeCompare(String(b.title || b.sidecarId));
    });
  }

  function buildViewId(ext) {
    const sidecarId = String(ext?.sidecarId || '').trim();
    const path = String(ext?.path || '/').trim() || '/';
    return `sidecar/${sidecarId}:${path}`;
  }

  function buildAuxTabId(ext) {
    const sidecarId = String(ext?.sidecarId || '').trim();
    const path = String(ext?.path || '/').trim() || '/';
    return `sidecar__${sidecarId}__${path}`;
  }

  function parsePanelScopeFromUrl(pathname, search) {
    const p = String(pathname || '');
    const mConvo = p.match(/^\/c\/([^/?#]+)/);
    if (mConvo) return { kind: 'cascadeId', cascadeId: decodeURIComponent(mConvo[1]) };
    const mBattle = p.match(/^\/battle\/([^/?#]+)/);
    if (mBattle) return { kind: 'cascadeId', cascadeId: decodeURIComponent(mBattle[1]) };
    const mFork = p.match(/^\/forked\/[^/?#]+\/([^/?#]+)/);
    if (mFork) return { kind: 'cascadeId', cascadeId: decodeURIComponent(mFork[1]) };
    if (p === '/' || p === '') {
      try {
        const sp = new URLSearchParams(String(search || ''));
        const projectId = sp.get('project');
        if (projectId) return { kind: 'newConversation', projectId };
      } catch {}
      return { kind: 'home' };
    }
    return { kind: 'home' };
  }

  function parseActiveMainViewSidecar(pathname) {
    const p = String(pathname || '');
    const m = p.match(/^\/view\/([^/?#]+)/);
    if (!m) return null;
    try {
      const decoded = decodeURIComponent(m[1]);
      if (!decoded.startsWith('sidecar/')) return null;
      const rest = decoded.slice('sidecar/'.length);
      const colon = rest.indexOf(':');
      if (colon < 0) return { sidecarId: rest, path: '/' };
      return { sidecarId: rest.slice(0, colon), path: rest.slice(colon + 1) || '/' };
    } catch {
      return null;
    }
  }

  function discoverExtensionsFromDom(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const seen = new Map();
    const slots = doc.querySelectorAll('[data-testid="sidecar-iframe-slot"]');
    for (const slot of slots) {
      const iframe = slot.querySelector('iframe');
      const entry = normalizeSidecarEntry({
        sidecarId: slot.getAttribute('data-sidecar-id'),
        sidecarUrl: slot.getAttribute('data-sidecar-url') || iframe?.getAttribute('src') || '',
        iframeTitle: iframe?.getAttribute('title') || '',
      });
      if (!entry) continue;
      const key = `${entry.sidecarId}:${entry.path}`;
      if (!seen.has(key) || (!seen.get(key).url && entry.url)) {
        seen.set(key, entry);
      }
    }
    return sortExtensions([...seen.values()]);
  }

  function puzzleSvg(size = 15) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3a2 2 0 0 1 2 2v1h2a2 2 0 0 1 2 2v3h-1a2 2 0 1 0 0 4h1v3a2 2 0 0 1-2 2h-3v-1a2 2 0 1 0-4 0v1H8a2 2 0 0 1-2-2v-3H5a2 2 0 1 1 0-4h1V8a2 2 0 0 1 2-2h2V5a2 2 0 0 1 2-2h2z"/></svg>`;
  }

  function iconSvgForExtension(sidecarId, size = 15) {
    const id = String(sidecarId || '').toLowerCase();
    const base = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
    if (id.startsWith('agy-claude-style/')) {
      return `<svg ${base}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z"/></svg>`;
    }
    if (id.startsWith('agy-capsule/')) {
      return `<svg ${base}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
    }
    if (id.startsWith('agy-dart/')) {
      return `<svg ${base}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
    }
    if (id.startsWith('swarm/')) {
      return `<svg ${base}><circle cx="12" cy="5" r="2.5"/><circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M10.8 7.2L7.2 14.8M13.2 7.2l3.6 7.6M8.5 17h7"/></svg>`;
    }
    if (id.includes('bridge')) {
      return `<svg ${base}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
    }
    return puzzleSvg(size);
  }

  function chevronSvg(size = 14) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
  }

  function starSvg(filled = false, size = 13) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  }

  function auxSideIconSvg(size = 13) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/></svg>`;
  }

  function shortLabel(title) {
    const s = String(title || '').trim();
    return s || '?';
  }

  function getRootFiber() {
    const rootEl = document.getElementById('root') || document.body?.firstElementChild;
    if (!rootEl) return null;
    const key = Object.keys(rootEl).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
    return key ? rootEl[key] : null;
  }

  function findFiberProviders() {
    const start = getRootFiber();
    if (!start) return { store: null, router: null, placeholders: null };
    let store = null;
    let router = null;
    let placeholders = null;
    const visited = new Set();
    const stack = [start];
    let steps = 0;
    while (stack.length && steps < 6000) {
      steps++;
      const f = stack.pop();
      if (!f || visited.has(f)) continue;
      visited.add(f);
      const val = f.memoizedProps?.value;
      if (val && typeof val === 'object') {
        if (!store && val.store && typeof val.store.getState === 'function' && typeof val.store.dispatch === 'function') {
          store = val.store;
        }
        if (!router && val.routesByPath && typeof val.navigate === 'function') {
          router = val;
        }
        if (!placeholders && val.placeholders && typeof val.placeholders === 'object' && typeof val.registerPlaceholder === 'function') {
          placeholders = val.placeholders;
        }
        if (store && router && placeholders) break;
      }
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    return { store, router, placeholders };
  }

  function getPaneRecord(panesSlice, scope) {
    if (!panesSlice || !scope) return null;
    if (scope.kind === 'cascadeId' && scope.cascadeId) {
      return panesSlice.conversationPanes?.[scope.cascadeId] || null;
    }
    if (scope.kind === 'newConversation' && scope.projectId) {
      return panesSlice.newConversationPanes?.[scope.projectId] || null;
    }
    if (scope.kind === 'home') {
      return panesSlice.homePane || null;
    }
    return null;
  }

  function readActiveAuxSidecar(store, scope) {
    if (!store || typeof store.getState !== 'function') return { isOpen: false, sidecarId: null, tabId: null };
    try {
      const st = store.getState();
      const sp = getPaneRecord(st?.sidePanel, scope);
      const sp2 = getPaneRecord(st?.sidePanelV2, scope);
      const isOpen = Boolean(sp?.isPaneOpen);
      if (!isOpen) return { isOpen: false, sidecarId: null, tabId: null };
      const activeId =
        sp2?.activeTabId ||
        sp?.activeTabId ||
        (() => {
          try {
            return new URLSearchParams(location.search || '').get('tab') || null;
          } catch {
            return null;
          }
        })();
      const tabs = Array.isArray(sp2?.tabs) ? sp2.tabs : Array.isArray(sp?.tabs) ? sp.tabs : [];
      const activeTab = tabs.find((t) => t && t.id === activeId);
      const sv = activeTab?.content?.type === 'sidecarView' ? activeTab.content.sidecarView : null;
      return {
        isOpen: true,
        sidecarId: sv?.sidecarId || null,
        path: sv?.path || '/',
        tabId: activeId,
      };
    } catch {
      return { isOpen: false, sidecarId: null, tabId: null };
    }
  }

  function create(ctx) {
    let pinnedBarEl = null;
    let menuBtnEl = null;
    let sidebarSecEl = null;
    let popoverEl = null;
    let tooltipEl = null;
    let tooltipTimer = null;
    let cachedExtensions = [];
    const logoBySidecarId = new Map();
    const pendingBlobHarvests = new Set();
    let lastNonViewUrl = null;
    let lastRenderSig = '';

    function seedBundledLogos() {
      const preloaded = typeof globalThis !== 'undefined' && globalThis.__agCsSidecarLogos;
      if (!preloaded || typeof preloaded !== 'object') return;
      for (const [id, uri] of Object.entries(preloaded)) {
        if (id && typeof uri === 'string' && uri.startsWith('data:image/')) {
          logoBySidecarId.set(id, uri);
        }
      }
    }
    seedBundledLogos();

    let cachedStore = null;
    function getFiberStore() {
      if (cachedStore && typeof cachedStore.getState === 'function') return cachedStore;
      const { store } = findFiberProviders();
      if (store) cachedStore = store;
      return cachedStore;
    }

    function isZh() {
      const lang = String(ctx.getCfg?.().language || 'zh-CN');
      return lang.startsWith('zh') || lang === 'yue';
    }

    function t(zh, en) {
      return isZh() ? zh : en;
    }

    function getHeaderPins() {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      if (Array.isArray(cfg.pinnedHeaderExtensions)) {
        return normalizePinnedList(cfg.pinnedHeaderExtensions);
      }
      try {
        return normalizePinnedList(JSON.parse(localStorage.getItem(LS_HEADER_PINS) || '[]'));
      } catch {
        return [];
      }
    }

    function setHeaderPins(nextList) {
      const clean = normalizePinnedList(nextList);
      try {
        localStorage.setItem(LS_HEADER_PINS, JSON.stringify(clean));
      } catch {}
      if (typeof ctx.saveSetting === 'function') {
        ctx.saveSetting('pinnedHeaderExtensions', clean);
      }
      lastRenderSig = '';
      sync();
      if (popoverEl && menuBtnEl && menuBtnEl.isConnected) {
        renderPopoverContents();
      }
    }

    function getSidebarPins() {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      if (Array.isArray(cfg.pinnedSidebarExtensions)) {
        return normalizePinnedList(cfg.pinnedSidebarExtensions);
      }
      try {
        return normalizePinnedList(JSON.parse(localStorage.getItem(LS_SIDEBAR_PINS) || '[]'));
      } catch {
        return [];
      }
    }

    function setSidebarPins(nextList) {
      const clean = normalizePinnedList(nextList);
      try {
        localStorage.setItem(LS_SIDEBAR_PINS, JSON.stringify(clean));
      } catch {}
      if (typeof ctx.saveSetting === 'function') {
        ctx.saveSetting('pinnedSidebarExtensions', clean);
      }
      lastRenderSig = '';
      sync();
    }

    function isSidebarExpanded() {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      if (typeof cfg.sidebarExtensionsExpanded === 'boolean') {
        return cfg.sidebarExtensionsExpanded;
      }
      try {
        return localStorage.getItem(LS_SIDEBAR_EXPANDED) === '1';
      } catch {
        return false;
      }
    }

    function setSidebarExpanded(expanded) {
      const val = Boolean(expanded);
      try {
        localStorage.setItem(LS_SIDEBAR_EXPANDED, val ? '1' : '0');
      } catch {}
      if (typeof ctx.saveSetting === 'function') {
        ctx.saveSetting('sidebarExtensionsExpanded', val);
      }
      lastRenderSig = '';
      sync();
    }

    function rememberConversationLocation() {
      const p = String(location.pathname || '');
      if (p && !p.startsWith('/view/')) {
        lastNonViewUrl = p + String(location.search || '');
      }
    }

    function getExtensions() {
      const found = discoverExtensionsFromDom(document);
      if (found.length > 0) {
        cachedExtensions = found;
        return found;
      }
      if (cachedExtensions.length > 0) return cachedExtensions;
      try {
        const { placeholders } = findFiberProviders();
        if (placeholders) {
          const seen = new Map();
          for (const rawUrl of Object.keys(placeholders)) {
            const m = String(rawUrl).match(/^plugin:\/\/([a-z0-9_-]+)--([a-z0-9_-]+)-\d+\//i);
            if (!m) continue;
            const sidecarId = `${m[1]}/${m[2]}`;
            const entry = normalizeSidecarEntry({ sidecarId, sidecarUrl: rawUrl });
            if (entry) seen.set(`${entry.sidecarId}:${entry.path}`, entry);
          }
          if (seen.size > 0) {
            cachedExtensions = sortExtensions([...seen.values()]);
            return cachedExtensions;
          }
        }
      } catch {}
      return FALLBACK_EXTENSIONS;
    }

    function hideTooltip() {
      if (tooltipTimer) {
        clearTimeout(tooltipTimer);
        tooltipTimer = null;
      }
      if (tooltipEl && tooltipEl.parentNode) {
        tooltipEl.parentNode.removeChild(tooltipEl);
      }
      tooltipEl = null;
    }

    function showTooltip(anchorEl, titleText, subText) {
      hideTooltip();
      if (!anchorEl || !anchorEl.isConnected || !titleText) return;
      const tip = document.createElement('div');
      tip.className = 'ag-cs-ext-tooltip';
      tip.setAttribute('role', 'tooltip');
      const main = document.createElement('div');
      main.className = 'ag-cs-ext-tip-main';
      main.textContent = titleText;
      tip.appendChild(main);
      if (subText) {
        const sub = document.createElement('div');
        sub.className = 'ag-cs-ext-tip-sub';
        sub.textContent = subText;
        tip.appendChild(sub);
      }
      document.body.appendChild(tip);
      const r = anchorEl.getBoundingClientRect();
      const tw = tip.offsetWidth || 120;
      const th = tip.offsetHeight || 28;
      let left = r.left + r.width / 2 - tw / 2;
      left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));
      let top = r.bottom + 7;
      if (top + th > window.innerHeight - 8) {
        top = Math.max(8, r.top - th - 7);
      }
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
      tooltipEl = tip;
    }

    function bindTooltip(el, getTip) {
      if (!el) return;
      el.addEventListener('mouseenter', () => {
        if (tooltipTimer) clearTimeout(tooltipTimer);
        tooltipTimer = setTimeout(() => {
          tooltipTimer = null;
          const info = typeof getTip === 'function' ? getTip() : getTip;
          if (!info) return;
          if (typeof info === 'string') showTooltip(el, info, '');
          else showTooltip(el, info.title, info.sub || '');
        }, 90);
      });
      el.addEventListener('mouseleave', hideTooltip);
      el.addEventListener('mousedown', hideTooltip);
    }

    function syncAuxTabSearchParam(router, tabId) {
      if (!tabId) return;
      if (router && typeof router.navigate === 'function') {
        try {
          router.navigate({
            search: (prev) => {
              const next = { ...(prev && typeof prev === 'object' ? prev : {}) };
              next.tab = tabId;
              return next;
            },
            replace: true,
          });
          return;
        } catch {}
      }
      try {
        const u = new URL(location.href);
        if (u.searchParams.get('tab') !== tabId) {
          u.searchParams.set('tab', tabId);
          window.history.replaceState(window.history.state, '', `${u.pathname}${u.search}${u.hash}`);
        }
      } catch {}
    }

    function openInAuxPane(ext, { toggleIfActive = true } = {}) {
      if (!ext) return false;
      hideTooltip();
      const { store, router } = findFiberProviders();
      const scope = parsePanelScopeFromUrl(location.pathname, location.search);
      if (store) {
        const st = store.getState();
        const useV2 = Boolean(st && Object.prototype.hasOwnProperty.call(st, 'sidePanelV2'));
        const sp2 = getPaneRecord(st?.sidePanelV2, scope);
        const sp1 = getPaneRecord(st?.sidePanel, scope);
        const tabs = Array.isArray(sp2?.tabs) ? sp2.tabs : Array.isArray(sp1?.tabs) ? sp1.tabs : [];
        const closedTabs = Array.isArray(sp2?.closedTabs) ? sp2.closedTabs : [];
        const targetTabId = buildAuxTabId(ext);
        const existingTab =
          tabs.find((tab) => tab && tab.id === targetTabId) ||
          tabs.find(
            (tab) =>
              tab?.content?.type === 'sidecarView' &&
              tab.content.sidecarView?.sidecarId === ext.sidecarId
          ) ||
          null;
        const closedMatch =
          !existingTab
            ? closedTabs.find(
                (entry) =>
                  entry?.tab?.content?.type === 'sidecarView' &&
                  entry.tab.content.sidecarView?.sidecarId === ext.sidecarId
              )?.tab || null
            : null;

        const active = readActiveAuxSidecar(store, scope);
        const isSameActive = Boolean(
          active.isOpen &&
            ((existingTab && active.tabId === existingTab.id) ||
              (active.sidecarId === ext.sidecarId && (active.path || '/') === (ext.path || '/')))
        );
        if (toggleIfActive && isSameActive) {
          store.dispatch({
            type: 'sidePanel/setSidePanelOpen',
            payload: { panelScope: scope, isOpen: false },
          });
          lastRenderSig = '';
          setTimeout(sync, 40);
          return true;
        }

        const resolvedTabId = existingTab?.id || closedMatch?.id || targetTabId;
        const fallbackSv = existingTab?.content?.sidecarView || closedMatch?.content?.sidecarView || null;
        const content = {
          type: 'sidecarView',
          sidecarView: {
            sidecarId: ext.sidecarId,
            path: ext.path || fallbackSv?.path || '/',
            url: ext.url || fallbackSv?.url || '',
            title: ext.title || fallbackSv?.title || ext.sidecarId,
          },
        };

        // Mirror Antigravity native plugins-submenu-item (JBc -> VR + setSidePanelOpen + TR):
        // 1. Insert/update and activate the tab in sidePanelV2 (or legacy sidePanel)
        if (useV2) {
          store.dispatch({
            type: 'sidePanelV2/setContent',
            payload: { panelScope: scope, content, tabId: resolvedTabId, keepOpen: true },
          });
          store.dispatch({
            type: 'sidePanelV2/setActiveTab',
            payload: { panelScope: scope, tabId: resolvedTabId },
          });
        } else {
          store.dispatch({
            type: 'sidePanel/setContent',
            payload: { panelScope: scope, content, tabId: resolvedTabId, keepOpen: true },
          });
          store.dispatch({
            type: 'sidePanel/setActiveTab',
            payload: { panelScope: scope, tabId: resolvedTabId },
          });
        }
        // 2. Ensure the aux pane is open
        store.dispatch({
          type: 'sidePanel/setSidePanelOpen',
          payload: { panelScope: scope, isOpen: true },
        });
        // 3. Sync URL ?tab=<tabId> via TanStack Router (native TR()) so URL-driven tab state switches
        syncAuxTabSearchParam(router, resolvedTabId);

        lastRenderSig = '';
        setTimeout(sync, 40);
        return true;
      }
      const auxBtn = document.querySelector('[data-testid="toggle-aux-sidebar"]');
      if (auxBtn) {
        auxBtn.click();
        return true;
      }
      return false;
    }

    function closeAuxPane() {
      hideTooltip();
      closePopover();
      const { store } = findFiberProviders();
      const scope = parsePanelScopeFromUrl(location.pathname, location.search);
      if (store) {
        const active = readActiveAuxSidecar(store, scope);
        if (active.isOpen) {
          store.dispatch({
            type: 'sidePanel/setSidePanelOpen',
            payload: { panelScope: scope, isOpen: false },
          });
          lastRenderSig = '';
          setTimeout(sync, 40);
          return true;
        }
      }
      const activeMain = parseActiveMainViewSidecar(location.pathname);
      if (activeMain) {
        return openInMainPanel(activeMain, { toggleBackIfActive: true });
      }
      return false;
    }

    function openInMainPanel(ext, { toggleBackIfActive = false } = {}) {
      if (!ext) return false;
      const activeMain = parseActiveMainViewSidecar(location.pathname);
      const isAlreadyOpen = Boolean(
        activeMain && activeMain.sidecarId === ext.sidecarId && (activeMain.path || '/') === (ext.path || '/')
      );
      const { router } = findFiberProviders();
      if (toggleBackIfActive && isAlreadyOpen) {
        if (router && lastNonViewUrl) {
          try {
            const u = new URL(lastNonViewUrl, location.origin);
            const mConvo = u.pathname.match(/^\/c\/([^/?#]+)/);
            if (mConvo) {
              router.navigate({ to: '/c/$cascadeId', params: { cascadeId: decodeURIComponent(mConvo[1]) }, search: (prev) => prev });
              setTimeout(sync, 60);
              return true;
            }
          } catch {}
        }
        try {
          if (window.history.length > 1) window.history.back();
          else if (router) router.navigate({ to: '/' });
        } catch {}
        setTimeout(sync, 60);
        return true;
      }

      rememberConversationLocation();
      const viewId = buildViewId(ext);
      if (router && typeof router.navigate === 'function') {
        try {
          router.navigate({
            to: '/view/$viewId',
            params: { viewId },
            search: (prev) => prev,
          });
          setTimeout(sync, 60);
          return true;
        } catch {}
      }
      try {
        const nextPath = `/view/${encodeURIComponent(viewId)}${location.search || ''}`;
        window.history.pushState(null, '', nextPath);
        window.dispatchEvent(new PopStateEvent('popstate'));
        setTimeout(sync, 60);
        return true;
      } catch {
        return false;
      }
    }

    function closePopover() {
      if (popoverEl && popoverEl.parentNode) {
        popoverEl.parentNode.removeChild(popoverEl);
      }
      popoverEl = null;
      if (menuBtnEl) {
        menuBtnEl.classList.remove('is-menu-open');
        menuBtnEl.setAttribute('aria-expanded', 'false');
      }
    }

    function renderPopoverContents() {
      if (!popoverEl) return;
      const headerPins = getHeaderPins();
      const pinSet = new Set(headerPins);
      const exts = sortExtensions(getExtensions(), headerPins);
      const { store } = findFiberProviders();
      const scope = parsePanelScopeFromUrl(location.pathname, location.search);
      const activeAux = readActiveAuxSidecar(store, scope);
      const activeMain = parseActiveMainViewSidecar(location.pathname);

      popoverEl.innerHTML = '';

      const head = document.createElement('div');
      head.className = 'ag-cs-ext-pop-head';
      const headTitle = document.createElement('span');
      headTitle.textContent = t('扩展', 'Extensions');
      const headHint = document.createElement('span');
      headHint.className = 'ag-cs-ext-pop-hint';
      headHint.textContent = t('★ 收藏固定至顶栏', '★ Pin to header');
      head.appendChild(headTitle);
      head.appendChild(headHint);
      popoverEl.appendChild(head);

      for (const ext of exts) {
        const isPinned = pinSet.has(ext.sidecarId);
        const isAuxActive = activeAux.isOpen && activeAux.sidecarId === ext.sidecarId;
        const isMainActive = Boolean(activeMain && activeMain.sidecarId === ext.sidecarId);

        const item = document.createElement('div');
        item.className = 'ag-cs-ext-pop-row' + (isAuxActive || isMainActive ? ' is-active' : '');
        item.setAttribute('data-sidecar-id', ext.sidecarId);

        const mainBtn = document.createElement('button');
        mainBtn.type = 'button';
        mainBtn.className = 'ag-cs-ext-pop-main';
        const icWrap = document.createElement('span');
        icWrap.className = 'ag-cs-ext-ic';
        appendExtensionIcon(icWrap, ext.sidecarId, 15);
        const lblWrap = document.createElement('span');
        lblWrap.className = 'ag-cs-ext-pop-lbl';
        lblWrap.textContent = shortLabel(ext.title);
        mainBtn.appendChild(icWrap);
        mainBtn.appendChild(lblWrap);
        mainBtn.title = t(`${ext.title} — 点击在右侧栏打开/切换`, `${ext.title} — Open in side pane`);
        mainBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closePopover();
          if (ev.shiftKey) openInMainPanel(ext, { toggleBackIfActive: true });
          else openInAuxPane(ext, { toggleIfActive: false });
        });

        const fullBtn = document.createElement('button');
        fullBtn.type = 'button';
        fullBtn.className = 'ag-cs-ext-pop-full';
        fullBtn.textContent = t('主面板', 'Full');
        fullBtn.title = t(`在主面板全屏打开 ${ext.title}`, `Open ${ext.title} in main panel`);
        fullBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closePopover();
          openInMainPanel(ext, { toggleBackIfActive: true });
        });

        const starBtn = document.createElement('button');
        starBtn.type = 'button';
        starBtn.className = 'ag-cs-ext-star' + (isPinned ? ' is-pinned' : '');
        starBtn.setAttribute('data-action', 'pin-header');
        starBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
        starBtn.title = isPinned
          ? t(`取消顶栏收藏 ${ext.title}`, `Unpin ${ext.title} from header`)
          : t(`收藏到顶栏快捷区 ${ext.title}`, `Pin ${ext.title} to header`);
        starBtn.innerHTML = starSvg(isPinned, 13);
        starBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          setHeaderPins(togglePinnedId(getHeaderPins(), ext.sidecarId));
        });

        item.appendChild(mainBtn);
        item.appendChild(fullBtn);
        item.appendChild(starBtn);
        popoverEl.appendChild(item);
      }
    }

    function toggleHeaderMenu(anchorBtn) {
      if (popoverEl) {
        closePopover();
        return;
      }
      const pop = document.createElement('div');
      pop.className = 'ag-cs-ext-popover';
      pop.setAttribute('role', 'menu');
      pop.setAttribute('data-testid', 'ag-cs-ext-popover');
      popoverEl = pop;
      renderPopoverContents();
      document.body.appendChild(pop);

      const rect = anchorBtn.getBoundingClientRect();
      const popW = Math.max(pop.offsetWidth, 248);
      const left = Math.max(8, Math.min(window.innerWidth - popW - 8, rect.right - popW));
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(rect.bottom + 6)}px`;

      anchorBtn.classList.add('is-menu-open');
      anchorBtn.setAttribute('aria-expanded', 'true');
    }

    function appendExtensionIcon(container, sidecarId, size = 15) {
      const logoSrc = logoBySidecarId.get(sidecarId);
      if (logoSrc) {
        const img = document.createElement('img');
        img.className = 'ag-cs-ext-logo-img';
        img.src = logoSrc;
        img.alt = '';
        img.width = size;
        img.height = size;
        img.style.width = `${size}px`;
        img.style.height = `${size}px`;
        container.appendChild(img);
        return;
      }
      container.innerHTML = iconSvgForExtension(sidecarId, size);
    }

    function harvestImageToDataUri(sidecarId, src) {
      if (!sidecarId || !src) return;
      if (src.startsWith('data:image/')) {
        if (logoBySidecarId.get(sidecarId) !== src) {
          logoBySidecarId.set(sidecarId, src);
          lastRenderSig = '';
        }
        return;
      }
      if (logoBySidecarId.has(sidecarId) && logoBySidecarId.get(sidecarId).startsWith('data:image/')) return;
      if (src.startsWith('blob:')) {
        const key = `${sidecarId}|${src}`;
        if (pendingBlobHarvests.has(key)) return;
        pendingBlobHarvests.add(key);
        try {
          fetch(src)
            .then((r) => r.blob())
            .then(
              (blob) =>
                new Promise((resolve) => {
                  const reader = new FileReader();
                  reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : '');
                  reader.onerror = () => resolve('');
                  reader.readAsDataURL(blob);
                })
            )
            .then((dataUri) => {
              if (dataUri && dataUri.startsWith('data:image/')) {
                logoBySidecarId.set(sidecarId, dataUri);
                lastRenderSig = '';
                sync();
              }
            })
            .catch(() => {})
            .finally(() => pendingBlobHarvests.delete(key));
        } catch {
          pendingBlobHarvests.delete(key);
        }
        return;
      }
      if (src.startsWith('http://') || src.startsWith('https://')) {
        if (logoBySidecarId.get(sidecarId) !== src) {
          logoBySidecarId.set(sidecarId, src);
          lastRenderSig = '';
        }
      }
    }

    function syncNativePluginsMenu() {
      const items = document.querySelectorAll('[data-testid="plugins-submenu-item"][data-sidecar-id]');
      if (!items.length) return;
      const headerPins = getHeaderPins();
      const pinSet = new Set(headerPins);

      for (const item of items) {
        const sidecarId = String(item.getAttribute('data-sidecar-id') || '').trim();
        if (!sidecarId) continue;

        // Harvest real plugin logo img (convert blob: to durable data: URI so unmount/revoke won't break it)
        const img = item.querySelector('img[src]');
        const src = img && img.getAttribute('src');
        if (src) harvestImageToDataUri(sidecarId, src);

        const isPinned = pinSet.has(sidecarId);
        let btn = item.querySelector(':scope > .ag-cs-native-pin-btn');
        if (!btn) {
          btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ag-cs-ext-star ag-cs-native-pin-btn';
          btn.setAttribute('data-action', 'pin-header-native');
          btn.setAttribute('data-sidecar-id', sidecarId);
          // Prevent Radix DropdownMenuItem from activating or closing menu on pointerdown/mousedown/click
          const stopNative = (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
          };
          btn.addEventListener('pointerdown', stopNative);
          btn.addEventListener('pointerup', stopNative);
          btn.addEventListener('mousedown', stopNative);
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            setHeaderPins(togglePinnedId(getHeaderPins(), sidecarId));
            syncNativePluginsMenu();
          });
          item.appendChild(btn);
        }
        btn.classList.toggle('is-pinned', isPinned);
        btn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
        btn.title = isPinned
          ? t('取消顶栏收藏', 'Unpin from header')
          : t('收藏到右上角快捷栏', 'Pin to top-right header');
        btn.innerHTML = starSvg(isPinned, 13);
      }
    }

    function unmountHeader() {
      closePopover();
      document.querySelectorAll('.ag-cs-native-pin-btn').forEach((n) => n.remove());
      if (pinnedBarEl && pinnedBarEl.parentNode) pinnedBarEl.parentNode.removeChild(pinnedBarEl);
      pinnedBarEl = null;
      if (menuBtnEl && menuBtnEl.parentNode) menuBtnEl.parentNode.removeChild(menuBtnEl);
      menuBtnEl = null;
    }

    function unmountSidebar() {
      if (sidebarSecEl && sidebarSecEl.parentNode) sidebarSecEl.parentNode.removeChild(sidebarSecEl);
      sidebarSecEl = null;
    }

    function syncHeader(exts, activeAux, activeMain) {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      if (cfg.headerExtensionsBar === false || !exts.length) {
        unmountHeader();
        return;
      }

      const moreBtn = document.querySelector('[data-testid="titlebar-more-actions"]');
      const overviewBtn = document.querySelector('[data-testid="toggle-overview-panel"]');
      const auxBtn = document.querySelector('[data-testid="toggle-aux-sidebar"]');
      const leftAnchor = moreBtn || overviewBtn || auxBtn;
      const menuAnchor = overviewBtn || auxBtn || moreBtn;
      if (!leftAnchor || !leftAnchor.parentElement || !menuAnchor || !menuAnchor.parentElement) {
        unmountHeader();
        return;
      }

      // 1. Place Extensions menu button in [⋮] [🧩] [≡] [|] order (between more-actions and overview-panel)
      const menuHost = menuAnchor.parentElement;
      if (!menuBtnEl) {
        menuBtnEl = document.createElement('button');
        menuBtnEl.type = 'button';
        menuBtnEl.className = 'ag-cs-ext-hdr-btn ag-cs-ext-menu-btn';
        menuBtnEl.setAttribute('data-testid', 'ag-cs-ext-menu-btn');
        menuBtnEl.setAttribute('aria-haspopup', 'menu');
        menuBtnEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          hideTooltip();
          toggleHeaderMenu(menuBtnEl);
        });
        menuBtnEl.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          closeAuxPane();
        });
        bindTooltip(menuBtnEl, () => {
          const { store } = findFiberProviders();
          const scope = parsePanelScopeFromUrl(location.pathname, location.search);
          const curAux = readActiveAuxSidecar(store, scope);
          const curMain = parseActiveMainViewSidecar(location.pathname);
          if (curAux.isOpen) {
            return {
              title: t('打开扩展菜单', 'Open Extensions Menu'),
              sub: t('左键切换扩展 · 右键关闭侧面板', 'Click: switch · Right-click: close side pane'),
            };
          }
          if (curMain) {
            return {
              title: t('打开扩展菜单', 'Open Extensions Menu'),
              sub: t('左键切换扩展 · 右键返回原对话', 'Click: switch · Right-click: return to chat'),
            };
          }
          return {
            title: t('打开扩展菜单', 'Open Extensions Menu'),
            sub: t('左键切换/收藏 · 侧栏展开时右键关闭', 'Click: switch/pin · Right-click closes open side pane'),
          };
        });
      }
      if (menuAnchor === overviewBtn || menuAnchor === auxBtn) {
        if (menuBtnEl.parentElement !== menuHost || menuBtnEl.nextSibling !== menuAnchor) {
          menuHost.insertBefore(menuBtnEl, menuAnchor);
        }
      } else if (menuBtnEl.parentElement !== menuHost || menuAnchor.nextSibling !== menuBtnEl) {
        menuHost.insertBefore(menuBtnEl, menuAnchor.nextSibling);
      }
      const anyActive = Boolean(activeAux.isOpen && activeAux.sidecarId) || Boolean(activeMain);
      menuBtnEl.classList.toggle('is-aux-active', anyActive);
      menuBtnEl.classList.toggle('is-menu-open', Boolean(popoverEl));
      menuBtnEl.setAttribute('aria-expanded', popoverEl ? 'true' : 'false');
      menuBtnEl.setAttribute('aria-label', t('扩展', 'Extensions'));
      menuBtnEl.removeAttribute('title');
      menuBtnEl.innerHTML = `<span class="ag-cs-ext-ic">${puzzleSvg(16)}</span>${anyActive ? '<span class="ag-cs-ext-dot"></span>' : ''}`;

      // 2. Left of [⋮] [≡] [|]: ONLY favorited header extensions
      const headerPins = getHeaderPins();
      const pinnedExts = headerPins
        .map((id) => exts.find((e) => e.sidecarId === id))
        .filter(Boolean);

      if (pinnedExts.length === 0) {
        if (pinnedBarEl && pinnedBarEl.parentNode) pinnedBarEl.parentNode.removeChild(pinnedBarEl);
        pinnedBarEl = null;
        return;
      }

      const leftHost = leftAnchor.parentElement;
      if (!pinnedBarEl) {
        pinnedBarEl = document.createElement('div');
        pinnedBarEl.className = 'ag-cs-ext-header-bar';
        pinnedBarEl.setAttribute('data-testid', 'ag-cs-ext-header-bar');
      }
      if (pinnedBarEl.parentElement !== leftHost || pinnedBarEl.nextSibling !== leftAnchor) {
        leftHost.insertBefore(pinnedBarEl, leftAnchor);
      }

      pinnedBarEl.innerHTML = '';
      for (const ext of pinnedExts) {
        const isAuxActive = activeAux.isOpen && activeAux.sidecarId === ext.sidecarId;
        const isMainActive = Boolean(activeMain && activeMain.sidecarId === ext.sidecarId);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ag-cs-ext-hdr-btn' + (isAuxActive ? ' is-aux-active' : '') + (isMainActive ? ' is-main-active' : '');
        btn.setAttribute('data-sidecar-id', ext.sidecarId);
        btn.setAttribute('aria-label', ext.title);
        const hdrTipTitle = isAuxActive
          ? t(`收起 ${ext.title}`, `Close ${ext.title}`)
          : activeAux.isOpen
          ? t(`切换到 ${ext.title}`, `Switch to ${ext.title}`)
          : t(`打开 ${ext.title}`, `Open ${ext.title}`);
        const hdrTipSub = t('左键右侧栏 · Shift / 右键主面板', 'Click: side pane · Shift/Right-click: main panel');
        bindTooltip(btn, { title: hdrTipTitle, sub: hdrTipSub });
        const hdrIc = document.createElement('span');
        hdrIc.className = 'ag-cs-ext-ic';
        appendExtensionIcon(hdrIc, ext.sidecarId, 16);
        btn.appendChild(hdrIc);
        if (isAuxActive || isMainActive) {
          const dot = document.createElement('span');
          dot.className = 'ag-cs-ext-dot';
          btn.appendChild(dot);
        }
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closePopover();
          if (ev.shiftKey || ev.metaKey || ev.altKey) {
            openInMainPanel(ext, { toggleBackIfActive: true });
          } else {
            openInAuxPane(ext, { toggleIfActive: true });
          }
        });
        btn.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          closePopover();
          openInMainPanel(ext, { toggleBackIfActive: true });
        });
        pinnedBarEl.appendChild(btn);
      }

      const sep = document.createElement('span');
      sep.className = 'ag-cs-ext-hdr-sep';
      sep.setAttribute('aria-hidden', 'true');
      pinnedBarEl.appendChild(sep);
    }

    function syncSidebar(exts, activeAux, activeMain) {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      if (cfg.sidebarExtensionsSection === false || !exts.length) {
        unmountSidebar();
        return;
      }

      const navItems = document.querySelector('[data-testid="sidebar-navigation-items"]');
      if (!navItems || !navItems.parentElement) {
        unmountSidebar();
        return;
      }
      const host = navItems.parentElement;

      if (!sidebarSecEl) {
        sidebarSecEl = document.createElement('div');
        sidebarSecEl.className = 'ag-cs-ext-sidebar-sec';
        sidebarSecEl.setAttribute('data-testid', 'ag-cs-ext-sidebar-sec');
      }
      if (sidebarSecEl.parentElement !== host || navItems.nextSibling !== sidebarSecEl) {
        host.insertBefore(sidebarSecEl, navItems.nextSibling);
      }

      const expanded = isSidebarExpanded();
      const sidebarPins = getSidebarPins();
      const pinSet = new Set(sidebarPins);
      const sorted = sortExtensions(exts, sidebarPins);
      const visibleList = expanded ? sorted : sorted.filter((e) => pinSet.has(e.sidecarId));

      sidebarSecEl.classList.toggle('is-collapsed', !expanded);
      sidebarSecEl.innerHTML = '';

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'ag-cs-ext-sb-head';
      head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      head.title = expanded
        ? t('收起扩展列表（仍保留已收藏项）', 'Collapse extensions (keeps ★ pinned items visible)')
        : t('展开全部扩展（点击 ★ 可收藏常驻）', 'Expand all extensions (★ pin items to keep visible)');
      const sbHeadLeft = document.createElement('span');
      sbHeadLeft.className = 'ag-cs-ext-sb-head-left';
      const sbHeadIc = document.createElement('span');
      sbHeadIc.className = 'ag-cs-ext-ic';
      sbHeadIc.innerHTML = puzzleSvg(16);
      const sbHeadTitle = document.createElement('span');
      sbHeadTitle.className = 'ag-cs-ext-sb-title';
      sbHeadTitle.textContent = t('扩展', 'Extensions');
      sbHeadLeft.appendChild(sbHeadIc);
      sbHeadLeft.appendChild(sbHeadTitle);
      const sbHeadRight = document.createElement('span');
      sbHeadRight.className = 'ag-cs-ext-sb-right';
      const sbCount = document.createElement('span');
      sbCount.className = 'ag-cs-ext-sb-count';
      sbCount.textContent = String(exts.length);
      const sbChev = document.createElement('span');
      sbChev.className = 'ag-cs-ext-sb-chev';
      sbChev.innerHTML = chevronSvg(14);
      sbHeadRight.appendChild(sbCount);
      sbHeadRight.appendChild(sbChev);
      head.appendChild(sbHeadLeft);
      head.appendChild(sbHeadRight);
      head.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setSidebarExpanded(!isSidebarExpanded());
      });
      sidebarSecEl.appendChild(head);

      if (visibleList.length > 0) {
        const list = document.createElement('div');
        list.className = 'ag-cs-ext-sb-list';
        for (const ext of visibleList) {
          const isPinned = pinSet.has(ext.sidecarId);
          const isMainActive = Boolean(activeMain && activeMain.sidecarId === ext.sidecarId);
          const isAuxActive = activeAux.isOpen && activeAux.sidecarId === ext.sidecarId;

          const row = document.createElement('div');
          row.className =
            'ag-cs-ext-sb-row' +
            (isMainActive ? ' is-main-active' : '') +
            (isAuxActive ? ' is-aux-active' : '') +
            (isPinned ? ' is-pinned' : '');
          row.setAttribute('data-sidecar-id', ext.sidecarId);

          const mainBtn = document.createElement('button');
          mainBtn.type = 'button';
          mainBtn.className = 'ag-cs-ext-sb-item';
          bindTooltip(mainBtn, {
            title: isMainActive
              ? t(`返回原对话（当前：${ext.title}）`, `Return to chat (${ext.title} active)`)
              : t(`打开 ${ext.title}（主面板）`, `Open ${ext.title} (Main Panel)`),
            sub: t('右键在右侧栏切换', 'Right-click to open in side pane'),
          });
          const sbIc = document.createElement('span');
          sbIc.className = 'ag-cs-ext-ic';
          appendExtensionIcon(sbIc, ext.sidecarId, 16);
          const sbLbl = document.createElement('span');
          sbLbl.className = 'ag-cs-ext-sb-lbl';
          sbLbl.textContent = shortLabel(ext.title);
          mainBtn.appendChild(sbIc);
          mainBtn.appendChild(sbLbl);
          mainBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            hideTooltip();
            if (ev.shiftKey) openInAuxPane(ext, { toggleIfActive: true });
            else openInMainPanel(ext, { toggleBackIfActive: true });
          });
          mainBtn.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            hideTooltip();
            openInAuxPane(ext, { toggleIfActive: true });
          });

          const actions = document.createElement('div');
          actions.className = 'ag-cs-ext-sb-actions';

          const auxBtn = document.createElement('button');
          auxBtn.type = 'button';
          auxBtn.className = 'ag-cs-ext-sb-act ag-cs-ext-sb-aux' + (isAuxActive ? ' is-active' : '');
          auxBtn.setAttribute('aria-label', t(`在右侧栏打开 ${ext.title}`, `Open ${ext.title} in side pane`));
          bindTooltip(auxBtn, {
            title: isAuxActive
              ? t(`收起右侧栏 ${ext.title}`, `Close ${ext.title} side pane`)
              : activeAux.isOpen
              ? t(`右侧栏切换到 ${ext.title}`, `Switch side pane to ${ext.title}`)
              : t(`在右侧栏打开 ${ext.title}`, `Open ${ext.title} in side pane`),
          });
          auxBtn.innerHTML = auxSideIconSvg(13);
          auxBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            openInAuxPane(ext, { toggleIfActive: true });
          });

          const starBtn = document.createElement('button');
          starBtn.type = 'button';
          starBtn.className = 'ag-cs-ext-sb-act ag-cs-ext-star' + (isPinned ? ' is-pinned' : '');
          starBtn.setAttribute('data-action', 'pin-sidebar');
          starBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
          bindTooltip(starBtn, {
            title: isPinned
              ? t(`取消侧栏收藏 ${ext.title}`, `Unpin ${ext.title} from sidebar`)
              : t(`收藏 ${ext.title}（收起时也常驻）`, `Pin ${ext.title} (stays visible when collapsed)`),
          });
          starBtn.innerHTML = starSvg(isPinned, 13);
          starBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            hideTooltip();
            setSidebarPins(togglePinnedId(getSidebarPins(), ext.sidecarId));
          });

          actions.appendChild(auxBtn);
          actions.appendChild(starBtn);
          row.appendChild(mainBtn);
          row.appendChild(actions);
          list.appendChild(row);
        }
        sidebarSecEl.appendChild(list);
      }
    }

    function sync() {
      if (ctx.isDestroyed && ctx.isDestroyed()) return;
      rememberConversationLocation();

      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      const showHeader = cfg.headerExtensionsBar !== false;
      const showSidebar = cfg.sidebarExtensionsSection !== false;
      if (!showHeader && !showSidebar) {
        unmountHeader();
        unmountSidebar();
        lastRenderSig = '';
        return;
      }

      if (showHeader) {
        syncNativePluginsMenu();
      } else {
        document.querySelectorAll('.ag-cs-native-pin-btn').forEach((n) => n.remove());
      }

      const exts = getExtensions();
      const { store } = findFiberProviders();
      const scope = parsePanelScopeFromUrl(location.pathname, location.search);
      const activeAux = readActiveAuxSidecar(store, scope);
      const activeMain = parseActiveMainViewSidecar(location.pathname);
      const headerPins = getHeaderPins();
      const sidebarPins = getSidebarPins();
      const expanded = isSidebarExpanded();

      const sig = JSON.stringify({
        lang: cfg.language || 'zh-CN',
        showHeader,
        showSidebar,
        expanded,
        headerPins,
        sidebarPins,
        logos: logoBySidecarId.size,
        popoverOpen: Boolean(popoverEl),
        exts: exts.map((e) => `${e.sidecarId}:${e.path}:${e.title}`),
        aux: activeAux.isOpen ? activeAux.sidecarId : '',
        main: activeMain ? activeMain.sidecarId : '',
        hasHeaderHost: Boolean(document.querySelector('[data-testid="titlebar-more-actions"], [data-testid="toggle-aux-sidebar"]')),
        hasSidebarHost: Boolean(document.querySelector('[data-testid="sidebar-navigation-items"]')),
        menuMounted: Boolean(menuBtnEl && menuBtnEl.isConnected),
        pinnedMounted: Boolean(pinnedBarEl && pinnedBarEl.isConnected),
        sidebarMounted: Boolean(sidebarSecEl && sidebarSecEl.isConnected),
      });
      if (sig === lastRenderSig) return;
      lastRenderSig = sig;

      syncHeader(exts, activeAux, activeMain);
      syncSidebar(exts, activeAux, activeMain);
    }

    function onClick(ev) {
      if (popoverEl && !popoverEl.contains(ev.target) && (!menuBtnEl || !menuBtnEl.contains(ev.target))) {
        closePopover();
      }
    }

    function onEscape() {
      if (popoverEl) {
        closePopover();
        return true;
      }
      return false;
    }

    function postNavToMountedPanel(target, section) {
      try {
        const slots = document.querySelectorAll('[data-testid="sidecar-iframe-slot"][data-sidecar-id="agy-claude-style/panel"] iframe');
        for (const frame of slots) {
          try {
            frame.contentWindow?.postMessage({ type: 'ag-cs-navigate', target, section }, '*');
          } catch {}
        }
      } catch {}
    }

    function openControlRoomAux({ target = 'control', section = '' } = {}) {
      const exts = getExtensions();
      const ext =
        exts.find((e) => e.sidecarId === 'agy-claude-style/panel') ||
        FALLBACK_EXTENSIONS[0];
      const ok = openInAuxPane(ext, { toggleIfActive: false });
      postNavToMountedPanel(target, section);
      setTimeout(() => postNavToMountedPanel(target, section), 180);
      setTimeout(() => postNavToMountedPanel(target, section), 500);
      return ok;
    }

    if (typeof globalThis !== 'undefined') {
      globalThis.__agCsOpenControlRoom = openControlRoomAux;
    }

    function destroy() {
      if (typeof globalThis !== 'undefined' && globalThis.__agCsOpenControlRoom === openControlRoomAux) {
        delete globalThis.__agCsOpenControlRoom;
      }
      hideTooltip();
      unmountHeader();
      unmountSidebar();
      lastRenderSig = '';
    }

    return {
      ownSelector: '.ag-cs-ext-header-bar, .ag-cs-ext-menu-btn, .ag-cs-ext-sidebar-sec, .ag-cs-ext-popover, .ag-cs-native-pin-btn, .ag-cs-ext-tooltip',
      sync,
      onClick,
      onEscape,
      destroy,
    };
  }

  return {
    discoverExtensionsFromDom,
    normalizeSidecarEntry,
    normalizePinnedList,
    togglePinnedId,
    sortExtensions,
    buildViewId,
    buildAuxTabId,
    parsePanelScopeFromUrl,
    parseActiveMainViewSidecar,
    create,
  };
});
