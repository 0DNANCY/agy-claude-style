// Left Sidebar Polish & Empty-Project Folding for AGY Claude Style.
// Enhances left sidebar hierarchy with zero forced synchronous layout reads:
// - Tags project groups, header wrappers, and expanded conversation tree containers
//   for tree guide lines and active parent-folder accent linkage.
// - Detects active conversation rows (selected attribute or URL cascadeId) and
//   active top navigation items.
// - Hides "No conversations yet" / "还没有对话" placeholders by default when
//   sidebarFoldEmpty is enabled, while letting users click an empty project to
//   peek/collapse on demand and automatically clearing fold state once a chat exists.
// Registers on globalThis.__agCsFeatures.sidebarPolish.
(function (root, factory) {
  const feature = factory();
  if (typeof module === 'object' && module.exports) module.exports = feature;
  else {
    root.__agCsFeatures = root.__agCsFeatures || {};
    root.__agCsFeatures.sidebarPolish = feature;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const EMPTY_PLACEHOLDER_TEXTS = new Set([
    'no conversations yet',
    '还没有对话',
    '尚無對話',
    '仲未有對話',
    '会話はまだありません',
  ]);

  const SB_ATTRS = [
    'data-ag-cs-sb-group',
    'data-ag-cs-sb-header',
    'data-ag-cs-sb-children',
    'data-ag-cs-sb-empty',
    'data-ag-cs-sb-empty-row',
    'data-ag-cs-sb-empty-body',
    'data-ag-cs-sb-folded',
    'data-ag-cs-sb-has-convos',
    'data-ag-cs-sb-has-active',
    'data-ag-cs-sb-active',
    'data-ag-cs-sb-peek',
    'data-ag-cs-sb-nav-active',
  ];

  function normalizeText(raw) {
    return String(raw || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function isEmptyPlaceholderText(raw) {
    return EMPTY_PLACEHOLDER_TEXTS.has(normalizeText(raw));
  }

  function safeMatches(el, selector) {
    if (!el || typeof el.matches !== 'function') return false;
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  }

  function safeClosest(el, selector) {
    if (!el || typeof el.closest !== 'function') return null;
    try {
      return el.closest(selector);
    } catch {
      return null;
    }
  }

  function parseActiveCascadeId(pathname) {
    const p = String(pathname || '');
    const mConvo = p.match(/^\/c\/([^/?#]+)/);
    if (mConvo) return decodeURIComponent(mConvo[1]);
    const mBattle = p.match(/^\/battle\/([^/?#]+)/);
    if (mBattle) return decodeURIComponent(mBattle[1]);
    const mFork = p.match(/^\/forked\/[^/?#]+\/([^/?#]+)/);
    if (mFork) return decodeURIComponent(mFork[1]);
    return '';
  }

  function findEmptyRowElement(rootEl) {
    if (!rootEl) return null;
    if (
      !rootEl.querySelector?.('button[data-testid="project-header"], [data-testid="conversation-row-sidebar"]') &&
      isEmptyPlaceholderText(rootEl.textContent)
    ) {
      let cur = rootEl;
      while (cur && cur.children && cur.children.length === 1) {
        const only = cur.children[0];
        if (!only || !isEmptyPlaceholderText(only.textContent)) break;
        cur = only;
      }
      return cur;
    }
    const all = rootEl.querySelectorAll ? Array.from(rootEl.querySelectorAll('*')) : [];
    for (const node of all) {
      if (!node || !isEmptyPlaceholderText(node.textContent)) continue;
      if (node.querySelector?.('button, a, input, [data-testid="conversation-row-sidebar"], [data-testid="project-header"]')) {
        continue;
      }
      const childWithSameText = Array.from(node.children || []).find((ch) => isEmptyPlaceholderText(ch.textContent));
      if (!childWithSameText) return node;
    }
    return null;
  }

  function isRowActive(row, activeCid) {
    if (!row) return false;
    if (
      row.getAttribute('data-selected') === 'true' ||
      row.getAttribute('aria-selected') === 'true' ||
      row.getAttribute('aria-current') === 'page' ||
      row.getAttribute('aria-current') === 'true'
    ) {
      return true;
    }
    const parentRow = safeClosest(row, '.agy-sidebar-row');
    if (
      parentRow &&
      (parentRow.getAttribute('data-selected') === 'true' ||
        parentRow.getAttribute('aria-selected') === 'true' ||
        parentRow.getAttribute('aria-current') === 'page')
    ) {
      return true;
    }
    if (row.querySelector?.('[data-selected="true"], [aria-selected="true"], [aria-current="page"]')) {
      return true;
    }
    if (activeCid) {
      const rowCid =
        row.getAttribute('data-cascade-id') ||
        row.getAttribute('data-conversation-id') ||
        parentRow?.getAttribute?.('data-cascade-id') ||
        '';
      if (rowCid && rowCid === activeCid) return true;
      const anchor = safeMatches(row, 'a[href]') ? row : row.querySelector?.('a[href]');
      const href = String(anchor?.getAttribute?.('href') || '');
      if (href && (href.includes(`/c/${activeCid}`) || href.includes(`/${activeCid}`))) {
        return true;
      }
    }
    return false;
  }

  function isHeaderBoundaryNode(el) {
    if (!el) return true;
    if (
      safeMatches(
        el,
        'button[data-testid="project-header"], [data-testid="section-header"], [data-testid="sidebar-navigation-items"], .ag-cs-ext-sidebar-sec'
      )
    ) {
      return true;
    }
    return Boolean(el.querySelector?.('button[data-testid="project-header"], [data-testid="section-header"]'));
  }

  function resolveProjectStructure(headerBtn) {
    let cand = headerBtn;
    let depth = 0;
    while (depth < 5 && cand.parentElement) {
      const p = cand.parentElement;
      if (
        p.tagName === 'BODY' ||
        p.tagName === 'HTML' ||
        safeMatches(
          p,
          '[data-testid="conversation-list-sidebar"], [data-testid="sidebar-split"], [data-testid="sidebar-navigation-items"]'
        )
      ) {
        break;
      }
      const headersInParent = p.querySelectorAll ? p.querySelectorAll('button[data-testid="project-header"]').length : 0;
      if (headersInParent > 1) break;
      if (p.querySelector?.('[data-testid="section-header"], [data-testid="sidebar-navigation-items"]')) break;
      cand = p;
      depth++;
    }

    // Detect flat sibling layout (when parent directly holds multiple projects' rows without per-project wrappers)
    const nextSib = cand.nextElementSibling;
    const flatFollowingSibling =
      nextSib &&
      !isHeaderBoundaryNode(nextSib) &&
      (safeMatches(nextSib, '[data-testid="conversation-row-sidebar"]') ||
        Boolean(nextSib.querySelector?.('[data-testid="conversation-row-sidebar"]')) ||
        Boolean(findEmptyRowElement(nextSib)));

    if (cand !== headerBtn && !flatFollowingSibling) {
      const directChildren = Array.from(cand.children || []);
      const headerSlot = directChildren.find((ch) => ch === headerBtn || ch.contains?.(headerBtn)) || headerBtn;
      const bodySlots = directChildren.filter((ch) => ch !== headerSlot);
      return { mode: 'grouped', groupEl: cand, headerSlot, bodySlots };
    }

    // Flat sibling fallback: headerSlot is `cand` (or `headerBtn`), bodySlots are consecutive siblings before next project/section
    const headerSlot = cand;
    const bodySlots = [];
    let sib = headerSlot.nextElementSibling;
    while (sib && !isHeaderBoundaryNode(sib)) {
      bodySlots.push(sib);
      sib = sib.nextElementSibling;
    }
    return { mode: 'flat', groupEl: headerSlot, headerSlot, bodySlots };
  }

  function isSecondaryHeaderClick(target, headerBtn) {
    if (!target || !headerBtn) return true;
    const hitBtn = safeClosest(target, 'button, [role="button"]');
    if (hitBtn && hitBtn !== headerBtn) return true;
    if (
      safeClosest(
        target,
        '[data-testid*="new"], [data-testid*="add"], [data-testid*="create"], [data-testid*="more"], [data-testid*="menu"], [data-testid*="action"]'
      )
    ) {
      return true;
    }
    return false;
  }

  function create(ctx) {
    const peekEmptyKeys = new Set();
    const taggedAttrs = new Map();
    const headerKeyByEl = new WeakMap();

    function applyTag(el, attr, val) {
      if (!el) return;
      let set = taggedAttrs.get(el);
      if (!set) {
        set = new Set();
        taggedAttrs.set(el, set);
      }
      set.add(attr);
      if (el.getAttribute(attr) !== val) el.setAttribute(attr, val);
    }

    function clearStaleTags(nextMap) {
      for (const [el, attrs] of taggedAttrs.entries()) {
        const keep = nextMap.get(el);
        for (const attr of attrs) {
          if (!keep || !keep.has(attr)) {
            try {
              el.removeAttribute(attr);
            } catch {}
          }
        }
      }
      taggedAttrs.clear();
      for (const [el, attrs] of nextMap.entries()) {
        taggedAttrs.set(el, attrs);
      }
    }

    function computeHeaderKey(headerBtn, occMap) {
      const raw = (
        headerBtn.getAttribute('data-project-id') ||
        headerBtn.getAttribute('title') ||
        headerBtn.getAttribute('aria-label') ||
        headerBtn.textContent ||
        ''
      )
        .trim()
        .replace(/\s+/g, ' ');
      const occ = occMap.get(raw) || 0;
      occMap.set(raw, occ + 1);
      return `${raw}#${occ}`;
    }

    function sync() {
      if (ctx.isDestroyed && ctx.isDestroyed()) return;
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      if (cfg.sidebarRestyle === false) {
        clearAllTags();
        return;
      }

      const foldEmpty = cfg.sidebarFoldEmpty !== false;
      const pathname = typeof location !== 'undefined' ? String(location.pathname || '') : '';
      const activeCid = parseActiveCascadeId(pathname);
      const nextTags = new Map();

      const mark = (el, attr, val = '1') => {
        if (!el) return;
        let set = nextTags.get(el);
        if (!set) {
          set = new Set();
          nextTags.set(el, set);
        }
        set.add(attr);
        if (el.getAttribute(attr) !== val) el.setAttribute(attr, val);
      };

      // 1. Top navigation active indicator (New Conversation / Automations / Customizations)
      const navContainer = document.querySelector?.('[data-testid="sidebar-navigation-items"]');
      if (navContainer && navContainer.querySelectorAll) {
        const navItems = Array.from(navContainer.querySelectorAll('a, button'));
        for (const item of navItems) {
          if (item.closest?.('.ag-cs-ext-sidebar-sec')) continue;
          const href = String(item.getAttribute('href') || '');
          const matchedHref = Boolean(href && href !== '/' && pathname.startsWith(href));
          const isAct =
            item.getAttribute('data-selected') === 'true' ||
            item.getAttribute('aria-current') === 'page' ||
            item.getAttribute('aria-selected') === 'true' ||
            matchedHref;
          if (isAct) mark(item, 'data-ag-cs-sb-nav-active', '1');
        }
      }

      // 2. Project groups, conversation tree hierarchy, active parent linkage, and empty folding
      const headers = document.querySelectorAll ? Array.from(document.querySelectorAll('button[data-testid="project-header"]')) : [];
      const occMap = new Map();

      for (const headerBtn of headers) {
        const key = computeHeaderKey(headerBtn, occMap);
        headerKeyByEl.set(headerBtn, key);

        const { mode, groupEl, headerSlot, bodySlots } = resolveProjectStructure(headerBtn);
        mark(groupEl, 'data-ag-cs-sb-group', '1');
        if (headerSlot && headerSlot !== groupEl) {
          mark(headerSlot, 'data-ag-cs-sb-header', '1');
        }

        const convoRows = [];
        for (const slot of bodySlots) {
          if (safeMatches(slot, '[data-testid="conversation-row-sidebar"]')) {
            convoRows.push(slot);
          }
          if (slot.querySelectorAll) {
            for (const r of slot.querySelectorAll('[data-testid="conversation-row-sidebar"]')) {
              convoRows.push(r);
            }
          }
        }

        if (convoRows.length > 0) {
          peekEmptyKeys.delete(key);
          mark(groupEl, 'data-ag-cs-sb-has-convos', '1');
          if (mode === 'grouped' && bodySlots.length === 1 && !safeMatches(bodySlots[0], '[data-testid="conversation-row-sidebar"]')) {
            mark(bodySlots[0], 'data-ag-cs-sb-children', '1');
          } else {
            for (const slot of bodySlots) {
              if (!safeMatches(slot, '[data-testid="conversation-row-sidebar"]')) {
                mark(slot, 'data-ag-cs-sb-children', '1');
              }
            }
          }
          let groupHasActive = false;
          for (const row of convoRows) {
            if (isRowActive(row, activeCid)) {
              groupHasActive = true;
              mark(row, 'data-ag-cs-sb-active', '1');
            }
          }
          if (groupHasActive) {
            mark(groupEl, 'data-ag-cs-sb-has-active', '1');
          }
          continue;
        }

        // Check if this project group is empty (no conversations, possibly showing empty placeholder)
        let emptyRowEl = null;
        let emptyBodyEl = null;
        for (const slot of bodySlots) {
          const found = findEmptyRowElement(slot);
          if (found) {
            emptyRowEl = found;
            emptyBodyEl = slot;
            break;
          }
        }

        const isPeeked = peekEmptyKeys.has(key);
        const hasSpin = Boolean(groupEl.querySelector?.('[data-testid="status-loading-spinner"]'));
        if (!hasSpin && (emptyRowEl || bodySlots.length === 0)) {
          mark(groupEl, 'data-ag-cs-sb-empty', '1');
          if (isPeeked) mark(groupEl, 'data-ag-cs-sb-peek', '1');
          if (emptyRowEl) {
            mark(emptyRowEl, 'data-ag-cs-sb-empty-row', '1');
            if (foldEmpty && !isPeeked) mark(emptyRowEl, 'data-ag-cs-sb-folded', '1');
          }
          if (emptyBodyEl && emptyBodyEl !== emptyRowEl && !emptyBodyEl.querySelector?.('button, [data-testid="conversation-row-sidebar"]')) {
            mark(emptyBodyEl, 'data-ag-cs-sb-empty-body', '1');
            if (foldEmpty && !isPeeked) mark(emptyBodyEl, 'data-ag-cs-sb-folded', '1');
          }
        }
      }

      clearStaleTags(nextTags);
    }

    function clearAllTags() {
      for (const [el, attrs] of taggedAttrs.entries()) {
        for (const attr of attrs) {
          try {
            el.removeAttribute(attr);
          } catch {}
        }
      }
      taggedAttrs.clear();
      if (typeof document !== 'undefined' && document.querySelectorAll) {
        document.querySelectorAll(SB_ATTRS.map((a) => `[${a}]`).join(', ')).forEach((el) => {
          for (const attr of SB_ATTRS) el.removeAttribute(attr);
        });
      }
    }

    function onClick(ev) {
      if (ctx.isDestroyed && ctx.isDestroyed()) return false;
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      const target = ev?.target;
      if (!target) return false;

      const headerBtn = safeClosest(target, 'button[data-testid="project-header"]');
      if (headerBtn) {
        if (cfg.sidebarRestyle === false || cfg.sidebarFoldEmpty === false) {
          ctx.scheduleSync?.();
          return false;
        }
        if (isSecondaryHeaderClick(target, headerBtn)) {
          ctx.scheduleSync?.();
          return false;
        }

        // Ensure group attributes reflect current DOM before checking empty state
        sync();
        const { groupEl, bodySlots } = resolveProjectStructure(headerBtn);
        if (!groupEl || groupEl.getAttribute('data-ag-cs-sb-empty') !== '1') {
          ctx.scheduleSync?.();
          return false;
        }

        const key = headerKeyByEl.get(headerBtn) || `${normalizeText(headerBtn.textContent)}#0`;
        const hasMountedEmptyBody = bodySlots.some((s) => Boolean(findEmptyRowElement(s)));
        const currentlyPeeked = peekEmptyKeys.has(key);

        if (!currentlyPeeked) {
          peekEmptyKeys.add(key);
          if (hasMountedEmptyBody) {
            if (typeof ev.preventDefault === 'function') ev.preventDefault();
            if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
            if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
            sync();
            return true;
          }
          ctx.scheduleSync?.();
          return false;
        }

        peekEmptyKeys.delete(key);
        if (hasMountedEmptyBody) {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
          if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
          sync();
          return true;
        }
        ctx.scheduleSync?.();
        return false;
      }

      if (safeClosest(target, '[data-testid="conversation-row-sidebar"], [data-testid="sidebar-navigation-items"]')) {
        ctx.scheduleSync?.();
      }
      return false;
    }

    function destroy() {
      peekEmptyKeys.clear();
      clearAllTags();
    }

    return {
      sync,
      onClick,
      destroy,
    };
  }

  return {
    create,
    isEmptyPlaceholderText,
    parseActiveCascadeId,
    resolveProjectStructure,
    SB_ATTRS,
  };
});
