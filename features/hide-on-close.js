// Hide-on-Close for AGY Claude Style.
// Intercepts window close (red × button / Cmd+W) and hides Antigravity cleanly to background
// instead of destroying the main BrowserWindow (preventing reload prompts when returning).
// Real Quit (Cmd+Q, Dock Quit while hidden, Alt+F4) and Reload (Cmd+R / F5) still work normally.
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
    const hasShift = Boolean(ev.shiftKey);

    // Explicit Quit or Reload shortcuts must always pass through unobstructed
    if (isMac && hasMeta && !hasCtrl && !hasAlt && (key === 'q' || code === 'keyq')) return 'allow-unload';
    if (!isMac && hasAlt && !hasCtrl && !hasMeta && (key === 'f4' || code === 'f4')) return 'allow-unload';
    if (isMac && hasMeta && !hasCtrl && !hasAlt && (key === 'r' || code === 'keyr')) return 'allow-unload';
    if (!isMac && hasCtrl && !hasMeta && !hasAlt && (key === 'r' || code === 'keyr')) return 'allow-unload';
    if (key === 'f5' || code === 'f5') return 'allow-unload';

    // Window Close shortcut (Cmd+W on macOS)
    if (isMac && hasMeta && !hasCtrl && !hasAlt && !hasShift && (key === 'w' || code === 'keyw')) {
      return 'hide-window';
    }
    return 'none';
  }

  function shouldInterceptBeforeUnload({ enabled, nowMs, allowRealUnloadUntil, isHidden }) {
    if (enabled === false) return false;
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

    function hideToBackground() {
      const now = Date.now();
      if (now - lastHideAt < 350) return true;
      lastHideAt = now;

      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      const bindingName = cfg.binding || '__agClaudeStyleSetting';
      const send = typeof window !== 'undefined' ? window[bindingName] : null;
      if (isMac && typeof send === 'function') {
        try {
          send(JSON.stringify({ key: '__windowAction', value: 'hide' }));
          // Self-healing fallback: if an older watcher without __windowAction is attached, minimize after 220ms
          setTimeout(() => {
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
      return false;
    }

    function handleKeyDown(ev) {
      if (ctx.isDestroyed && ctx.isDestroyed()) return;
      if (isSidecarFrame()) return;
      const action = classifyShortcut(ev, isMac);
      if (action === 'allow-unload') {
        allowRealUnloadUntil = Date.now() + 3000;
        return;
      }
      if (action === 'hide-window' && isEnabled()) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        hideToBackground();
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
        })
      ) {
        return;
      }
      // In Electron BrowserWindow, preventing default + setting returnValue=false
      // cancels window destruction so we can hide to background instead of reloading later.
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
        origNativeClose = nativeObj.close;
        nativeObj.close = function agCsHideOnCloseWrapper(...args) {
          if (isEnabled() && Date.now() >= allowRealUnloadUntil && !(typeof document !== 'undefined' && document.hidden)) {
            return hideToBackground();
          }
          return origNativeClose.apply(this, args);
        };
        wrappedNativeClose = true;
      } catch {}
    }

    if (typeof window !== 'undefined' && !isSidecarFrame()) {
      window.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('beforeunload', handleBeforeUnload, true);
      maybeWrapNativeClose();
    }

    function destroy() {
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', handleKeyDown, true);
        window.removeEventListener('beforeunload', handleBeforeUnload, true);
        if (wrappedNativeClose && origNativeClose && window.electronNative) {
          try {
            window.electronNative.close = origNativeClose;
          } catch {}
        }
      }
      wrappedNativeClose = false;
      origNativeClose = null;
    }

    return {
      sync() {},
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
