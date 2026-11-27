// Window Title Unread & Pending Approval Indicator for AGY Claude Style.
// Prefixes document.title with "(N)" when background conversations finish or await approval,
// and cleanly restores the native title when the window regains focus or conversations are viewed.
// Registers on globalThis.__agCsFeatures.unreadTitle.
(function (root, factory) {
  const feature = factory();
  if (typeof module === 'object' && module.exports) module.exports = feature;
  else {
    root.__agCsFeatures = root.__agCsFeatures || {};
    root.__agCsFeatures.unreadTitle = feature;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const BADGE_RE = /^(?:●\s*)?\(\d+\)\s+/;

  function stripTitleBadge(title) {
    return String(title || '').replace(BADGE_RE, '');
  }

  function formatUnreadTitle(baseTitle, unreadCount, pendingCount = 0) {
    const clean = stripTitleBadge(baseTitle);
    const total = Math.max(0, Number(unreadCount) || 0) + Math.max(0, Number(pendingCount) || 0);
    if (total <= 0) return clean;
    const prefix = pendingCount > 0 ? `● (${total}) ` : `(${total}) `;
    return clean ? `${prefix}${clean}` : prefix.trim();
  }

  function classifyTrajectoryState(summary) {
    if (!summary || typeof summary !== 'object') return 'idle';
    const s = summary.summary && typeof summary.summary === 'object' ? summary.summary : summary;
    const rawStatus =
      s.status !== undefined && s.status !== null && s.status !== ''
        ? s.status
        : s.runStatus ?? s.cascadeStatus ?? s.executionStatus ?? s.state ?? '';
    const numStatus = typeof rawStatus === 'number' ? rawStatus : /^\d+$/.test(String(rawStatus)) ? Number(rawStatus) : NaN;
    const raw = String(rawStatus).toUpperCase();
    if (
      s.waitingForUser === true ||
      s.needsApproval === true ||
      numStatus === 9 ||
      /WAITING_FOR_USER|AWAITING|APPROVAL|PERMISSION|PENDING_CONFIRMATION|NEEDS_INPUT/.test(raw)
    ) {
      return 'waiting';
    }
    if (
      s.isRunning === true ||
      s.running === true ||
      s.notFullyIdle === true ||
      s.hasActivity === true ||
      s.hasRunningSubagents === true ||
      numStatus === 2 ||
      numStatus === 4 ||
      /RUNNING|GENERATING|IN_PROGRESS|ACTIVE|EXECUTING|STREAMING|WORKING/.test(raw)
    ) {
      return 'running';
    }
    return 'idle';
  }

  function readActiveCidFromDom() {
    const view = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
    const attrCid = view?.getAttribute?.('data-cascade-id');
    if (attrCid) return attrCid;
    const m = typeof location !== 'undefined' ? String(location.pathname || '').match(/\/c\/([0-9a-f-]{36})/i) : null;
    return m && m[1] ? m[1] : '';
  }

  function findReduxStoreAndActiveCid(cachedStore) {
    let store = cachedStore && typeof cachedStore.getState === 'function' ? cachedStore : null;
    let activeCid = readActiveCidFromDom();
    if (store && (activeCid || cachedStore === store)) return { store, activeCid };
    const anchors = [
      document.querySelector('[data-testid="conversation-view"]'),
      document.querySelector('[data-testid="agent-input-box"]'),
      document.querySelector('[data-testid="conversation-list-sidebar"]'),
      document.getElementById('root')?.firstElementChild,
      document.body?.firstElementChild,
    ].filter(Boolean);

    for (const el of anchors) {
      const fKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      if (!fKey) continue;
      let cur = el[fKey];
      let hops = 0;
      while (cur && hops < 160) {
        const v = cur.memoizedProps?.value;
        if (v && typeof v === 'object') {
          if (!store && v.store && typeof v.store.getState === 'function') {
            store = v.store;
          }
          if (!activeCid && typeof v.cascadeContext?.state?.cascadeId === 'string') {
            activeCid = v.cascadeContext.state.cascadeId;
          }
          if (!activeCid && typeof v.cascadeId === 'string') {
            activeCid = v.cascadeId;
          }
        }
        if (store && activeCid) break;
        cur = cur.return;
        hops++;
      }
      if (store && activeCid) break;
    }
    return { store, activeCid };
  }

  function create(ctx) {
    let baseTitle = stripTitleBadge(document.title || 'Antigravity');
    let lastAppliedTitle = '';
    let prevStates = new Map();
    const unreadIds = new Set();
    let pendingCount = 0;
    let lastCheckAt = 0;
    let timer = null;
    let cachedStore = null;
    let lastSummariesRef = null;
    let lastActiveCid = '';
    let lastWindowFocused = null;

    function isEnabled() {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      return cfg.windowUnreadTitle !== false;
    }

    function captureNativeTitle() {
      const cur = document.title || '';
      if (cur !== lastAppliedTitle) {
        const stripped = stripTitleBadge(cur);
        if (stripped) baseTitle = stripped;
      }
    }

    function applyTitle() {
      captureNativeTitle();
      if (!isEnabled()) {
        if (lastAppliedTitle && document.title === lastAppliedTitle && baseTitle) {
          document.title = baseTitle;
        }
        lastAppliedTitle = '';
        return;
      }
      const next = formatUnreadTitle(baseTitle, unreadIds.size, pendingCount);
      if (next && document.title !== next) {
        document.title = next;
      }
      lastAppliedTitle = next;
    }

    function pollTrajectories(force = false) {
      if (ctx.isDestroyed && ctx.isDestroyed()) return;
      if (!isEnabled()) {
        unreadIds.clear();
        pendingCount = 0;
        applyTitle();
        return;
      }
      const now = Date.now();
      if (!force && now - lastCheckAt < 900) return;
      lastCheckAt = now;

      const { store, activeCid } = findReduxStoreAndActiveCid(cachedStore);
      if (store) cachedStore = store;
      const windowFocused = !document.hidden && (typeof document.hasFocus !== 'function' || document.hasFocus());
      if (windowFocused && activeCid && unreadIds.has(activeCid)) {
        unreadIds.delete(activeCid);
      }

      let nextPending = 0;
      const summaries = store?.getState?.()?.trajectorySummaries?.summaries;
      if (summaries && typeof summaries === 'object') {
        if (!force && summaries === lastSummariesRef && activeCid === lastActiveCid && windowFocused === lastWindowFocused) {
          return;
        }
        lastSummariesRef = summaries;
        lastActiveCid = activeCid;
        lastWindowFocused = windowFocused;
        const nextStates = new Map();
        for (const [id, summary] of Object.entries(summaries)) {
          if (!id || !summary || typeof summary !== 'object') continue;
          const st = classifyTrajectoryState(summary);
          nextStates.set(id, st);
          const prev = prevStates.get(id);
          if (st === 'waiting') {
            if (!windowFocused || id !== activeCid) nextPending++;
          } else if (prev === 'running' && st === 'idle') {
            if (!windowFocused || (activeCid && id !== activeCid)) {
              unreadIds.add(id);
            }
          }
        }
        prevStates = nextStates;
      } else {
        lastSummariesRef = null;
        // DOM fallback: detect sidebar loading spinners transitioning to done while unfocused
        const spinners = document.querySelectorAll('[data-testid="conversation-row-sidebar"] [data-testid="status-loading-spinner"]').length;
        const prevSpinners = prevStates.get('__dom_spinners__') || 0;
        if (prevSpinners > spinners && !windowFocused) {
          unreadIds.add(`dom-${now}`);
        }
        prevStates.set('__dom_spinners__', spinners);
      }

      pendingCount = nextPending;
      applyTitle();
    }

    function onFocusOrVisible() {
      if (document.hidden || !isEnabled()) return;
      const { activeCid } = findReduxStoreAndActiveCid(cachedStore);
      // Clear anonymous DOM badges and the currently viewed conversation while preserving other background unread chats
      for (const id of Array.from(unreadIds)) {
        if (id.startsWith('dom-') || (activeCid && id === activeCid)) {
          unreadIds.delete(id);
        }
      }
      pollTrajectories(true);
    }

    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);
    timer = setInterval(() => {
      if (!document.hidden && isEnabled()) pollTrajectories(false);
    }, 1800);

    return {
      sync() {
        pollTrajectories(false);
      },
      destroy() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        window.removeEventListener('focus', onFocusOrVisible);
        document.removeEventListener('visibilitychange', onFocusOrVisible);
        captureNativeTitle();
        if (baseTitle && document.title !== baseTitle) {
          document.title = baseTitle;
        }
        unreadIds.clear();
        pendingCount = 0;
        lastAppliedTitle = '';
      },
    };
  }

  return {
    create,
    stripTitleBadge,
    formatUnreadTitle,
    classifyTrajectoryState,
  };
});
