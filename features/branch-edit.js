// Native Session Branching ("分支会话") and In-Place Message Editing feature for AGY Claude Style.
// Registers on globalThis.__agCsFeatures.branchEdit.
(function (root, factory) {
  const feature = factory();
  if (typeof module === 'object' && module.exports) module.exports = feature;
  else {
    root.__agCsFeatures = root.__agCsFeatures || {};
    root.__agCsFeatures.branchEdit = feature;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const COMPOSER_EDITOR_SEL = '[data-testid="agent-input-box"] [contenteditable="true"]';
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'PRE', 'BLOCKQUOTE', 'SECTION', 'ARTICLE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR',
  ]);

  function preserveText(s) {
    return String(s || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r\n?/g, '\n')
      .trim();
  }

  function stripRelTimeSuffix(s) {
    return String(s || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(?:\d+\s*(?:秒|分钟|小时|天|周|个月|年)前|刚刚|刚才|\d+\s*(?:s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|wk|wks|mo|y)\s*ago|just\s*now)\s*$/i, '')
      .trim();
  }

  function extractDomPromptText(stepEl) {
    if (!stepEl) return '';
    const parts = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        parts.push(node.nodeValue || '');
        return;
      }
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'BUTTON' || (node.classList && (node.classList.contains('ag-cs-inline-edit') || node.classList.contains('ag-cs-edit-btn') || node.classList.contains('ag-cs-branch-btn')))) {
        return;
      }
      if (tag === 'BR') {
        parts.push('\n');
        return;
      }
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock && parts.length > 0 && !String(parts[parts.length - 1]).endsWith('\n')) {
        parts.push('\n');
      }
      const kids = node.childNodes && node.childNodes.length ? node.childNodes : node.children;
      if (kids && kids.length) {
        for (const c of kids) walk(c);
      } else {
        parts.push(node.textContent || '');
      }
      if (isBlock && parts.length > 0 && !String(parts[parts.length - 1]).endsWith('\n')) {
        parts.push('\n');
      }
    };
    walk(stepEl);
    return preserveText(parts.join(''));
  }

  function extractUserStepText(stepItem) {
    const v = stepItem?.step?.value;
    if (!v) return '';
    const items = Array.isArray(v.items) ? v.items : [];
    const joined = items.map((it) => it?.chunk?.value || it?.value || '').join('');
    return preserveText(joined || v.query || v.userResponse || '');
  }

  function matchTurnIndex(trajTurns, domNodes, targetEl) {
    if (!Array.isArray(trajTurns) || !trajTurns.length || !targetEl) return null;
    const domIdx = domNodes.indexOf(targetEl);
    const fromEnd = domIdx >= 0 ? domNodes.length - 1 - domIdx : -1;
    const cleanDom = stripRelTimeSuffix(extractDomPromptText(targetEl));
    const exactMatches = (t) => {
      const cleanFt = stripRelTimeSuffix(t.text);
      return Boolean(cleanDom && cleanFt && cleanFt === cleanDom);
    };
    const prefixMatches = (t) => {
      const cleanFt = stripRelTimeSuffix(t.text);
      if (!cleanDom || !cleanFt || Math.min(cleanDom.length, cleanFt.length) < 16) return false;
      const needleLen = Math.min(24, cleanDom.length, cleanFt.length);
      return cleanFt.startsWith(cleanDom.slice(0, needleLen)) || cleanDom.startsWith(cleanFt.slice(0, needleLen));
    };
    for (const matcher of [exactMatches, prefixMatches]) {
      if (fromEnd >= 0) {
        const expected = trajTurns.length - 1 - fromEnd;
        if (expected >= 0 && expected < trajTurns.length && matcher(trajTurns[expected])) {
          return trajTurns[expected];
        }
        for (let off = 1; off < trajTurns.length; off++) {
          for (const cand of [expected - off, expected + off]) {
            if (cand >= 0 && cand < trajTurns.length && matcher(trajTurns[cand])) {
              return trajTurns[cand];
            }
          }
        }
      }
      for (let i = trajTurns.length - 1; i >= 0; i--) {
        if (matcher(trajTurns[i])) return trajTurns[i];
      }
    }
    return null;
  }

  function getFiber(el) {
    if (!el || typeof el !== 'object') return null;
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    return k ? el[k] : null;
  }

  function collectProviders(startEl) {
    const out = [];
    const seen = new Set();
    const walk = (el) => {
      let node = getFiber(el);
      let steps = 0;
      while (node && steps < 350) {
        steps++;
        const v = node.memoizedProps?.value;
        if (v && typeof v === 'object' && !seen.has(v)) {
          seen.add(v);
          out.push(v);
        }
        node = node.return;
      }
    };
    if (startEl) walk(startEl);
    const fallbacks = [
      document.querySelector('[data-testid="agent-input-box"]'),
      document.querySelector('[data-testid="conversation-view"]'),
      document.querySelector('#root')?.firstElementChild,
    ];
    for (const fb of fallbacks) {
      if (fb) walk(fb);
    }
    return out;
  }

  function findHostApis(anchorEl) {
    const vals = collectProviders(anchorEl);
    let svc = null;
    let stepHandler = null;
    let router = null;
    let cascadeId = '';
    for (const v of vals) {
      if (!svc && (typeof v.forkConversation === 'function' || typeof v.getCascadeTrajectory === 'function' || typeof v.revertToCascadeStep === 'function')) {
        svc = v;
      }
      if (!stepHandler && typeof v.revertToIndex === 'function') {
        stepHandler = v;
      }
      if (!router && typeof v.navigate === 'function' && v.routesByPath) {
        router = v;
      }
      if (!cascadeId) {
        const cid = v.cascadeId || v.conversationId || v.cascadeContext?.state?.conversationId || v.cascadeContext?.state?.agentStateProvider?.getState?.()?.conversationId;
        if (typeof cid === 'string' && cid.length > 6) cascadeId = cid;
      }
    }
    if (!router || !stepHandler || !svc) {
      // Fallback: search downward from #root for TanStack Router / host providers
      const rootEl = document.getElementById('root') || document.body?.firstElementChild;
      const rootKey = rootEl && Object.keys(rootEl).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
      if (rootKey && rootEl[rootKey]) {
        const seen = new Set();
        const stack = [rootEl[rootKey]];
        let n = 0;
        while (stack.length && n < 5000 && (!router || !stepHandler || !svc)) {
          n++;
          const f = stack.pop();
          if (!f || seen.has(f)) continue;
          seen.add(f);
          const v = f.memoizedProps?.value;
          if (v && typeof v === 'object') {
            if (!svc && (typeof v.forkConversation === 'function' || typeof v.getCascadeTrajectory === 'function' || typeof v.revertToCascadeStep === 'function')) {
              svc = v;
            }
            if (!stepHandler && typeof v.revertToIndex === 'function') {
              stepHandler = v;
            }
            if (!router && typeof v.navigate === 'function' && v.routesByPath) {
              router = v;
            }
          }
          if (f.child) stack.push(f.child);
          if (f.sibling) stack.push(f.sibling);
        }
      }
    }
    if (!router && typeof window !== 'undefined' && window.__TSR_ROUTER__ && typeof window.__TSR_ROUTER__.navigate === 'function') {
      router = window.__TSR_ROUTER__;
    }
    if (!cascadeId && typeof location !== 'undefined') {
      const m = String(location.pathname || location.href || '').match(/\/c\/([a-zA-Z0-9_-]{8,})/);
      if (m) cascadeId = m[1];
    }
    return { svc, stepHandler, router, cascadeId };
  }

  function extractStepIndexFromFiber(respEl) {
    let node = getFiber(respEl);
    let sliceSteps = null;
    for (let i = 0; node && i < 60; i++, node = node.return) {
      const mp = node.memoizedProps;
      if (!mp || typeof mp !== 'object') continue;
      if (mp.step && typeof mp.step === 'object') {
        const idx = mp.step?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
        if (Number.isInteger(idx) && idx >= 0) return idx;
      }
      if (Number.isInteger(mp.stepIndex) && mp.stepIndex >= 0) return mp.stepIndex;
      if (!sliceSteps && Array.isArray(mp.trajectorySteps) && mp.trajectorySteps.length) {
        sliceSteps = mp.trajectorySteps;
      } else if (!sliceSteps && Array.isArray(mp.steps) && mp.steps.length) {
        sliceSteps = mp.steps;
      }
    }
    if (!sliceSteps) return -1;

    // Map this specific [data-testid="agent-response"] to its own plannerResponse step in sliceSteps
    const responseSteps = [];
    for (let i = 0; i < sliceSteps.length; i++) {
      const st = sliceSteps[i];
      const c = String(st?.step?.case || st?.type || '').toLowerCase();
      if (c.includes('plannerresponse') || c.includes('planner_response') || c.includes('assistant')) {
        const respText = String(st?.step?.value?.response || st?.step?.value?.modifiedResponse || '').trim();
        if (respText) {
          const realIdx = st?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
          responseSteps.push({
            stepIndex: Number.isInteger(realIdx) && realIdx >= 0 ? realIdx : i,
            cleanText: respText.replace(/\s+/g, ' ').slice(0, 60),
          });
        }
      }
    }
    if (!responseSteps.length) {
      const last = sliceSteps[sliceSteps.length - 1]?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
      return Number.isInteger(last) && last >= 0 ? last : -1;
    }

    const domClean = preserveText(extractDomPromptText(respEl)).replace(/\s+/g, ' ').slice(0, 40);
    const allResp = Array.from(document.querySelectorAll('[data-testid="agent-response"]')).filter(
      (el) => !el.closest('[data-testid="subagent-tab-conversation"]')
    );
    const domIdx = allResp.indexOf(respEl);
    if (domIdx >= 0) {
      const fromEnd = allResp.length - 1 - domIdx;
      const expected = responseSteps[responseSteps.length - 1 - fromEnd];
      if (expected) {
        if (!domClean || expected.cleanText.includes(domClean.slice(0, 20)) || domClean.includes(expected.cleanText.slice(0, 20))) {
          return expected.stepIndex;
        }
      }
    }
    if (domClean.length >= 8) {
      const needle = domClean.slice(0, 24);
      for (let i = responseSteps.length - 1; i >= 0; i--) {
        if (responseSteps[i].cleanText.includes(needle) || domClean.includes(responseSteps[i].cleanText.slice(0, 24))) {
          return responseSteps[i].stepIndex;
        }
      }
    }
    if (domIdx >= 0) {
      const fromEnd = allResp.length - 1 - domIdx;
      const fallback = responseSteps[responseSteps.length - 1 - fromEnd];
      if (fallback) return fallback.stepIndex;
    }
    return responseSteps[responseSteps.length - 1].stepIndex;
  }

  function buildForkPayload(cascadeId, stepIndex, targetForkWorkspace = 1) {
    const payload = {
      sourceCascadeId: String(cascadeId || '').trim(),
      targetForkWorkspace,
    };
    if (Number.isInteger(stepIndex) && stepIndex >= 0) {
      payload.forkAtStepIndex = stepIndex;
    }
    return payload;
  }

  function isSubagentForkUnsupportedError(err) {
    const msg = String(err?.rawMessage || err?.message || err || '').toLowerCase();
    return msg.includes('subagent') && (msg.includes('not supported') || msg.includes('fork'));
  }

  function findMainComposerBox() {
    const boxes = Array.from(document.querySelectorAll('[data-testid="agent-input-box"]'));
    return boxes.find((b) => !b.closest('[data-testid="subagent-tab-conversation"]')) || boxes[0] || null;
  }

  function findMainComposerEditor() {
    const box = findMainComposerBox();
    const scoped = box ? box.querySelector(COMPOSER_EDITOR_SEL) : null;
    if (scoped) return scoped;
    const eds = Array.from(document.querySelectorAll(COMPOSER_EDITOR_SEL));
    return eds.find((ed) => !ed.closest('[data-testid="subagent-tab-conversation"]')) || eds[0] || null;
  }

  function isLexicalEditor(ed) {
    if (!ed) return false;
    if (ed.getAttribute?.('data-lexical-editor') === 'true') return true;
    try {
      return Object.keys(ed).some((k) => k.startsWith('__lexical'));
    } catch {
      return false;
    }
  }

  function insertTextIntoComposer(text) {
    const editor = findMainComposerEditor();
    if (!editor) return false;
    const str = String(text || '');
    const lexical = isLexicalEditor(editor);
    try {
      editor.focus?.();
      let inserted = false;
      if (typeof document.execCommand === 'function') {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        inserted = Boolean(document.execCommand('insertText', false, str));
      }
      if (!inserted || (!lexical && preserveText(editor.textContent) !== str)) {
        editor.textContent = str;
        if (typeof InputEvent === 'function') {
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: str, inputType: 'insertText' }));
        } else {
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      return true;
    } catch {
      try {
        editor.textContent = str;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      } catch {
        return false;
      }
    }
  }

  function triggerComposerSend() {
    const box = findMainComposerBox();
    if (!box) return false;
    const btn =
      box.querySelector('[data-testid="send-button"]') ||
      box.querySelector('button[type="submit"]') ||
      Array.from(box.querySelectorAll('button')).find((b) => /send|submit|发送|傳送|送信/i.test(String(b.getAttribute('aria-label') || '')));
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }
    const editor = box.querySelector('[contenteditable="true"]');
    if (editor) {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      return true;
    }
    return false;
  }

  function copyTextFallback(text) {
    const str = String(text || '');
    if (!str) return Promise.resolve(false);
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard
        .writeText(str)
        .then(() => true)
        .catch(() => execCopy(str));
    }
    return Promise.resolve(execCopy(str));
  }

  function execCopy(str) {
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return Boolean(ok);
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
    clearTimeout(toast._t);
    toast.innerHTML = '';
    toast.classList.toggle('is-err', Boolean(isErr));

    const textSpan = document.createElement('span');
    textSpan.className = 'ag-cs-toast-msg';
    textSpan.textContent = String(msg || '');
    toast.appendChild(textSpan);

    if (isErr) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'ag-cs-toast-btn';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copyTextFallback(String(msg || '')).then((ok) => {
          copyBtn.textContent = ok ? '已复制 ✓' : '复制失败';
          setTimeout(() => {
            if (copyBtn.isConnected) copyBtn.textContent = '复制';
          }, 1400);
        });
      });

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ag-cs-toast-btn ag-cs-toast-close';
      closeBtn.setAttribute('aria-label', '关闭');
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        clearTimeout(toast._t);
        toast.classList.remove('is-show');
      });

      toast.appendChild(copyBtn);
      toast.appendChild(closeBtn);
    }

    const hideMs = isErr ? 8500 : 2400;
    const scheduleHide = () => {
      clearTimeout(toast._t);
      toast._t = setTimeout(() => {
        toast.classList.remove('is-show');
      }, hideMs);
    };
    toast.onmouseenter = isErr ? () => clearTimeout(toast._t) : null;
    toast.onmouseleave = isErr ? scheduleHide : null;

    toast.classList.add('is-show');
    scheduleHide();
  }

  function create(ctx) {
    let activeEditorEl = null;

    function closeActiveEditor() {
      if (activeEditorEl) {
        activeEditorEl.remove();
        activeEditorEl = null;
      }
    }

    async function forkFromResponse(respEl) {
      const ui = ctx.getUi ? ctx.getUi() : {};
      const { svc, router, cascadeId } = findHostApis(respEl);
      if (!svc || typeof svc.forkConversation !== 'function' || !cascadeId) {
        showToast(ui.branchUnavailable || '当前客户端未暴露原生分支会话接口', true);
        return false;
      }
      let stepIndex = extractStepIndexFromFiber(respEl);
      if (stepIndex < 0) {
        try {
          if (typeof svc.getCascadeTrajectory === 'function') {
            const trajRes = await svc.getCascadeTrajectory({ cascadeId });
            if (ctx.isDestroyed?.()) return false;
            const steps = trajRes?.trajectory?.steps || trajRes?.response?.trajectory?.steps || trajRes?.steps || [];
            const allResp = Array.from(document.querySelectorAll('[data-testid="agent-response"]')).filter(
              (el) => !el.closest('[data-testid="subagent-tab-conversation"]')
            );
            const domIdx = allResp.indexOf(respEl);
            const responseStepIndices = [];
            for (let i = 0; i < steps.length; i++) {
              const c = String(steps[i]?.step?.case || steps[i]?.type || '').toLowerCase();
              if (c.includes('plannerresponse') || c.includes('planner_response') || c.includes('assistant')) {
                const respText = steps[i]?.step?.value?.response || steps[i]?.step?.value?.modifiedResponse || '';
                if (String(respText).trim()) {
                  const realIdx = steps[i]?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
                  responseStepIndices.push(Number.isInteger(realIdx) && realIdx >= 0 ? realIdx : i);
                }
              }
            }
            if (domIdx >= 0 && responseStepIndices.length > 0) {
              const fromEnd = allResp.length - 1 - domIdx;
              const mapped = responseStepIndices[responseStepIndices.length - 1 - fromEnd];
              if (Number.isInteger(mapped)) stepIndex = mapped;
            }
          }
        } catch {}
      }
      if (ctx.isDestroyed?.()) return false;

      try {
        const payload = buildForkPayload(cascadeId, stepIndex, 1);
        const res = await svc.forkConversation(payload);
        if (ctx.isDestroyed?.()) return false;
        const newId = res?.newCascadeId || res?.cascadeId || res?.conversationId || (typeof res === 'string' ? res : '');
        if (newId) {
          showToast(ui.branchCreated || '已创建会话分支');
          const nextSearch = (prev) => ({
            ...(prev && typeof prev === 'object' ? prev : {}),
            ...(res?.newProjectId ? { project: res.newProjectId } : {}),
          });
          if (router && typeof router.navigate === 'function') {
            try {
              await router.navigate({
                to: '/c/$cascadeId',
                params: { cascadeId: newId },
                search: nextSearch,
              });
              return true;
            } catch {
              try {
                await router.navigate({ to: `/c/${encodeURIComponent(newId)}` });
                return true;
              } catch {}
            }
          }
          try {
            const nextUrl = `/c/${encodeURIComponent(newId)}${window.location.search || ''}`;
            window.history.pushState({}, '', nextUrl);
            window.dispatchEvent(new PopStateEvent('popstate'));
          } catch {}
          return true;
        }
        showToast(ui.branchCreated || '已发起分支会话');
        return true;
      } catch (err) {
        if (isSubagentForkUnsupportedError(err)) {
          const lang = String(ctx.getCfg?.().language || 'zh-CN');
          const isZh = lang.startsWith('zh') || lang === 'yue';
          showToast(
            isZh
              ? '无法创建分支：该会话曾调用过子智能体 / Swarm，Antigravity 后端暂不支持分支此类对话'
              : 'Cannot fork: Antigravity backend does not support forking conversations that invoked subagents',
            true
          );
          return false;
        }
        const detail = err?.rawMessage || err?.message || String(err);
        showToast(`${ui.branchFailed || '分支会话失败'}: ${detail}`, true);
        return false;
      }
    }

    function openInlineEditor(stepEl) {
      closeActiveEditor();
      const ui = ctx.getUi ? ctx.getUi() : {};
      const originalText = extractDomPromptText(stepEl);
      const wrap = document.createElement('div');
      wrap.className = 'ag-cs-inline-edit';
      wrap.setAttribute('data-ag-no-i18n', '');

      const ta = document.createElement('textarea');
      ta.className = 'ag-cs-inline-edit-ta';
      ta.value = originalText;
      ta.rows = Math.min(10, Math.max(2, originalText.split('\n').length + 1));

      const bar = document.createElement('div');
      bar.className = 'ag-cs-inline-edit-bar';

      const hint = document.createElement('span');
      hint.className = 'ag-cs-inline-edit-hint';
      hint.textContent = ui.editHint || '⌘/Ctrl+Enter 重发 · Esc 取消';

      const btnRow = document.createElement('div');
      btnRow.className = 'ag-cs-inline-edit-btns';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'ag-cs-inline-edit-btn';
      cancelBtn.textContent = ui.rewindOptCancel || '取消';
      cancelBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeActiveEditor();
      });

      const sendBtn = document.createElement('button');
      sendBtn.type = 'button';
      sendBtn.className = 'ag-cs-inline-edit-btn is-primary';
      sendBtn.textContent = ui.editResend || '保存并重发';

      const submitEdit = async () => {
        const nextText = preserveText(ta.value);
        if (!nextText) return;
        sendBtn.disabled = true;
        try {
          const { svc, stepHandler, cascadeId } = findHostApis(stepEl);
          let reverted = false;
          if (svc && cascadeId && typeof svc.getCascadeTrajectory === 'function' && (typeof stepHandler?.revertToIndex === 'function' || typeof svc.revertToCascadeStep === 'function')) {
            const trajRes = await svc.getCascadeTrajectory({ cascadeId });
            if (ctx.isDestroyed?.()) return;
            const steps = trajRes?.trajectory?.steps || trajRes?.response?.trajectory?.steps || trajRes?.steps || [];
            const trajTurns = [];
            for (let i = 0; i < steps.length; i++) {
              const c = String(steps[i]?.step?.case || steps[i]?.type || '').toLowerCase();
              if (c === 'userinput' || c === 'user_input') {
                const realIdx = steps[i]?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
                trajTurns.push({ stepIndex: Number.isInteger(realIdx) && realIdx >= 0 ? realIdx : i, text: extractUserStepText(steps[i]) });
              }
            }
            const domNodes = Array.from(document.querySelectorAll('[data-testid="user-input-step"]')).filter(
              (el) => !el.closest('[data-testid="subagent-tab-conversation"]')
            );
            const matched = matchTurnIndex(trajTurns, domNodes, stepEl);
            if (matched && Number.isInteger(matched.stepIndex)) {
              const revertIdx = Math.max(0, matched.stepIndex - 1);
              if (stepHandler && typeof stepHandler.revertToIndex === 'function') {
                await stepHandler.revertToIndex(cascadeId, revertIdx, { conversationOnly: true });
                reverted = true;
              } else if (typeof svc.revertToCascadeStep === 'function') {
                if (svc.revertToCascadeStep.length === 1) {
                  await svc.revertToCascadeStep({ cascadeId, stepIndex: revertIdx, keepCodeChanges: true });
                } else {
                  await svc.revertToCascadeStep(cascadeId, revertIdx, undefined, true);
                }
                reverted = true;
              }
              if (ctx.isDestroyed?.()) return;
              if (reverted && typeof ctx.scheduleSync === 'function') ctx.scheduleSync();
            }
          }
          closeActiveEditor();
          await new Promise((r) => setTimeout(r, reverted ? 120 : 30));
          if (ctx.isDestroyed?.()) return;
          insertTextIntoComposer(nextText);
          await new Promise((r) => setTimeout(r, 40));
          if (ctx.isDestroyed?.()) return;
          triggerComposerSend();
          showToast(reverted ? (ui.editSent || '已原位修改并重发') : (ui.editFilled || '已填入输入框并发送'));
        } catch (err) {
          sendBtn.disabled = false;
          showToast(`${ui.editFailed || '消息编辑失败'}: ${err?.message || err}`, true);
        }
      };

      sendBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void submitEdit();
      });
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          closeActiveEditor();
        } else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          ev.stopPropagation();
          void submitEdit();
        }
      });

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(sendBtn);
      bar.appendChild(hint);
      bar.appendChild(btnRow);
      wrap.appendChild(ta);
      wrap.appendChild(bar);
      stepEl.appendChild(wrap);
      activeEditorEl = wrap;
      ta.focus?.();
    }

    const FORK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M6 8.5v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-2"/><path d="M12 13.5v2"/></svg>';
    const EDIT_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>';

    function findResponseActionBar(respEl) {
      let cur = respEl;
      for (let depth = 0; depth < 4 && cur; depth++) {
        if (depth > 0) {
          if (cur.matches?.('[data-testid="conversation-view"],[data-testid="subagent-tab-conversation"]')) break;
          const respCount = cur.querySelectorAll?.('[data-testid="agent-response"]')?.length || 0;
          if (respCount > 1) break;
        }
        const bars = cur.querySelectorAll('div.flex.shrink-0.items-center');
        for (const bar of bars) {
          if (bar.closest('[data-testid="user-input-step"],header,[role="toolbar"],[data-testid="subagent-tab-conversation"]')) continue;
          const nativeIconBtns = Array.from(bar.children).filter(
            (c) => c.tagName === 'BUTTON' && c.classList.contains('agy-button-icon') && !c.classList.contains('ag-cs-branch-btn')
          );
          if (nativeIconBtns.length >= 2) return bar;
        }
        cur = cur.parentElement;
      }
      return null;
    }

    function findUserActionBar(stepEl) {
      const revertBtn = stepEl.querySelector('button[data-testid="revert-button"]');
      if (revertBtn && revertBtn.parentElement) return revertBtn.parentElement;
      const copyBtn = Array.from(stepEl.querySelectorAll('button')).find(
        (b) => !b.classList.contains('ag-cs-edit-btn') && /copy|复制|複製|コピー/i.test(String(b.getAttribute('aria-label') || ''))
      );
      return copyBtn?.parentElement || null;
    }

    function sync() {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      const ui = ctx.getUi ? ctx.getUi() : {};
      const enableBranch = cfg.branchSession !== false;
      const enableEdit = cfg.messageEdit !== false;

      if (!enableBranch) {
        document.querySelectorAll('.ag-cs-branch-btn').forEach((n) => n.remove());
      } else {
        // Remove any legacy buttons that were mounted outside native action bars
        document.querySelectorAll('.ag-cs-branch-btn').forEach((btn) => {
          if (!btn.parentElement || !btn.parentElement.classList.contains('shrink-0')) {
            btn.remove();
          }
        });
        const handledBars = new Set();
        document.querySelectorAll('[data-testid="agent-response"]').forEach((respEl) => {
          const bar = findResponseActionBar(respEl);
          if (!bar || handledBars.has(bar)) return;
          handledBars.add(bar);
          if (bar.querySelector('.ag-cs-branch-btn')) return;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className =
            'ag-cs-branch-btn agy-button agy-button-icon inline-flex items-center justify-center h-6 w-6 shrink-0 rounded-md bg-transparent text-secondary-foreground hover:text-foreground hover:bg-secondary focus-visible:text-foreground focus-visible:bg-secondary transition-colors select-none outline-none cursor-pointer';
          btn.setAttribute('data-ag-no-i18n', '');
          btn.setAttribute('aria-label', ui.branchBtnTitle || '分支会话');
          btn.setAttribute('title', ui.branchBtnTitle || '从此回复创建分支会话');
          btn.innerHTML = FORK_SVG;
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            void forkFromResponse(respEl);
          });
          bar.appendChild(btn);
        });
      }

      if (!enableEdit) {
        document.querySelectorAll('.ag-cs-edit-btn').forEach((n) => n.remove());
        closeActiveEditor();
      } else {
        document.querySelectorAll('[data-testid="user-input-step"]').forEach((stepEl) => {
          const bar = findUserActionBar(stepEl);
          if (!bar) return;
          // Clean up any legacy button not inside native action bar
          stepEl.querySelectorAll('.ag-cs-edit-btn').forEach((old) => {
            if (old.parentElement !== bar) old.remove();
          });
          if (bar.querySelector('.ag-cs-edit-btn')) return;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className =
            'ag-cs-edit-btn text-muted-foreground hover:text-secondary-foreground transition-colors pointer-events-auto p-1 cursor-pointer rounded-md';
          btn.setAttribute('data-ag-no-i18n', '');
          btn.setAttribute('aria-label', ui.editBtnTitle || '编辑消息');
          btn.setAttribute('title', ui.editBtnTitle || '原位编辑并重发此消息');
          btn.innerHTML = EDIT_SVG;
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            openInlineEditor(stepEl);
          });
          bar.insertBefore(btn, bar.firstChild);
        });
      }
    }

    function onEscape() {
      closeActiveEditor();
    }

    function destroy() {
      closeActiveEditor();
      document.querySelectorAll('.ag-cs-branch-btn, .ag-cs-edit-btn, .ag-cs-inline-edit, .ag-cs-action-toast').forEach((n) => n.remove());
    }

    return {
      ownSelector: '.ag-cs-branch-btn, .ag-cs-edit-btn, .ag-cs-inline-edit, .ag-cs-action-toast',
      sync,
      onEscape,
      destroy,
    };
  }

  return {
    create,
    preserveText,
    extractDomPromptText,
    matchTurnIndex,
    buildForkPayload,
    extractStepIndexFromFiber,
    isSubagentForkUnsupportedError,
  };
});
