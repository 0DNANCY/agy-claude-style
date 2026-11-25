// File & Media Context Menu feature for AGY Claude Style (chat file links, file tree & chat images).
// Registers on globalThis.__agCsFeatures.fileMenu.
(function (root, factory) {
  const feature = factory();
  if (typeof module === 'object' && module.exports) module.exports = feature;
  else {
    root.__agCsFeatures = root.__agCsFeatures || {};
    root.__agCsFeatures.fileMenu = feature;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const COMPOSER_EDITOR_SEL = '[data-testid="agent-input-box"] [contenteditable="true"]';
  const FILE_LINK_SEL =
    '[data-testid="agent-response"] [data-uri^="file://"], ' +
    '[data-testid="agent-response"] a[href^="file://"], ' +
    '[data-testid="user-input-step"] [data-uri^="file://"], ' +
    '[data-testid="user-input-step"] a[href^="file://"], ' +
    '[data-testid*="file-tree"] [data-uri^="file://"], ' +
    '[role="treeitem"][data-uri^="file://"]';

  function decodeFileUri(rawUri) {
    const s = String(rawUri || '').trim();
    if (!s) return '';
    if (!/^file:\/\//i.test(s)) return s.split('#')[0];
    const clean = s.split('#')[0].split('?')[0];
    let p = clean.replace(/^file:\/\//i, '');
    try {
      p = decodeURIComponent(p);
    } catch {}
    if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
    return p;
  }

  function toFileUri(rawPath) {
    const s = String(rawPath || '').trim();
    if (!s) return '';
    if (/^file:\/\//i.test(s)) return s;
    if (/^[a-zA-Z]:[\\/]/.test(s)) {
      const normalized = s.replace(/\\/g, '/');
      return `file:///${encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
    }
    if (/^\\\\[^\\]+\\/.test(s)) {
      const normalized = s.replace(/\\/g, '/').replace(/^\/+/, '');
      return `file://${encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
    }
    if (s.startsWith('/')) {
      return `file://${encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
    }
    return '';
  }

  function extractFileUriFromTarget(target) {
    if (!target || !target.closest) return null;
    const direct = target.closest(FILE_LINK_SEL);
    if (direct) {
      const uri = direct.getAttribute('data-uri') || direct.getAttribute('href') || '';
      if (uri.startsWith('file://')) return { uri, el: direct };
    }
    // Walk React Fiber props on file-tree items when data-uri is not reflected in DOM
    const treeItem = target.closest('[role="treeitem"], [data-testid*="file-tree"] button, [data-testid*="file-tree"] div');
    if (treeItem) {
      const k = Object.keys(treeItem).find((x) => x.startsWith('__reactFiber$'));
      let node = k ? treeItem[k] : null;
      let steps = 0;
      while (node && steps < 24) {
        steps++;
        const p = node.memoizedProps;
        const cand = p?.uri || p?.fileUri || p?.item?.uri || p?.node?.uri || p?.path || p?.filePath;
        if (typeof cand === 'string') {
          const uri = toFileUri(cand);
          if (uri) return { uri, el: treeItem };
        }
        node = node.return;
      }
    }
    return null;
  }

  function findChatMediaImage(target) {
    if (!target || typeof target.closest !== 'function') return null;
    const step = target.closest('[data-testid="user-input-step"], [data-testid="agent-response"]');
    if (!step) return null;
    if (target.closest('[data-uri^="file://"], a[href^="file://"]')) return null;
    let img = target.closest('img');
    if (!img) {
      const mediaBtn = target.closest('[data-testid="user-message-media-scroll"] button');
      img = mediaBtn?.querySelector?.('img') || null;
    }
    if (!img) return null;
    if (img.closest?.('[data-uri^="file://"], a[href^="file://"]')) return null;
    const src = String(img.currentSrc || img.getAttribute?.('src') || img.src || '').trim();
    if (!src || src.includes('/symbols-icons/')) return null;
    return img;
  }

  function extractCustomizationCardFromTarget(target) {
    if (!target || typeof target.closest !== 'function') return null;
    const card = target.closest('[data-testid="customization-card"]');
    if (!card) return null;
    const installedRoot = card.closest('[data-testid="customizations-installed"], [data-testid="customizations-installed-plugins"]');
    if (!installedRoot) return null;

    const info = {
      card,
      name: card.getAttribute('data-card-name') || '',
      uri: '',
      localPath: '',
      pluginDisabled: undefined,
      onToggle: null,
      canUninstall: false,
      onUninstall: null,
      disabled: false,
      uninstallLabel: '',
      detailTrigger: card.querySelector('a[href], button[aria-describedby]') || null,
    };

    const pickPath = (raw) => {
      if (info.uri || typeof raw !== 'string') return;
      const uri = toFileUri(raw);
      if (uri) {
        info.uri = uri;
        info.localPath = decodeFileUri(uri);
      }
    };

    const absorbActionProps = (ap) => {
      if (!ap || typeof ap !== 'object') return;
      if (typeof ap.name === 'string' && ap.name && !info.name) info.name = ap.name;
      if (typeof ap.pluginDisabled === 'boolean' && info.pluginDisabled === undefined) {
        info.pluginDisabled = ap.pluginDisabled;
      }
      if (typeof ap.onToggle === 'function' && !info.onToggle) info.onToggle = ap.onToggle;
      if (ap.canUninstall && typeof ap.onUninstall === 'function' && !info.onUninstall) {
        info.canUninstall = true;
        info.onUninstall = ap.onUninstall;
      }
      if (ap.disabled) info.disabled = true;
      if (typeof ap.uninstallLabel === 'string' && ap.uninstallLabel && !info.uninstallLabel) {
        info.uninstallLabel = ap.uninstallLabel;
      }
      if (typeof ap.copyablePath === 'string') pickPath(ap.copyablePath);
      if (Array.isArray(ap.sources)) {
        for (const src of ap.sources) {
          if (src && typeof src.source === 'string') pickPath(src.source);
          if (src && typeof src.path === 'string') pickPath(src.path);
        }
      }
    };

    // 1. Walk Fiber upward from the customization card (T4 -> key is p.path, action.props is a5 props)
    const fiberKey = Object.keys(card).find((x) => x.startsWith('__reactFiber$'));
    let node = fiberKey ? card[fiberKey] : null;
    let steps = 0;
    while (node && steps < 18) {
      steps++;
      if (typeof node.key === 'string') pickPath(node.key);
      const p = node.memoizedProps;
      if (p && typeof p === 'object') {
        if (p.action && p.action.props) absorbActionProps(p.action.props);
        if (typeof p.onToggle === 'function' || typeof p.onUninstall === 'function' || typeof p.copyablePath === 'string') {
          absorbActionProps(p);
        }
        if (typeof p.path === 'string') pickPath(p.path);
        if (p.plugin && typeof p.plugin.path === 'string') pickPath(p.plugin.path);
      }
      node = node.return;
    }

    // 2. Fallback: inspect the card's native "More actions" button fiber if action props weren't found above
    if (!info.onToggle && !info.onUninstall) {
      const moreBtn = card.querySelector('button[aria-label^="More actions"], button[aria-haspopup="menu"]');
      const btnKey = moreBtn ? Object.keys(moreBtn).find((x) => x.startsWith('__reactFiber$')) : null;
      let bNode = btnKey ? moreBtn[btnKey] : null;
      let bSteps = 0;
      while (bNode && bSteps < 14) {
        bSteps++;
        const bp = bNode.memoizedProps;
        if (bp && typeof bp === 'object' && (typeof bp.onToggle === 'function' || typeof bp.onUninstall === 'function' || typeof bp.copyablePath === 'string')) {
          absorbActionProps(bp);
        }
        bNode = bNode.return;
      }
    }

    const hasAnyAction = Boolean(
      info.uri ||
      (info.onToggle && typeof info.pluginDisabled === 'boolean') ||
      (info.canUninstall && info.onUninstall) ||
      info.detailTrigger
    );
    return hasAnyAction ? info : null;
  }

  function detectImageMime(bytes, fallback = 'image/png') {
    if (bytes && bytes.length >= 12) {
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
      if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    }
    return /^image\/[a-z0-9.+-]+$/i.test(String(fallback || '')) ? String(fallback).toLowerCase() : 'image/png';
  }

  function imageExtForMime(mime) {
    return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' })[mime] || 'png';
  }

  function imageFilename(img, mime) {
    const ext = imageExtForMime(mime);
    const src = String(img?.currentSrc || img?.getAttribute?.('src') || img?.src || '');
    if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
      try {
        const base = decodeURIComponent(new URL(src, location?.href || 'http://127.0.0.1').pathname.split('/').pop() || '')
          .replace(/[\\/:*?"<>|]+/g, '')
          .trim();
        if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
      } catch {}
    }
    const alt = String(img?.alt || '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 48);
    if (alt && !/^user-uploaded-media/i.test(alt)) return /\.[a-z0-9]{2,5}$/i.test(alt) ? alt : `${alt}.${ext}`;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `image-${stamp}.${ext}`;
  }

  function renderImgToCanvasBlob(img, mime = 'image/png') {
    return new Promise((resolve, reject) => {
      try {
        const w = img?.naturalWidth || img?.width || 0;
        const h = img?.naturalHeight || img?.height || 0;
        if (!w || !h) {
          reject(new Error('图片尚未加载完成'));
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) {
          reject(new Error('无法读取图像数据'));
          return;
        }
        ctx2d.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('图像导出失败'))), mime);
      } catch (err) {
        reject(err);
      }
    });
  }

  async function extractImagePayload(img) {
    const src = String(img?.currentSrc || img?.getAttribute?.('src') || img?.src || '').trim();
    if (!src) throw new Error('未找到图片来源');
    const dataMatch = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(src);
    if (dataMatch) {
      const declared = dataMatch[1] || 'image/png';
      let bytes;
      if (dataMatch[2]) {
        const raw = atob(dataMatch[3].replace(/\s+/g, ''));
        bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      } else {
        bytes = new TextEncoder().encode(decodeURIComponent(dataMatch[3]));
      }
      const mimeType = detectImageMime(bytes, declared);
      const blob = typeof Blob === 'function' ? new Blob([bytes], { type: mimeType }) : null;
      return { bytes, blob, mimeType, name: imageFilename(img, mimeType) };
    }
    try {
      const resp = await fetch(src);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const mimeType = detectImageMime(bytes, resp.headers?.get?.('content-type')?.split(';')[0] || 'image/png');
      const blob = typeof Blob === 'function' ? new Blob([bytes], { type: mimeType }) : null;
      return { bytes, blob, mimeType, name: imageFilename(img, mimeType) };
    } catch {
      const blob = await renderImgToCanvasBlob(img, 'image/png');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { bytes, blob, mimeType: 'image/png', name: imageFilename(img, 'image/png') };
    }
  }

  async function ensurePngBlob(payload, img) {
    if (payload.mimeType === 'image/png' && payload.blob) return payload.blob;
    if (typeof createImageBitmap === 'function' && payload.blob) {
      try {
        const bmp = await createImageBitmap(payload.blob);
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close?.();
        return await new Promise((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png')
        );
      } catch {}
    }
    return renderImgToCanvasBlob(img, 'image/png');
  }

  function getAppIconSvg(icon) {
    const s = 'width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" style="flex-shrink:0;display:inline-block"';
    if (icon === 'vscode') {
      return `<svg ${s}><path d="M17.5 2.5L9 10.6 4.4 7.1 2.5 8.1v7.8l1.9 1L9 13.4l8.5 8.1 4-1.9V4.4l-4-1.9zm0 4.5v10l-5.6-5 5.6-5z" fill="#007ACC"/></svg>`;
    }
    if (icon === 'visualstudio') {
      return `<svg ${s}><path d="M17 2.5L8.6 10.5 4.2 7.2 2.5 8.3v7.4l1.7 1.1 4.4-3.3L17 21.5l4.5-2.1V4.6L17 2.5zm0 4.8v9.4L11.8 12 17 7.3z" fill="#8661C5"/></svg>`;
    }
    if (icon === 'cursor') {
      return `<svg ${s}><path d="M12 2L20.5 7v10L12 22 3.5 17V7L12 2z" stroke="currentColor" stroke-width="1.8" fill="color-mix(in srgb,currentColor 12%,transparent)"/><path d="M9 8.5l7.5 3.5-4.2 1.2L11 17.5 9 8.5z" fill="currentColor"/></svg>`;
    }
    if (icon === 'antigravity') {
      return `<svg ${s}><path d="M12 3.5L5 19.5c1.5 1.2 3.6-.8 7-3.4 3.4 2.6 5.5 4.6 7 3.4L12 3.5z" fill="#4285F4"/></svg>`;
    }
    if (icon === 'windsurf') {
      return `<svg ${s}><path d="M4 17c3.5-8 8.5-11 16-12-2.5 4.5-4 8-4 12-4-.5-8 0-12 0z" fill="#09B6A2"/></svg>`;
    }
    if (icon === 'zed') {
      return `<svg ${s}><path d="M5 6h14L5 18h14" stroke="#3B82F6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    if (icon === 'jetbrains') {
      return `<svg ${s}><rect x="3.5" y="3.5" width="17" height="17" rx="3.5" fill="#27282C" stroke="currentColor" stroke-width="1.2"/><line x1="7.5" y1="16.5" x2="14.5" y2="16.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`;
    }
    if (icon === 'sublime') {
      return `<svg ${s}><path d="M18 5L6 9.2v3.6l12-4.2V5zm0 6.2L6 15.4V19l12-4.2v-3.6z" fill="#FF9800"/></svg>`;
    }
    if (icon === 'terminal' || icon === 'gitbash' || icon === 'wsl') {
      return `<svg ${s}><rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" stroke-width="1.7"/><path d="M7.5 9.5L10.5 12l-3 2.5M12.5 14.5h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    if (icon === 'explorer') {
      return `<svg ${s}><path d="M3 6.5A1.5 1.5 0 014.5 5h4.3l1.7 2H19.5A1.5 1.5 0 0121 8.5v9a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5v-11z" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>`;
    }
    if (icon === 'default') {
      return `<svg ${s}><path d="M14 4h6v6M10 14L20 4M18 13v5a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    return `<svg ${s}><path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5M13.5 5l-3 14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function insertRefIntoComposer(localPath) {
    const editor = document.querySelector(COMPOSER_EDITOR_SEL);
    if (!editor) return false;
    const refText = /\s/.test(localPath) ? `"${localPath}" ` : `${localPath} `;
    try {
      editor.focus?.();
      if (typeof document.execCommand === 'function') {
        document.execCommand('insertText', false, refText);
      } else {
        editor.textContent = (editor.textContent || '') + refText;
      }
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  function attachMediaFileToComposer(file) {
    const editor = document.querySelector(COMPOSER_EDITOR_SEL);
    if (!editor || !file || typeof DataTransfer !== 'function') return false;
    try {
      editor.focus?.();
      const dt = new DataTransfer();
      dt.items.add(file);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      editor.dispatchEvent(pasteEvent);
      return true;
    } catch {
      return false;
    }
  }

  function showToast(msg, isErr = false) {
    let toast = document.querySelector('.ag-cs-action-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'ag-cs-action-toast';
      toast.setAttribute('data-ag-no-i18n', '');
      document.body?.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.toggle('is-err', Boolean(isErr));
    toast.classList.add('is-show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      toast.classList.remove('is-show');
    }, 2200);
  }

  function create(ctx) {
    let menuEl = null;
    let subMenuEl = null;
    let subCloseTimer = null;
    let openWithAppsCache = null;
    let reqSeq = 0;
    const pendingReqs = new Map();

    if (typeof window !== 'undefined') {
      window.__agCsFileActionReply = (reqId, payload) => {
        const entry = pendingReqs.get(reqId);
        if (!entry) return;
        clearTimeout(entry.timer);
        pendingReqs.delete(reqId);
        entry.resolve(payload);
      };
    }

    const onOutsidePointer = (ev) => {
      const inMenu = menuEl && menuEl.contains(ev.target);
      const inSub = subMenuEl && subMenuEl.contains(ev.target);
      if (!inMenu && !inSub) closeMenu();
    };
    const onScrollOrBlur = () => closeMenu();

    function closeSubmenu() {
      clearTimeout(subCloseTimer);
      subCloseTimer = null;
      if (subMenuEl) {
        subMenuEl.remove();
        subMenuEl = null;
      }
    }

    function closeMenu() {
      closeSubmenu();
      if (menuEl) {
        menuEl.remove();
        menuEl = null;
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        window.removeEventListener('resize', onScrollOrBlur);
        window.removeEventListener('blur', onScrollOrBlur);
      }
    }

    function sendHostFileAction(type, uri, extra = {}) {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      const bindingName = cfg.binding || '__agClaudeStyleSetting';
      const fn = typeof window !== 'undefined' ? window[bindingName] : null;
      if (typeof fn === 'function') {
        fn(JSON.stringify({ key: '__fileAction', value: { type, uri, ...extra } }));
        return true;
      }
      return false;
    }

    function requestHostFileAction(type, extra = {}, timeoutMs = 4500) {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      const bindingName = cfg.binding || '__agClaudeStyleSetting';
      const fn = typeof window !== 'undefined' ? window[bindingName] : null;
      if (typeof fn !== 'function') {
        return Promise.resolve({ ok: false, error: '宿主桥接未就绪' });
      }
      const reqId = `fa_${Date.now().toString(36)}_${++reqSeq}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingReqs.delete(reqId);
          resolve({ ok: false, error: '请求超时' });
        }, timeoutMs);
        pendingReqs.set(reqId, { resolve, timer });
        try {
          fn(JSON.stringify({ key: '__fileAction', value: { type, reqId, ...extra } }));
        } catch (err) {
          clearTimeout(timer);
          pendingReqs.delete(reqId);
          resolve({ ok: false, error: err?.message || '调用失败' });
        }
      });
    }

    function localizeAppLabel(app) {
      if (app.id === 'default') return '默认应用';
      if (app.id === 'explorer') {
        return app.label === 'Finder' ? '访达' : app.label === 'File Explorer' ? '文件资源管理器' : '文件管理器';
      }
      if (app.id === 'terminal' && app.label === 'Terminal') return '终端';
      return app.label;
    }

    function openMenu({ x, y, uri }) {
      closeMenu();
      const ui = ctx.getUi ? ctx.getUi() : {};
      const localPath = decodeFileUri(uri);
      const menu = document.createElement('div');
      menu.className = 'ag-cs-file-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-ag-no-i18n', '');

      let appsState = openWithAppsCache; // null = loading, [] = empty, [...] = loaded
      let openWithRowBtn = null;

      function renderSubmenuContent(sub) {
        sub.innerHTML = '';
        if (appsState === null) {
          const loading = document.createElement('div');
          loading.className = 'ag-cs-file-menu-empty';
          loading.textContent = ui.fileMenuDetectingApps || '正在探测本机应用…';
          sub.appendChild(loading);
          return;
        }
        const list = Array.isArray(appsState) ? appsState : [];
        if (!list.length) {
          const empty = document.createElement('div');
          empty.className = 'ag-cs-file-menu-empty';
          empty.textContent = ui.fileMenuNoApps || '未检测到可用应用';
          sub.appendChild(empty);
          return;
        }
        const editors = list.filter((a) => a.kind === 'editor');
        const others = list.filter((a) => a.kind !== 'editor');
        const appendApp = (app) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ag-cs-file-menu-item';
          btn.setAttribute('data-open-with-app', app.id);
          btn.innerHTML = `<span class="ag-cs-file-menu-ic">${getAppIconSvg(app.icon)}</span><span class="ag-cs-file-menu-label"></span>`;
          btn.querySelector('.ag-cs-file-menu-label').textContent = localizeAppLabel(app);
          btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            closeMenu();
            const res = await requestHostFileAction('file.openWith', { uri, appId: app.id });
            if (res && res.ok === false) {
              showToast(res.error || (ui.fileMenuOpenFailed || '打开文件失败'), true);
            }
          });
          sub.appendChild(btn);
        };
        editors.forEach(appendApp);
        if (editors.length > 0 && others.length > 0) {
          const sep = document.createElement('div');
          sep.className = 'ag-cs-file-menu-sep';
          sub.appendChild(sep);
        }
        others.forEach(appendApp);
      }

      function showSubmenu() {
        clearTimeout(subCloseTimer);
        if (!openWithRowBtn) return;
        const rect = openWithRowBtn.getBoundingClientRect?.();
        if (!subMenuEl) {
          const sub = document.createElement('div');
          sub.className = 'ag-cs-file-submenu';
          sub.setAttribute('role', 'menu');
          sub.setAttribute('data-ag-no-i18n', '');
          sub.addEventListener('mouseenter', () => clearTimeout(subCloseTimer));
          sub.addEventListener('mouseleave', () => scheduleCloseSubmenu());
          document.body?.appendChild(sub);
          subMenuEl = sub;
        }
        renderSubmenuContent(subMenuEl);
        if (rect) {
          const vw = typeof window !== 'undefined' ? window.innerWidth || 1200 : 1200;
          const vh = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
          const subW = 204;
          const estH = Math.min(340, ((appsState?.length || 4) * 32) + 20);
          const left = rect.right + 4 + subW <= vw ? rect.right + 4 : Math.max(8, rect.left - subW - 4);
          const top = Math.max(8, Math.min(rect.top - 4, vh - estH - 8));
          subMenuEl.style.left = `${left}px`;
          subMenuEl.style.top = `${top}px`;
        }
      }

      function scheduleCloseSubmenu() {
        clearTimeout(subCloseTimer);
        subCloseTimer = setTimeout(() => closeSubmenu(), 160);
      }

      // Pre-fetch open-with apps list
      if (appsState === null) {
        void requestHostFileAction('file.openWithList').then((res) => {
          const list = Array.isArray(res?.apps) ? res.apps : [];
          if (res?.ok !== false && list.length > 0) {
            openWithAppsCache = list;
          }
          appsState = list.length > 0 ? list : [{ id: 'default', label: 'Default app', kind: 'system', icon: 'default' }];
          if (subMenuEl) renderSubmenuContent(subMenuEl);
        });
      }

      const items = [
        {
          id: 'attach',
          icon: '📎',
          label: ui.fileMenuAttach || '引用到输入框',
          run: () => {
            const ok = insertRefIntoComposer(localPath);
            showToast(ok ? (ui.fileMenuAttached || '已引用到输入框') : (ui.fileMenuNoComposer || '未找到输入框'), !ok);
          },
        },
        {
          id: 'open-with',
          icon: '↗',
          label: ui.fileMenuOpenWith || '打开方式',
          hasSubmenu: true,
        },
        {
          id: 'reveal',
          icon: '📁',
          label: ui.fileMenuReveal || '打开所在文件夹',
          run: async () => {
            const res = await requestHostFileAction('file.reveal', { uri });
            if (res && res.ok === false) showToast(res.error || (ui.fileMenuHostMissing || '打开文件夹失败'), true);
          },
        },
        {
          id: 'copy-file',
          icon: '📄',
          label: ui.fileMenuCopyFile || '复制文件',
          run: async () => {
            const res = await requestHostFileAction('file.copy', { uri });
            if (res && res.ok === false) {
              showToast(res.error || (ui.fileMenuHostMissing || '复制文件失败'), true);
            } else {
              showToast(ui.fileMenuCopiedFile || '已复制文件');
            }
          },
        },
        {
          id: 'copy-path',
          icon: '🔗',
          label: ui.fileMenuCopyPath || '复制路径',
          run: async () => {
            try {
              await navigator.clipboard.writeText(localPath);
              showToast(ui.fileMenuCopiedPath || '已复制路径');
            } catch {
              showToast(ui.fileMenuCopyFailed || '复制路径失败', true);
            }
          },
        },
      ];

      for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ag-cs-file-menu-item';
        btn.setAttribute('data-file-action', item.id);
        btn.innerHTML = item.hasSubmenu
          ? `<span class="ag-cs-file-menu-ic">${item.icon}</span><span class="ag-cs-file-menu-label">${item.label}</span><span class="ag-cs-file-menu-chev">▸</span>`
          : `<span class="ag-cs-file-menu-ic">${item.icon}</span><span class="ag-cs-file-menu-label">${item.label}</span>`;
        if (item.hasSubmenu) {
          openWithRowBtn = btn;
          btn.addEventListener('mouseenter', () => showSubmenu());
          btn.addEventListener('mouseleave', () => scheduleCloseSubmenu());
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            showSubmenu();
          });
        } else {
          btn.addEventListener('mouseenter', () => closeSubmenu());
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            closeMenu();
            void item.run();
          });
        }
        menu.appendChild(btn);
      }

      document.body?.appendChild(menu);
      const vw = typeof window !== 'undefined' ? window.innerWidth || 1200 : 1200;
      const vh = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
      const left = Math.max(8, Math.min(x, vw - 208));
      const top = Math.max(8, Math.min(y, vh - 210));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menuEl = menu;
      document.addEventListener('pointerdown', onOutsidePointer, true);
      window.addEventListener('resize', onScrollOrBlur);
      window.addEventListener('blur', onScrollOrBlur);
    }

    function openMediaMenu({ x, y, img }) {
      closeMenu();
      const ui = ctx.getUi ? ctx.getUi() : {};
      const menu = document.createElement('div');
      menu.className = 'ag-cs-file-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-ag-no-i18n', '');
      menu.setAttribute('data-menu-kind', 'media');

      const items = [
        {
          id: 'media-attach',
          icon: '📎',
          label: ui.fileMenuAttach || '引用到输入框',
          run: async () => {
            try {
              const payload = await extractImagePayload(img);
              const file = typeof File === 'function' && payload.blob
                ? new File([payload.blob], payload.name, { type: payload.mimeType })
                : null;
              const ok = attachMediaFileToComposer(file);
              showToast(ok ? (ui.fileMenuAttached || '已引用到输入框') : (ui.fileMenuNoComposer || '未找到输入框'), !ok);
            } catch (err) {
              showToast(err?.message || '引用图片失败', true);
            }
          },
        },
        {
          id: 'media-copy',
          icon: '📋',
          label: ui.mediaMenuCopy || '复制图片',
          run: async () => {
            try {
              const payload = await extractImagePayload(img);
              const pngBlob = await ensurePngBlob(payload, img);
              if (typeof navigator?.clipboard?.write !== 'function' || typeof ClipboardItem !== 'function') {
                throw new Error('当前环境不支持写入剪贴板图片');
              }
              await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
              showToast(ui.mediaMenuCopied || '已复制图片');
            } catch (err) {
              showToast(err?.message || '复制图片失败', true);
            }
          },
        },
        {
          id: 'media-save',
          icon: '💾',
          label: ui.mediaMenuSave || '保存图片',
          run: async () => {
            try {
              const payload = await extractImagePayload(img);
              const url = payload.blob && typeof URL?.createObjectURL === 'function'
                ? URL.createObjectURL(payload.blob)
                : '';
              if (!url) throw new Error('无法生成下载链接');
              const link = document.createElement('a');
              link.href = url;
              link.download = payload.name;
              link.style.display = 'none';
              document.body.appendChild(link);
              link.click();
              link.remove();
              setTimeout(() => {
                try {
                  URL.revokeObjectURL(url);
                } catch {}
              }, 1500);
              showToast(`${ui.mediaMenuSaved || '已保存图片'}: ${payload.name}`);
            } catch (err) {
              showToast(err?.message || '保存图片失败', true);
            }
          },
        },
      ];

      for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ag-cs-file-menu-item';
        btn.setAttribute('data-file-action', item.id);
        btn.innerHTML = `<span class="ag-cs-file-menu-ic">${item.icon}</span><span class="ag-cs-file-menu-label">${item.label}</span>`;
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closeMenu();
          void item.run();
        });
        menu.appendChild(btn);
      }

      document.body?.appendChild(menu);
      const vw = typeof window !== 'undefined' ? window.innerWidth || 1200 : 1200;
      const vh = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
      const left = Math.max(8, Math.min(x, vw - 208));
      const top = Math.max(8, Math.min(y, vh - 140));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menuEl = menu;
      document.addEventListener('pointerdown', onOutsidePointer, true);
      window.addEventListener('resize', onScrollOrBlur);
      window.addEventListener('blur', onScrollOrBlur);
    }

    function attachOpenWithSubmenu(openWithBtn, uri) {
      const ui = ctx.getUi ? ctx.getUi() : {};
      let appsState = openWithAppsCache;

      function renderSubmenuContent(sub) {
        sub.innerHTML = '';
        if (appsState === null) {
          const loading = document.createElement('div');
          loading.className = 'ag-cs-file-menu-empty';
          loading.textContent = ui.fileMenuDetectingApps || '正在探测本机应用…';
          sub.appendChild(loading);
          return;
        }
        const list = Array.isArray(appsState) ? appsState : [];
        if (!list.length) {
          const empty = document.createElement('div');
          empty.className = 'ag-cs-file-menu-empty';
          empty.textContent = ui.fileMenuNoApps || '未检测到可用应用';
          sub.appendChild(empty);
          return;
        }
        const editors = list.filter((a) => a.kind === 'editor');
        const others = list.filter((a) => a.kind !== 'editor');
        const appendApp = (app) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ag-cs-file-menu-item';
          btn.setAttribute('data-open-with-app', app.id);
          btn.innerHTML = `<span class="ag-cs-file-menu-ic">${getAppIconSvg(app.icon)}</span><span class="ag-cs-file-menu-label"></span>`;
          btn.querySelector('.ag-cs-file-menu-label').textContent = localizeAppLabel(app);
          btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            closeMenu();
            const res = await requestHostFileAction('file.openWith', { uri, appId: app.id });
            if (res && res.ok === false) {
              showToast(res.error || (ui.fileMenuOpenFailed || '打开文件失败'), true);
            }
          });
          sub.appendChild(btn);
        };
        editors.forEach(appendApp);
        if (editors.length > 0 && others.length > 0) {
          const sep = document.createElement('div');
          sep.className = 'ag-cs-file-menu-sep';
          sub.appendChild(sep);
        }
        others.forEach(appendApp);
      }

      function showSubmenu() {
        clearTimeout(subCloseTimer);
        const rect = openWithBtn.getBoundingClientRect?.();
        if (!subMenuEl) {
          const sub = document.createElement('div');
          sub.className = 'ag-cs-file-submenu';
          sub.setAttribute('role', 'menu');
          sub.setAttribute('data-ag-no-i18n', '');
          sub.addEventListener('mouseenter', () => clearTimeout(subCloseTimer));
          sub.addEventListener('mouseleave', () => scheduleCloseSubmenu());
          document.body?.appendChild(sub);
          subMenuEl = sub;
        }
        renderSubmenuContent(subMenuEl);
        if (rect) {
          const vw = typeof window !== 'undefined' ? window.innerWidth || 1200 : 1200;
          const vh = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
          const subW = 204;
          const estH = Math.min(340, ((appsState?.length || 4) * 32) + 20);
          const left = rect.right + 4 + subW <= vw ? rect.right + 4 : Math.max(8, rect.left - subW - 4);
          const top = Math.max(8, Math.min(rect.top - 4, vh - estH - 8));
          subMenuEl.style.left = `${left}px`;
          subMenuEl.style.top = `${top}px`;
        }
      }

      function scheduleCloseSubmenu() {
        clearTimeout(subCloseTimer);
        subCloseTimer = setTimeout(() => closeSubmenu(), 160);
      }

      if (appsState === null) {
        void requestHostFileAction('file.openWithList').then((res) => {
          const list = Array.isArray(res?.apps) ? res.apps : [];
          if (res?.ok !== false && list.length > 0) {
            openWithAppsCache = list;
          }
          appsState = list.length > 0 ? list : [{ id: 'default', label: 'Default app', kind: 'system', icon: 'default' }];
          if (subMenuEl) renderSubmenuContent(subMenuEl);
        });
      }

      openWithBtn.addEventListener('mouseenter', () => showSubmenu());
      openWithBtn.addEventListener('mouseleave', () => scheduleCloseSubmenu());
      openWithBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        showSubmenu();
      });
    }

    function openCustomizationMenu({ x, y, info }) {
      closeMenu();
      const ui = ctx.getUi ? ctx.getUi() : {};
      const menu = document.createElement('div');
      menu.className = 'ag-cs-file-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-ag-no-i18n', '');
      menu.setAttribute('data-menu-kind', 'customization');

      const items = [];

      if (info.onToggle && typeof info.pluginDisabled === 'boolean') {
        const willEnable = Boolean(info.pluginDisabled);
        items.push({
          id: 'plugin-toggle',
          icon: willEnable ? '🟢' : '⏸️',
          label: willEnable ? (ui.pluginMenuEnable || '启用') : (ui.pluginMenuDisable || '禁用'),
          disabled: Boolean(info.disabled),
          run: () => {
            info.onToggle(willEnable);
          },
        });
      }

      if (info.detailTrigger) {
        items.push({
          id: 'plugin-detail',
          icon: '⚙️',
          label: ui.pluginMenuDetail || '查看详情 / 设置',
          run: () => {
            info.detailTrigger.click?.();
          },
        });
      }

      if (info.uri) {
        if (items.length > 0) items.push({ separator: true });
        items.push({
          id: 'open-with',
          icon: '↗',
          label: ui.fileMenuOpenWith || '打开方式',
          hasSubmenu: true,
        });
        items.push({
          id: 'reveal',
          icon: '📁',
          label: ui.fileMenuReveal || '打开所在文件夹',
          run: async () => {
            const res = await requestHostFileAction('file.reveal', { uri: info.uri });
            if (res && res.ok === false) showToast(res.error || (ui.fileMenuHostMissing || '打开文件夹失败'), true);
          },
        });
        items.push({
          id: 'copy-path',
          icon: '🔗',
          label: ui.fileMenuCopyPath || '复制路径',
          run: async () => {
            try {
              await navigator.clipboard.writeText(info.localPath);
              showToast(ui.fileMenuCopiedPath || '已复制路径');
            } catch {
              showToast(ui.fileMenuCopyFailed || '复制路径失败', true);
            }
          },
        });
      }

      if (info.canUninstall && info.onUninstall) {
        if (items.length > 0) items.push({ separator: true });
        items.push({
          id: 'plugin-uninstall',
          icon: '🗑️',
          label: ui.pluginMenuRemove || '移除插件',
          danger: true,
          disabled: Boolean(info.disabled),
          run: () => {
            info.onUninstall();
          },
        });
      }

      for (const item of items) {
        if (item.separator) {
          const sep = document.createElement('div');
          sep.className = 'ag-cs-file-menu-sep';
          menu.appendChild(sep);
          continue;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ag-cs-file-menu-item' + (item.danger ? ' is-danger' : '');
        btn.setAttribute('data-file-action', item.id);
        if (item.disabled) btn.disabled = true;
        btn.innerHTML = item.hasSubmenu
          ? `<span class="ag-cs-file-menu-ic">${item.icon}</span><span class="ag-cs-file-menu-label">${item.label}</span><span class="ag-cs-file-menu-chev">▸</span>`
          : `<span class="ag-cs-file-menu-ic">${item.icon}</span><span class="ag-cs-file-menu-label">${item.label}</span>`;
        if (item.hasSubmenu) {
          attachOpenWithSubmenu(btn, info.uri);
        } else {
          btn.addEventListener('mouseenter', () => closeSubmenu());
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (item.disabled) return;
            closeMenu();
            void item.run();
          });
        }
        menu.appendChild(btn);
      }

      document.body?.appendChild(menu);
      const vw = typeof window !== 'undefined' ? window.innerWidth || 1200 : 1200;
      const vh = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
      const estH = Math.min(300, items.length * 34 + 16);
      const left = Math.max(8, Math.min(x, vw - 208));
      const top = Math.max(8, Math.min(y, vh - estH));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menuEl = menu;
      document.addEventListener('pointerdown', onOutsidePointer, true);
      window.addEventListener('resize', onScrollOrBlur);
      window.addEventListener('blur', onScrollOrBlur);
    }

    const onContextMenu = (ev) => {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      if (cfg.fileContextMenu === false) return;
      const hit = extractFileUriFromTarget(ev.target);
      if (hit && hit.uri) {
        ev.preventDefault();
        ev.stopPropagation();
        openMenu({ x: ev.clientX || 0, y: ev.clientY || 0, uri: hit.uri });
        return;
      }
      const customInfo = extractCustomizationCardFromTarget(ev.target);
      if (customInfo) {
        ev.preventDefault();
        ev.stopPropagation();
        openCustomizationMenu({ x: ev.clientX || 0, y: ev.clientY || 0, info: customInfo });
        return;
      }
      const img = findChatMediaImage(ev.target);
      if (img) {
        ev.preventDefault();
        ev.stopPropagation();
        openMediaMenu({ x: ev.clientX || 0, y: ev.clientY || 0, img });
      }
    };

    document.addEventListener('contextmenu', onContextMenu, true);

    return {
      ownSelector: '.ag-cs-file-menu, .ag-cs-file-submenu',
      sync() {},
      onEscape() {
        closeMenu();
      },
      destroy() {
        closeMenu();
        document.removeEventListener('contextmenu', onContextMenu, true);
        for (const entry of pendingReqs.values()) clearTimeout(entry.timer);
        pendingReqs.clear();
      },
    };
  }

  return {
    create,
    decodeFileUri,
    toFileUri,
    extractFileUriFromTarget,
    extractCustomizationCardFromTarget,
    findChatMediaImage,
  };
});
