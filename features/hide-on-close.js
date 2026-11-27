// Hide-on-Close for AGY Claude Style.
// Intercepts actual window close events (beforeunload / electronNative.close) and hides Antigravity
// cleanly to background instead of destroying the main BrowserWindow.
// Never hijacks Cmd+W / Ctrl+W shortcuts so native tab / extension-tab closing continues to work.
// Real Quit (Cmd+Q, Dock Quit while hidden, Alt+F4) and Reload (Cmd+R / F5) pass through normally.
// Registers on globalThis.__agCsFeatures.hideOnClose.
(function (root, factory) {
  const feature = factory();
  if (typeof module === 'object' && module.exports) module.exports = feature;
  else {
    root.__agCsFeatures = root.__agCsFeatures || {};
    root.__agCsFeatures.hideOnClose = feature;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  function isMacPlatform(nav) {
    const n = nav || (typeof navigator !== 'undefined' ? navigator : null);
    const plat = String(n?.platform || n?.userAgentData?.platform || n?.userAgent || '').toLowerCase();
    return plat.includes('mac');
  }

  function classifyShortcut(ev, isMac) {
    if (!ev) return 'none';
    const key = String(ev.key || '').toLowerCase();
    const code = String(ev.code || '').toLowerCase();
    const hasMeta = Boolean(ev.metaKey);
    const hasCtrl = Boolean(ev.ctrlKey);
    const hasAlt = Boolean(ev.altKey);

    // Explicit Quit or Reload shortcuts must always pass through unobstructed
    if (isMac && hasMeta && !hasCtrl && !hasAlt && (key === 'q' || code === 'keyq')) return 'allow-unload';
    if (!isMac && hasCtrl && !hasMeta && !hasAlt && (key === 'q' || code === 'keyq')) return 'allow-unload';
    if (!isMac && hasAlt && !hasCtrl && !hasMeta && (key === 'f4' || code === 'f4')) return 'allow-unload';
    if (isMac && hasMeta && !hasCtrl && !hasAlt && (key === 'r' || code === 'keyr')) return 'allow-unload';
    if (!isMac && hasCtrl && !hasMeta && !hasAlt && (key === 'r' || code === 'keyr')) return 'allow-unload';
    if (key === 'f5' || code === 'f5') return 'allow-unload';

    // Never intercept Cmd+W / Ctrl+W: let Antigravity close active editor/extension tabs natively.
    return 'none';
  }

  function shouldInterceptBeforeUnload({ enabled, nowMs, allowRealUnloadUntil, isHidden, canHide = true, wrappedNativeClose = false }) {
    if (enabled === false) return false;
    if (!canHide || wrappedNativeClose) return false;
    if (nowMs < allowRealUnloadUntil) return false;
    // When window is already hidden (e.g. user clicked Quit from Dock icon), allow clean quit
    if (isHidden) return false;
    return true;
  }

  function create(ctx) {
    const isMac = isMacPlatform();
    let allowRealUnloadUntil = 0;
    let lastHideAt = 0;
    let origNativeClose = null;
    let wrappedNativeClose = false;
    let fallbackTimer = null;

    function isEnabled() {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      return cfg.hideOnClose !== false;
    }

    function isSidecarFrame() {
      try {
        return typeof location !== 'undefined' && location.protocol === 'plugin:';
      } catch {
        return false;
      }
    }

    function canHideCurrentHost() {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      const bindingName = cfg.binding || '__agClaudeStyleSetting';
      const hasBinding = typeof window !== 'undefined' && typeof window[bindingName] === 'function';
      const hasMinimize = typeof window !== 'undefined' && typeof window.electronNative?.minimize === 'function';
      return isMac ? hasBinding || hasMinimize : hasMinimize;
    }

    function hideToBackground() {
      if (ctx.isDestroyed && ctx.isDestroyed()) return false;
      const now = Date.now();
      if (now - lastHideAt < 350) return true;
      lastHideAt = now;

      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      const bindingName = cfg.binding || '__agClaudeStyleSetting';
      const send = typeof window !== 'undefined' ? window[bindingName] : null;
      if (isMac && typeof send === 'function') {
        try {
          send(JSON.stringify({ key: '__windowAction', value: 'hide' }));
          if (fallbackTimer) clearTimeout(fallbackTimer);
          fallbackTimer = setTimeout(() => {
            fallbackTimer = null;
            if (ctx.isDestroyed && ctx.isDestroyed()) return;
            try {
              if (typeof document !== 'undefined' && !document.hidden && typeof window.electronNative?.minimize === 'function') {
                window.electronNative.minimize();
              }
            } catch {}
          }, 220);
          return true;
        } catch {}
      }
      try {
        if (typeof window !== 'undefined' && typeof window.electronNative?.minimize === 'function') {
          window.electronNative.minimize();
          return true;
        }
      } catch {}
      if (!isMac && typeof send === 'function') {
        try {
          send(JSON.stringify({ key: '__windowAction', value: 'hide' }));
          return true;
        } catch {}
      }
      return false;
    }

    function handleKeyDown(ev) {
      if (ctx.isDestroyed && ctx.isDestroyed()) return;
      if (isSidecarFrame()) return;
      const action = classifyShortcut(ev, isMac);
      if (action === 'allow-unload') {
        allowRealUnloadUntil = Date.now() + 3000;
      }
    }

    function handleBeforeUnload(ev) {
      if (ctx.isDestroyed && ctx.isDestroyed()) return;
      if (isSidecarFrame()) return;
      if (
        !shouldInterceptBeforeUnload({
          enabled: isEnabled(),
          nowMs: Date.now(),
          allowRealUnloadUntil,
          isHidden: Boolean(typeof document !== 'undefined' && document.hidden),
          canHide: canHideCurrentHost(),
          wrappedNativeClose,
        })
      ) {
        return;
      }
      try {
        ev.preventDefault();
      } catch {}
      try {
        ev.returnValue = false;
      } catch {}
      setTimeout(() => {
        if (!ctx.isDestroyed || !ctx.isDestroyed()) hideToBackground();
      }, 0);
      return false;
    }

    function maybeWrapNativeClose() {
      if (wrappedNativeClose || isSidecarFrame()) return;
      try {
        const nativeObj = typeof window !== 'undefined' ? window.electronNative : null;
        if (!nativeObj || typeof nativeObj.close !== 'function') return;
        const desc = Object.getOwnPropertyDescriptor(nativeObj, 'close');
        if (desc && desc.writable === false && desc.configurable === false) return;
        const curClose = nativeObj.close;
        origNativeClose = typeof curClose.__agCsHideOrig === 'function' ? curClose.__agCsHideOrig : curClose;
        const wrapped = function agCsHideOnCloseWrapper(...args) {
          if (
            (!ctx.isDestroyed || !ctx.isDestroyed()) &&
            isEnabled() &&
            Date.now() >= allowRealUnloadUntil &&
            !(typeof document !== 'undefined' && document.hidden)
          ) {
            hideToBackground();
            return Promise.resolve();
          }
          return origNativeClose.apply(this, args);
        };
        wrapped.__agCsHideOrig = origNativeClose;
        nativeObj.close = wrapped;
        wrappedNativeClose = true;
      } catch {}
    }

    if (typeof window !== 'undefined' && !isSidecarFrame()) {
      window.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('beforeunload', handleBeforeUnload, true);
      maybeWrapNativeClose();
    }

    function destroy() {
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', handleKeyDown, true);
        window.removeEventListener('beforeunload', handleBeforeUnload, true);
        if (window.electronNative && typeof window.electronNative.close === 'function') {
          try {
            const orig = origNativeClose || window.electronNative.close.__agCsHideOrig;
            if (orig) window.electronNative.close = orig;
          } catch {}
        }
      }
      wrappedNativeClose = false;
      origNativeClose = null;
    }

    return {
      sync() {
        maybeWrapNativeClose();
      },
      destroy,
    };
  }

  return {
    isMacPlatform,
    classifyShortcut,
    shouldInterceptBeforeUnload,
    create,
  };
});
