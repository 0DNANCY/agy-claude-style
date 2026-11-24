// File Context Menu feature for AGY Claude Style (chat file links & file tree).
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

    const onOutsidePointer = (ev) => {
      if (menuEl && !menuEl.contains(ev.target)) closeMenu();
    };
    const onScrollOrBlur = () => closeMenu();

    function closeMenu() {
      if (menuEl) {
        menuEl.remove();
        menuEl = null;
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        window.removeEventListener('resize', onScrollOrBlur);
        window.removeEventListener('blur', onScrollOrBlur);
      }
    }

    function sendHostFileAction(type, uri) {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      const bindingName = cfg.binding || '__agClaudeStyleSetting';
      const fn = typeof window !== 'undefined' ? window[bindingName] : null;
      if (typeof fn === 'function') {
        fn(JSON.stringify({ key: '__fileAction', value: { type, uri } }));
        return true;
      }
      return false;
    }

    function openMenu({ x, y, uri }) {
      closeMenu();
      const ui = ctx.getUi ? ctx.getUi() : {};
      const localPath = decodeFileUri(uri);
      const menu = document.createElement('div');
      menu.className = 'ag-cs-file-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-ag-no-i18n', '');

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
          id: 'open',
          icon: '↗',
          label: ui.fileMenuOpen || '用默认应用打开',
          run: () => {
            const ok = sendHostFileAction('file.open', uri);
            if (!ok) showToast(ui.fileMenuHostMissing || '宿主桥接未就绪', true);
          },
        },
        {
          id: 'reveal',
          icon: '📁',
          label: ui.fileMenuReveal || '打开所在文件夹',
          run: () => {
            const ok = sendHostFileAction('file.reveal', uri);
            if (!ok) showToast(ui.fileMenuHostMissing || '宿主桥接未就绪', true);
          },
        },
        {
          id: 'copy-file',
          icon: '📄',
          label: ui.fileMenuCopyFile || '复制文件',
          run: () => {
            const ok = sendHostFileAction('file.copy', uri);
            showToast(ok ? (ui.fileMenuCopiedFile || '已复制文件') : (ui.fileMenuHostMissing || '宿主桥接未就绪'), !ok);
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
        btn.innerHTML = `<span class="ag-cs-file-menu-ic">${item.icon}</span><span>${item.label}</span>`;
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
      const top = Math.max(8, Math.min(y, vh - 210));
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
      if (!hit || !hit.uri) return;
      ev.preventDefault();
      ev.stopPropagation();
      openMenu({ x: ev.clientX || 0, y: ev.clientY || 0, uri: hit.uri });
    };

    document.addEventListener('contextmenu', onContextMenu, true);

    return {
      ownSelector: '.ag-cs-file-menu',
      sync() {},
      onEscape() {
        closeMenu();
      },
      destroy() {
        closeMenu();
        document.removeEventListener('contextmenu', onContextMenu, true);
      },
    };
  }

  return {
    create,
    decodeFileUri,
    toFileUri,
    extractFileUriFromTarget,
  };
});
