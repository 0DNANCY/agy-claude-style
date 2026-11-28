// Dynamic Local Wallpaper Renderer for AGY Claude Style (v4.0.0).
// Supports video (MP4/WebM) & image (GIF/WebP/PNG/JPG) in Global Window or Home Page scope,
// triple-resilient loading (vscode-file -> loopback Range HTTP -> CDP chunked Blob fallback),
// and battery-saving auto-pause on window blur / hidden.
// Registers on globalThis.__agCsFeatures.wallpaper.
(function (root, factory) {
  const feature = factory();
  if (typeof module === 'object' && module.exports) module.exports = feature;
  else {
    root.__agCsFeatures = root.__agCsFeatures || {};
    root.__agCsFeatures.wallpaper = feature;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const HOST_CLASS = 'ag-cs-wallpaper-host';
  const MEDIA_CLASS = 'ag-cs-wallpaper-media';
  const SCRIM_CLASS = 'ag-cs-wallpaper-scrim';
  const CHUNK_SIZE = 524288;

  function clampNum(val, min, max, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function decodeBase64ToUint8(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function create(ctx) {
    let hostEl = null;
    let mediaEl = null;
    let scrimEl = null;
    let activeKey = '';
    let activeBlobUrl = '';
    let loadSerial = 0;
    let listenersBound = false;
    let metaOverride = null;

    const pendingChunks = new Map();
    if (typeof window !== 'undefined') {
      window.__agCsWallpaperChunkReply = (reqId, res) => {
        const entry = pendingChunks.get(reqId);
        if (!entry) return;
        pendingChunks.delete(reqId);
        clearTimeout(entry.timer);
        entry.resolve(res);
      };
    }

    function requestChunkOverCdp(bindingName, file, offset) {
      return new Promise((resolveReq) => {
        const send = bindingName && typeof window !== 'undefined' ? window[bindingName] : null;
        if (typeof send !== 'function') {
          resolveReq({ ok: false, error: 'CDP binding unavailable' });
          return;
        }
        const reqId = `wp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(() => {
          pendingChunks.delete(reqId);
          resolveReq({ ok: false, error: 'CDP chunk timeout' });
        }, 8000);
        pendingChunks.set(reqId, { resolve: resolveReq, timer });
        try {
          send(JSON.stringify({ key: '__wallpaperRead', value: { reqId, file, offset, length: CHUNK_SIZE } }));
        } catch {
          pendingChunks.delete(reqId);
          clearTimeout(timer);
          resolveReq({ ok: false, error: 'CDP send failed' });
        }
      });
    }

    async function loadBlobFallback(file, bindingName, serial) {
      const chunks = [];
      let offset = 0;
      let mime = 'application/octet-stream';
      while (true) {
        if (serial !== loadSerial || ctx.isDestroyed()) return null;
        const res = await requestChunkOverCdp(bindingName, file, offset);
        if (!res || !res.ok) return null;
        if (res.mime) mime = res.mime;
        if (res.base64) chunks.push(decodeBase64ToUint8(res.base64));
        if (res.eof) break;
        offset = Number(res.nextOffset) || offset + CHUNK_SIZE;
      }
      if (serial !== loadSerial || ctx.isDestroyed() || typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') {
        return null;
      }
      const blob = new Blob(chunks, { type: mime });
      return URL.createObjectURL(blob);
    }

    function revokeBlob() {
      if (activeBlobUrl) {
        try {
          URL.revokeObjectURL(activeBlobUrl);
        } catch {}
        activeBlobUrl = '';
      }
    }

    function motionReduced() {
      try {
        return Boolean(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch {
        return false;
      }
    }

    function shouldPauseVideo() {
      const cfg = ctx.getCfg() || {};
      if (motionReduced()) return true;
      if (cfg.wpPauseBlur !== false) {
        if (document.hidden) return true;
        if (typeof document.hasFocus === 'function' && !document.hasFocus()) return true;
      }
      return false;
    }

    function syncVideoPlayback() {
      if (!mediaEl || mediaEl.tagName !== 'VIDEO') return;
      const cfg = ctx.getCfg() || {};
      const rate = clampNum(cfg.wpRate, 25, 200, 100) / 100;
      try {
        if (Math.abs((mediaEl.playbackRate || 1) - rate) > 0.01) {
          mediaEl.playbackRate = rate;
        }
      } catch {}
      if (shouldPauseVideo()) {
        try {
          if (!mediaEl.paused && typeof mediaEl.pause === 'function') mediaEl.pause();
        } catch {}
      } else {
        try {
          if (mediaEl.paused && typeof mediaEl.play === 'function') {
            const p = mediaEl.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          }
        } catch {}
      }
    }

    function onFocusOrVisChange() {
      syncVideoPlayback();
    }

    function bindPowerListeners() {
      if (listenersBound) return;
      listenersBound = true;
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onFocusOrVisChange);
      }
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('blur', onFocusOrVisChange);
        window.addEventListener('focus', onFocusOrVisChange);
      }
    }

    function unbindPowerListeners() {
      if (!listenersBound) return;
      listenersBound = false;
      if (typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onFocusOrVisChange);
      }
      if (typeof window.removeEventListener === 'function') {
        window.removeEventListener('blur', onFocusOrVisChange);
        window.removeEventListener('focus', onFocusOrVisChange);
      }
    }

    function clearCssVars() {
      const html = document.documentElement;
      if (!html) return;
      html.removeAttribute('data-ag-cs-wp');
      if (html.style && typeof html.style.removeProperty === 'function') {
        for (const k of ['--ag-cs-wp-opacity', '--ag-cs-wp-blur', '--ag-cs-wp-scrim', '--ag-cs-wp-surface-alpha']) {
          html.style.removeProperty(k);
        }
      }
    }

    function unmount() {
      loadSerial += 1;
      activeKey = '';
      if (mediaEl && mediaEl.tagName === 'VIDEO') {
        try {
          mediaEl.pause();
          mediaEl.removeAttribute('src');
          if (typeof mediaEl.load === 'function') mediaEl.load();
        } catch {}
      }
      if (hostEl && hostEl.parentElement) {
        hostEl.parentElement.removeChild(hostEl);
      }
      hostEl = null;
      mediaEl = null;
      scrimEl = null;
      revokeBlob();
      clearCssVars();
      unbindPowerListeners();
    }

    function applyCssVars(cfg, mode) {
      const html = document.documentElement;
      if (!html) return;
      html.setAttribute('data-ag-cs-wp', mode);
      const opacity = clampNum(cfg.wpOpacity, 5, 100, 35) / 100;
      const blur = clampNum(cfg.wpBlur, 0, 48, 0);
      const dim = clampNum(cfg.wpDim, -50, 85, 25);
      const surfaceAlpha = clampNum(cfg.wpSurfaceAlpha, 15, 100, 76);
      const scrim = dim >= 0
        ? `rgba(7, 9, 13, ${(dim / 100).toFixed(3)})`
        : `rgba(255, 255, 255, ${(Math.abs(dim) / 100).toFixed(3)})`;

      html.style.setProperty('--ag-cs-wp-opacity', String(opacity));
      html.style.setProperty('--ag-cs-wp-blur', `${blur}px`);
      html.style.setProperty('--ag-cs-wp-scrim', scrim);
      html.style.setProperty('--ag-cs-wp-surface-alpha', `${surfaceAlpha}%`);
      if (hostEl) {
        hostEl.setAttribute('data-wp-blurred', blur > 0 ? '1' : '0');
      }
    }

    function buildCandidateSources(meta) {
      const sources = [];
      const proto = typeof location !== 'undefined' ? String(location.protocol || '') : '';
      if (proto === 'vscode-file:' && meta.vscodeUri) {
        sources.push(meta.vscodeUri);
      }
      if (meta.httpUrl) {
        sources.push(meta.httpUrl);
      }
      if (proto !== 'vscode-file:' && meta.vscodeUri) {
        sources.push(meta.vscodeUri);
      }
      return sources;
    }

    function attachMediaElement(meta, cfg) {
      if (!hostEl) return;
      const isVideo = meta.kind === 'video';
      const tag = isVideo ? 'video' : 'img';
      if (!mediaEl || mediaEl.tagName.toLowerCase() !== tag) {
        if (mediaEl) mediaEl.remove();
        mediaEl = document.createElement(tag);
        mediaEl.className = MEDIA_CLASS;
        mediaEl.setAttribute('aria-hidden', 'true');
        mediaEl.setAttribute('draggable', 'false');
        if (isVideo) {
          mediaEl.muted = true;
          mediaEl.defaultMuted = true;
          mediaEl.loop = true;
          mediaEl.playsInline = true;
          mediaEl.autoplay = true;
          mediaEl.preload = 'auto';
        }
        hostEl.insertBefore(mediaEl, scrimEl || null);
      }

      const serial = ++loadSerial;
      revokeBlob();
      const candidates = buildCandidateSources(meta);
      let idx = 0;

      const tryNextSource = async () => {
        if (serial !== loadSerial || !mediaEl) return;
        if (idx < candidates.length) {
          mediaEl.src = candidates[idx++];
          if (isVideo) syncVideoPlayback();
          return;
        }
        const blobUrl = await loadBlobFallback(meta.file, cfg.binding, serial);
        if (blobUrl && serial === loadSerial && mediaEl) {
          activeBlobUrl = blobUrl;
          mediaEl.src = blobUrl;
          if (isVideo) syncVideoPlayback();
        }
      };

      mediaEl.onerror = () => {
        void tryNextSource();
      };
      if (isVideo) {
        mediaEl.onloadeddata = () => syncVideoPlayback();
      }
      void tryNextSource();
    }

    function sync() {
      if (ctx.isDestroyed()) return;
      const cfg = ctx.getCfg() || {};
      const mode = cfg.wpMode === 'global' || cfg.wpMode === 'home' ? cfg.wpMode : 'off';
      const meta = metaOverride || globalThis.__agCsWallpaperMeta || null;
      const wpFile = String(cfg.wpFile || '').trim();

      if (mode === 'off' || !wpFile || !meta || meta.file !== wpFile) {
        if (hostEl || document.documentElement?.hasAttribute?.('data-ag-cs-wp')) {
          unmount();
        }
        return;
      }

      const container = mode === 'home' ? document.querySelector('.agy-home') : document.body;
      if (!container) {
        if (hostEl) unmount();
        return;
      }

      if (!hostEl || !hostEl.isConnected || hostEl.parentElement !== container) {
        if (hostEl && hostEl.parentElement) hostEl.parentElement.removeChild(hostEl);
        hostEl = document.createElement('div');
        hostEl.className = HOST_CLASS;
        hostEl.setAttribute('aria-hidden', 'true');
        hostEl.setAttribute('data-ag-no-i18n', '');
        scrimEl = document.createElement('div');
        scrimEl.className = SCRIM_CLASS;
        scrimEl.setAttribute('aria-hidden', 'true');
        hostEl.appendChild(scrimEl);
        if (mode === 'home') {
          container.insertBefore(hostEl, container.firstChild);
        } else {
          container.insertBefore(hostEl, container.firstChild);
        }
      }

      bindPowerListeners();
      applyCssVars(cfg, mode);

      const nextKey = `${meta.file}|${meta.mtimeMs || 0}|${meta.httpUrl || ''}|${meta.kind}`;
      if (nextKey !== activeKey || !mediaEl || !mediaEl.isConnected) {
        activeKey = nextKey;
        attachMediaElement(meta, cfg);
      } else {
        syncVideoPlayback();
      }
    }

    function onWallpaperMeta(meta) {
      metaOverride = meta || null;
      sync();
    }

    function destroy() {
      for (const entry of pendingChunks.values()) {
        clearTimeout(entry.timer);
      }
      pendingChunks.clear();
      unmount();
    }

    return {
      ownSelector: `.${HOST_CLASS}`,
      sync,
      onWallpaperMeta,
      destroy,
    };
  }

  return { create };
});
