// Powertools-inspired Collapsible & Draggable Task Progress Panel for AGY Claude Style.
// - Docks natively inside Antigravity's [data-testid="overview-panel"] when open.
// - Falls back to a Light/Dark theme-adaptive, freely draggable floating card when Overview is closed.
// - Shows 44px SVG ProgressRing, clear phase state (thinking/tool/streaming/waiting/retrying/subagent),
//   checklist steps, recent tool activity timeline trail with durations, active subagent jump, and live elapsed timer.
// Registers on globalThis.__agCsFeatures.taskProgress.
(function (root, factory) {
  const feature = factory();
  if (typeof module === 'object' && module.exports) module.exports = feature;
  else {
    root.__agCsFeatures = root.__agCsFeatures || {};
    root.__agCsFeatures.taskProgress = feature;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const COLLAPSED_KEY = 'agCsTaskProgressCollapsed';
  const POS_KEY = 'agCsTaskProgressPos';

  function parseChecklist(markdown) {
    const lines = String(markdown || '').split('\n');
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)[-*+]\s+\[([ xX/\-])\]\s+(.+)/);
      if (!m) continue;
      matches.push({
        depth: m[1].length,
        status: /x/i.test(m[2]) ? 'done' : /[/\-]/.test(m[2]) ? 'in_progress' : 'pending',
        title: m[3].replace(/\*\*|`/g, '').trim(),
      });
    }
    return matches
      .filter((t, idx) => !matches[idx + 1] || matches[idx + 1].depth <= t.depth)
      .map(({ title, status }) => ({ title, status }));
  }

  function classifyRetryReason(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (/unexpected\s+eof|\beof\b|connection\s+reset|broken\s+pipe/i.test(text)) {
      return { code: 'eof', zh: '网络连接中断 (EOF)', en: 'Connection dropped (EOF)' };
    }
    if (/context\s+deadline\s+exceeded|timeout|timed\s*out/i.test(text)) {
      return { code: 'timeout', zh: '请求超时', en: 'Request timeout' };
    }
    if (/\b429\b|resource_exhausted|rate\s*limit|too\s+many\s+requests|quota/i.test(text)) {
      return { code: 'rate-limit', zh: '限流或配额不足 (429)', en: 'Rate limit / quota (429)' };
    }
    if (/\b503\b|\b502\b|\b504\b|unavailable|overloaded|capacity|high\s+demand/i.test(text)) {
      return { code: 'unavailable', zh: '上游服务繁忙 (503)', en: 'Upstream busy (503)' };
    }
    if (/\b403\b|region|location|country|not\s+available\s+in\s+your|unsupported/i.test(text)) {
      return { code: 'region', zh: '地区或权限受限', en: 'Region or access restricted' };
    }
    if (/econnrefused|proxy|tls|handshake|dns|network/i.test(text)) {
      return { code: 'connection', zh: '代理或网络连接异常', en: 'Proxy or network error' };
    }
    return { code: 'other', zh: text.slice(0, 64), en: text.slice(0, 64) };
  }

  function friendlyToolLabel(rawName, isZh = true) {
    const n = String(rawName || '').trim();
    if (!n) return '';
    const lower = n.toLowerCase();
    const map = [
      [/read_file|view_file|read_slices/, isZh ? '读取文件' : 'Read file'],
      [/write_file|write_to_file/, isZh ? '写入文件' : 'Write file'],
      [/edit_file|apply_edits|replace_file/, isZh ? '编辑文件' : 'Edit file'],
      [/run_command|run_checks|execute/, isZh ? '执行命令' : 'Run command'],
      [/batch_search|grep_search|find_by_name|list_dir/, isZh ? '检索代码' : 'Search code'],
      [/search_web|read_url/, isZh ? '搜索网页' : 'Web search'],
      [/invoke_subagent|send_message|swarm/, isZh ? '子智能体协作' : 'Subagent'],
      [/update_steps|update_focus/, isZh ? '更新任务进度' : 'Update steps'],
      [/browser|open_browser/, isZh ? '浏览器操作' : 'Browser'],
      [/ctx_search|ctx_index|ctx_resume|ctx_execute/, isZh ? '上下文检索' : 'Context tool'],
    ];
    for (const [re, label] of map) {
      if (re.test(lower)) return label;
    }
    // Strip verbose MCP prefixes like mcp_agy-dart_fast_
    return n.replace(/^mcp_[^_]+_/, '').replace(/_/g, ' ');
  }

  function formatStepDur(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return `${(Math.max(100, Math.round(ms / 100) * 100) / 1000).toFixed(1)}s`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }

  function formatClock(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms === 0) return '0s';
    if (ms < 1000) return `${(Math.max(100, Math.round(ms / 100) * 100) / 1000).toFixed(1)}s`;
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3600000) {
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      return `${m}m ${s}s`;
    }
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  }

  function tsToMs(ts) {
    if (!ts) return null;
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts > 1e12 ? ts : ts * 1000;
    if (typeof ts === 'string') {
      const p = Date.parse(ts);
      return Number.isFinite(p) ? p : null;
    }
    if (typeof ts === 'object' && ts.seconds != null) {
      const sec = Number(ts.seconds);
      const nanos = Number(ts.nanos || 0);
      if (Number.isFinite(sec)) return sec * 1000 + Math.floor(nanos / 1e6);
    }
    return null;
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getFiber(el) {
    if (!el || typeof el !== 'object') return null;
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    return k ? el[k] : null;
  }

  function extractToolDetail(step, rawName) {
    const tc = step?.metadata?.toolCall;
    let argsObj = null;
    if (tc?.argumentsJson) {
      try { argsObj = JSON.parse(tc.argumentsJson); } catch {}
    }
    if (argsObj && typeof argsObj === 'object') {
      const summary = argsObj.toolSummary || argsObj.Description || argsObj.focus || argsObj.Role;
      if (typeof summary === 'string' && summary.trim()) return summary.trim();
      const p = argsObj.Path || argsObj.path || argsObj.AbsolutePath;
      if (typeof p === 'string' && p.trim()) {
        const parts = p.split(/[\\/]/).filter(Boolean);
        return parts.at(-1) || p;
      }
      const cmd = argsObj.CommandLine || argsObj.command;
      if (typeof cmd === 'string' && cmd.trim()) return cmd.trim().slice(0, 48);
      if (Array.isArray(argsObj.edits) && argsObj.edits[0]?.path) {
        return String(argsObj.edits[0].path).split(/[\\/]/).filter(Boolean).at(-1) || '';
      }
    }
    return rawName || '';
  }

  function summarizeSteps(tail, baseIdx, turnStatus, isZh) {
    const toolCalls = [];
    let checklist = [];
    let retryCount = 0;
    let retryReason = null;
    let retryErrorRaw = '';
    let startedAtMs = null;
    let lastStepAtMs = null;
    let lastResponseMs = null;
    let lastCompletedStepMs = null;
    let activeResponseSinceMs = null;
    let modelWaitTotalMs = 0;
    let modelWaitLastMs = null;
    let modelWaitSinceMs = null;
    let modelWaitCount = 0;

    for (let i = 0; i < tail.length; i++) {
      const s = tail[i];
      const sc = String(s?.step?.case || '').toLowerCase();
      const val = s?.step?.value || {};
      const stNum = Number(s?.status || 0);
      const createdMs = tsToMs(s?.metadata?.createdAt) || tsToMs(s?.createdAt);
      const completedMs = tsToMs(s?.metadata?.completedAt) || tsToMs(s?.completedAt);
      if (createdMs && startedAtMs === null) startedAtMs = createdMs;
      if (completedMs || createdMs) lastStepAtMs = Math.max(lastStepAtMs || 0, completedMs || createdMs);

      if (sc === 'plannerresponse') {
        // Antigravity sets plannerResponse.metadata.startedAt === completedAt (when generation finishes),
        // while metadata.createdAt marks when the model request actually began. Always prefer createdAt
        // (or the earliest timestamp) so completed model wait isn't collapsed to 0ms -> 0.1s.
        const rawStartedMs = tsToMs(s?.metadata?.startedAt);
        const pStart =
          createdMs && rawStartedMs
            ? Math.min(createdMs, rawStartedMs)
            : createdMs || rawStartedMs;
        let pEnd = completedMs || tsToMs(s?.metadata?.finishedGeneratingAt);
        if (!pEnd && i + 1 < tail.length) {
          pEnd = tsToMs(tail[i + 1]?.metadata?.createdAt) || tsToMs(tail[i + 1]?.createdAt);
        }
        let pDur = pStart && pEnd && pEnd >= pStart && pEnd - pStart <= 600_000 ? pEnd - pStart : null;
        if ((pDur === null || pDur === 0) && val?.thinkingDuration) {
          const td = val.thinkingDuration;
          if (typeof td === 'object' && td.seconds != null) {
            const tdMs = Number(td.seconds) * 1000 + Math.floor(Number(td.nanos || 0) / 1e6);
            if (Number.isFinite(tdMs) && tdMs > 0 && tdMs <= 600_000) pDur = tdMs;
          } else if (typeof td === 'number' && Number.isFinite(td) && td > 0) {
            pDur = td > 1000 ? td : Math.round(td * 1000);
          }
        }
        if (pDur !== null && (pEnd || pDur > 0)) {
          lastResponseMs = pDur;
          modelWaitLastMs = pDur;
          modelWaitTotalMs += pDur;
          modelWaitCount++;
          activeResponseSinceMs = null;
          modelWaitSinceMs = null;
        } else if (pStart && turnStatus === 'running') {
          activeResponseSinceMs = pStart;
          modelWaitSinceMs = pStart;
          modelWaitCount++;
        }
      }

      if (sc === 'errormessage') {
        retryCount++;
        const errObj = val.error || val;
        const raw = String(errObj.userErrorMessage || errObj.shortError || errObj.message || '').trim();
        if (raw) {
          retryErrorRaw = raw;
          retryReason = classifyRetryReason(raw);
        }
      }

      const metaToolName = String(s?.metadata?.toolCall?.name || '').trim();
      const isNonToolCase =
        sc === 'plannerresponse' ||
        sc === 'userinput' ||
        sc === 'errormessage' ||
        sc === 'checkpoint' ||
        sc === 'systemmessage' ||
        sc === 'ephemeralmessage' ||
        sc === 'conversationtitle';
      if (metaToolName || (!isNonToolCase && sc)) {
        const rawName = metaToolName || sc;
        const label = friendlyToolLabel(rawName, isZh);
        const detail = extractToolDetail(s, rawName);
        const isStepRunning = turnStatus === 'running' && (stNum === 2 || stNum === 4 || (stNum === 0 && !completedMs));
        const stepStartMs = tsToMs(s?.metadata?.startedAt) || createdMs;
        let stepEndMs = completedMs;
        if (!isStepRunning && !stepEndMs && i + 1 < tail.length) {
          stepEndMs = tsToMs(tail[i + 1]?.metadata?.createdAt) || tsToMs(tail[i + 1]?.createdAt);
        }
        const durMs =
          stepStartMs && stepEndMs && stepEndMs >= stepStartMs
            ? Math.max(0, stepEndMs - stepStartMs)
            : !isStepRunning
            ? 100
            : null;
        if (Number.isFinite(durMs) && durMs >= 0) lastCompletedStepMs = durMs;
        const cumulativeEndMs = stepEndMs || stepStartMs || lastStepAtMs;
        const totalAtStepMs =
          startedAtMs && cumulativeEndMs && cumulativeEndMs >= startedAtMs
            ? Math.max(0, cumulativeEndMs - startedAtMs)
            : null;
        toolCalls.push({
          id: `${baseIdx + i}:${rawName}`,
          rawName,
          label: detail && detail !== rawName && detail.length <= 28 ? `${label} · ${detail}` : label,
          detail: detail || rawName,
          status: isStepRunning ? 'running' : 'complete',
          waiting: stNum === 9 || Boolean(s?.metadata?.waitingForUser || val?.waitingForUser),
          startedAtMs: stepStartMs || createdMs,
          durationMs: durMs,
          totalAtStepMs,
        });
      }

      if (Array.isArray(val.toolCalls)) {
        for (const tc of val.toolCalls) {
          if (tc?.name === 'update_steps' && tc?.argumentsJson) {
            try {
              const parsed = JSON.parse(tc.argumentsJson);
              if (Array.isArray(parsed?.steps)) {
                checklist = parsed.steps.map((it) => ({
                  title: String(it.title || ''),
                  status: String(it.status || 'pending'),
                }));
              }
            } catch {}
          }
        }
      }
      if (!checklist.length && typeof val.response === 'string' && val.response.includes('- [')) {
        const parsed = parseChecklist(val.response);
        if (parsed.length) checklist = parsed;
      }
    }

    if (turnStatus === 'running' && !modelWaitSinceMs && !toolCalls.some((c) => c.status === 'running')) {
      modelWaitSinceMs = lastStepAtMs || startedAtMs;
    }

    return {
      toolCalls,
      checklist,
      retryCount,
      retryReason,
      retryErrorRaw,
      startedAtMs,
      lastStepAtMs,
      lastResponseMs,
      lastCompletedStepMs,
      activeResponseSinceMs,
      modelWaitTotalMs,
      modelWaitLastMs,
      modelWaitSinceMs,
      modelWaitCount,
    };
  }

  function findFiberRouter() {
    const anchor =
      document.querySelector('[data-testid="agent-input-box"]') ||
      document.querySelector('[data-testid="conversation-view"]') ||
      document.querySelector('[data-testid="sidebar-navigation-items"]');
    if (anchor) {
      let node = getFiber(anchor);
      let steps = 0;
      while (node && steps < 360) {
        steps++;
        const v = node.memoizedProps?.value;
        if (v && typeof v === 'object' && typeof v.navigate === 'function' && v.routesByPath) {
          return v;
        }
        node = node.return;
      }
    }
    // Fallback: search downward from #root container
    const rootEl = document.getElementById('root') || document.body?.firstElementChild;
    const rootKey = rootEl && Object.keys(rootEl).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
    if (rootKey && rootEl[rootKey]) {
      const seen = new Set();
      const stack = [rootEl[rootKey]];
      let n = 0;
      while (stack.length && n < 5000) {
        n++;
        const f = stack.pop();
        if (!f || seen.has(f)) continue;
        seen.add(f);
        const v = f.memoizedProps?.value;
        if (v && typeof v === 'object' && typeof v.navigate === 'function' && v.routesByPath) {
          return v;
        }
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    }
    return null;
  }

  function jumpToConversation(targetId) {
    const id = String(targetId || '').trim();
    if (!id) return false;
    // 1. Prefer Antigravity's native TanStack Router directly — works reliably for parent chats,
    //    Swarm workers, and off-screen subagents without clicking non-clickable wrapper divs.
    const router = findFiberRouter();
    if (router && typeof router.navigate === 'function') {
      try {
        router.navigate({
          to: '/c/$cascadeId',
          params: { cascadeId: id },
          search: (prev) => prev,
        });
        return true;
      } catch {}
    }
    // 2. Fallback: native subagent card if mounted in DOM
    const subNode = document.querySelector(`[data-testid="subagent-node"][data-cascade-id="${id}"]`);
    if (subNode && typeof subNode.click === 'function') {
      try { subNode.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
      subNode.click();
      return true;
    }
    // 3. Fallback: explicit clickable <a> link or tab
    const clickableLink =
      document.querySelector(`a[href*="/c/${id}"]`) ||
      document.querySelector(`[role="tab"][data-cascade-id="${id}"]`);
    if (clickableLink && typeof clickableLink.click === 'function') {
      try { clickableLink.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
      clickableLink.click();
      return true;
    }
    // 4. Fallback SPA navigation preserving current query (?project=...)
    try {
      const nextUrl = `/c/${encodeURIComponent(id)}${window.location.search || ''}`;
      window.history.pushState({}, '', nextUrl);
      window.dispatchEvent(new PopStateEvent('popstate'));
      return true;
    } catch {}
    return false;
  }

  function readLiveProgress(isZh = true) {
    const anchor =
      document.querySelector('[data-testid="agent-input-box"]') ||
      document.querySelector('[data-testid="conversation-view"]');
    if (!anchor) return null;
    let node = getFiber(anchor);
    let state = null;
    let store = null;
    let agentStatesMap = null;
    let steps = 0;
    while (node && steps < 320) {
      steps++;
      const v = node.memoizedProps?.value;
      if (v && typeof v === 'object') {
        if (!state && v.cascadeContext?.state?.agentStateProvider?.getState) {
          try {
            state = v.cascadeContext.state.agentStateProvider.getState();
          } catch {}
        }
        if (!agentStatesMap && typeof v.getAgentStates === 'function') {
          try {
            agentStatesMap = v.getAgentStates();
          } catch {}
        }
        if (!store && v.store && typeof v.store.getState === 'function') {
          store = v.store;
        }
      }
      node = node.return;
    }
    if (!state) return null;

    const cid = String(state.conversationId || '');
    const statusNum = Number(state.status || 0);
    const termReason = Number(state.terminationReason || 0);
    const slice = state.trajectorySlice;
    const sliceSteps = Array.isArray(slice?.stepsInSlice) ? slice.stepsInSlice : [];
    const baseIdx = Number(slice?.stepsSlice?.startIndex || 0);
    const lastTurn = state.turns?.at?.(-1) || null;
    const turnStart = lastTurn?.startStepIndex;
    const tail = Number.isInteger(turnStart)
      ? sliceSteps.filter((_, idx) => baseIdx + idx >= turnStart)
      : sliceSteps.slice(-14);

    // Parent coordinator conversation (useful when currently inside a Swarm worker or subagent)
    let parentConversationId = '';
    try {
      const curSummary = store?.getState?.()?.trajectorySummaries?.summaries?.[cid];
      const pId = curSummary?.trajectoryMetadata?.parentConversationId || curSummary?.parentConversationId || curSummary?.trajectoryMetadata?.rootConversationId || '';
      if (pId && pId !== cid) parentConversationId = String(pId);
    } catch {}

    // Subagents / Swarm workers belonging to this conversation (or siblings under same Swarm root)
    const subagents = [];
    try {
      const summaries = store?.getState?.()?.trajectorySummaries?.summaries;
      const scopeRootId = parentConversationId || cid;
      if (cid && summaries && typeof summaries === 'object') {
        for (const [id, entry] of Object.entries(summaries)) {
          if (!entry || id === cid) continue;
          const parent = entry.trajectoryMetadata?.parentConversationId || entry.parentConversationId || '';
          const rootId = entry.trajectoryMetadata?.rootConversationId || '';
          if (parent !== cid && rootId !== cid && (!parentConversationId || (parent !== scopeRootId && rootId !== scopeRootId))) continue;
          const st = entry.killed ? 'killed' : (entry.status === 2 || entry.status === 4) ? 'running' : 'done';
          const role = String(entry.trajectoryMetadata?.subagentSpec?.role || entry.summary || 'Subagent').trim();
          const summaryText = String(entry.summary || '').trim();
          const stepCount = Number(entry.stepCount || 0);
          const createdMs = tsToMs(entry.createdTime);
          const modifiedMs = tsToMs(entry.lastModifiedTime);

          let subPhase = st === 'running' ? (isZh ? '运行中' : 'Running') : st === 'killed' ? (isZh ? '已终止' : 'Stopped') : (isZh ? '已完成' : 'Completed');
          let subChecklist = [];
          let subActivity = [];
          let subLastRunMs = null;
          let subModelWaitTotalMs = 0;
          let subModelWaitLastMs = null;
          let subModelWaitSinceMs = null;
          let subModelWaitCount = 0;
          try {
            const subState = agentStatesMap?.get?.(id)?.provider?.getState?.();
            const subSlice = Array.isArray(subState?.trajectorySlice?.stepsInSlice) ? subState.trajectorySlice.stepsInSlice : [];
            if (subSlice.length > 0) {
              const parsedSub = summarizeSteps(subSlice.slice(-12), Number(subState?.trajectorySlice?.stepsSlice?.startIndex || 0), st, isZh);
              subChecklist = parsedSub.checklist;
              subActivity = parsedSub.toolCalls.slice(-3);
              subLastRunMs = Number.isFinite(parsedSub.lastResponseMs)
                ? parsedSub.lastResponseMs
                : parsedSub.lastCompletedStepMs;
              subModelWaitTotalMs = parsedSub.modelWaitTotalMs || 0;
              subModelWaitLastMs = parsedSub.modelWaitLastMs;
              subModelWaitSinceMs = parsedSub.modelWaitSinceMs;
              subModelWaitCount = parsedSub.modelWaitCount || 0;
              const liveTool = subActivity.slice().reverse().find((c) => c.status === 'running');
              if (st === 'running' && liveTool) {
                subPhase = isZh ? `执行：${liveTool.label}` : `Running: ${liveTool.label}`;
              } else if (st === 'running') {
                subPhase = isZh ? '思考与分析中' : 'Thinking';
              }
            }
          } catch {}

          subagents.push({
            id,
            title: role,
            summary: summaryText && summaryText !== role ? summaryText : '',
            status: st,
            stepCount,
            createdMs,
            modifiedMs,
            lastRunMs: subLastRunMs,
            modelWaitTotalMs: subModelWaitTotalMs,
            modelWaitLastMs: subModelWaitLastMs,
            modelWaitSinceMs: subModelWaitSinceMs,
            modelWaitCount: subModelWaitCount,
            phaseLabel: subPhase,
            checklist: subChecklist.slice(0, 5),
            recentActivity: subActivity,
          });
        }
        subagents.sort((a, b) => {
          const rank = (s) => (s.status === 'running' ? 0 : s.status === 'done' ? 1 : 2);
          return rank(a) - rank(b) || (b.modifiedMs || 0) - (a.modifiedMs || 0);
        });
      }
    } catch {}
    const visibleSubagents = subagents.slice(0, 6);
    const runningSubagents = visibleSubagents.filter((s) => s.status === 'running');

    let turnStatus = 'idle';
    if (statusNum === 2 || statusNum === 4) turnStatus = 'running';
    else if (statusNum === 3) turnStatus = 'canceling';
    else if (statusNum === 1) {
      if (termReason === 2) turnStatus = 'stopped';
      else if ([1, 3, 6, 11].includes(termReason)) turnStatus = 'error';
      else if (runningSubagents.length > 0) turnStatus = 'running';
      else if ([4, 8, 10].includes(termReason) || tail.length > 0) turnStatus = 'complete';
    }

    const {
      toolCalls,
      checklist,
      retryCount,
      retryReason,
      retryErrorRaw,
      startedAtMs,
      lastStepAtMs,
      lastResponseMs,
      lastCompletedStepMs,
      activeResponseSinceMs,
      modelWaitTotalMs,
      modelWaitLastMs,
      modelWaitSinceMs,
      modelWaitCount,
    } = summarizeSteps(tail, baseIdx, turnStatus, isZh);

    // Resolve Powertools-accurate current execution phase
    const lastStep = tail.at(-1);
    const lastCase = String(lastStep?.step?.case || '').toLowerCase();
    const lastVal = lastStep?.step?.value || {};
    const lastStatus = Number(lastStep?.status || 0);
    const runningTool = toolCalls.slice().reverse().find((c) => c.status === 'running') || null;
    const waitingTool = toolCalls.slice().reverse().find((c) => c.waiting) || null;

    let phase = '';
    let phaseDetail = '';
    let phaseSinceMs = lastStepAtMs || startedAtMs;

    if (turnStatus === 'running') {
      if (statusNum === 1 && runningSubagents.length > 0) {
        phase = 'subagent';
        phaseDetail = runningSubagents.length === 1 ? runningSubagents[0].title : String(runningSubagents.length);
      } else if (waitingTool) {
        phase = 'waiting';
        phaseDetail = friendlyToolLabel(waitingTool.rawName, isZh);
      } else if (
        lastCase &&
        lastCase !== 'plannerresponse' &&
        lastCase !== 'userinput' &&
        lastCase !== 'errormessage' &&
        (lastStatus === 2 || lastStatus === 4)
      ) {
        phase = 'tool';
        phaseDetail = runningTool?.label || friendlyToolLabel(lastStep?.metadata?.toolCall?.name || lastCase, isZh);
        if (runningTool?.startedAtMs) phaseSinceMs = runningTool.startedAtMs;
      } else if (
        lastCase === 'plannerresponse' &&
        typeof lastVal.response === 'string' &&
        lastVal.response.trim().length > 0 &&
        !(Array.isArray(lastVal.toolCalls) && lastVal.toolCalls.length > 0)
      ) {
        phase = 'streaming';
      } else if (lastCase === 'errormessage') {
        phase = 'retrying';
      } else if (
        lastCase === 'plannerresponse' &&
        typeof lastVal.thinking === 'string' &&
        lastVal.thinking.length > 0 &&
        !lastVal.response
      ) {
        phase = 'thinking';
        phaseDetail = 'thinking';
      } else if (runningTool) {
        phase = 'tool';
        phaseDetail = runningTool.label;
        if (runningTool.startedAtMs) phaseSinceMs = runningTool.startedAtMs;
      } else {
        phase = 'thinking';
        phaseDetail = 'waiting-model';
      }
    }

    const doneCount = checklist.filter((c) => c.status === 'done' || c.status === 'complete').length;
    const percent = checklist.length > 0 ? Math.round((doneCount / checklist.length) * 100) : null;

    return {
      conversationId: cid,
      parentConversationId,
      status: turnStatus,
      running: turnStatus === 'running' || turnStatus === 'canceling',
      phase,
      phaseDetail,
      phaseSinceMs,
      startedAtMs,
      lastStepAtMs,
      lastResponseMs,
      lastCompletedStepMs,
      activeResponseSinceMs,
      modelWaitTotalMs,
      modelWaitLastMs,
      modelWaitSinceMs,
      modelWaitCount,
      retryCount,
      retryReason,
      retryErrorRaw,
      checklist,
      doneCount,
      totalCount: checklist.length,
      percent,
      toolCount: toolCalls.length,
      recentActivity: toolCalls.slice(-4),
      subagents: visibleSubagents,
      runningSubagentCount: runningSubagents.length,
    };
  }

  function buildProgressRingSvg({ percent, status, isWarning }) {
    const value = percent ?? 0;
    const r = 17;
    const circ = 2 * Math.PI * r;
    const offset = circ * (1 - value / 100);
    const stroke =
      status === 'error'
        ? 'var(--destructive, #ef4444)'
        : isWarning
        ? '#f59e0b'
        : status === 'complete'
        ? '#22c55e'
        : 'var(--ag-cs-accent, var(--primary, #d97757))';

    let centerHtml = '';
    if (percent !== null) {
      centerHtml = `<span class="ag-cs-ring-pct">${percent}%</span>`;
    } else if (status === 'running' || status === 'canceling') {
      centerHtml = `<svg class="ag-cs-ring-spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
    } else if (status === 'complete') {
      centerHtml = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#22c55e" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
    } else if (status === 'error') {
      centerHtml = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--destructive, #ef4444)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`;
    } else {
      centerHtml = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/></svg>`;
    }

    return `<div class="ag-cs-ring-wrap${isWarning ? ' is-warn' : ''}">
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r="${r}" fill="none" stroke="var(--secondary, rgba(127,127,127,0.18))" stroke-width="3"/>
        <circle cx="20" cy="20" r="${r}" fill="none" stroke="${stroke}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}" transform="rotate(-90 20 20)"/>
      </svg>
      <div class="ag-cs-ring-center">${centerHtml}</div>
    </div>`;
  }

  function loadSavedPos() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (typeof p?.x === 'number' && typeof p?.y === 'number') return p;
    } catch {}
    return null;
  }

  function savePos(pos) {
    try {
      if (pos) localStorage.setItem(POS_KEY, JSON.stringify(pos));
      else localStorage.removeItem(POS_KEY);
    } catch {}
  }

  function getViewportBounds(el) {
    const w = el?.offsetWidth || 284;
    const h = el?.offsetHeight || 120;
    const winW = (typeof window !== 'undefined' && window.innerWidth) || 1200;
    const winH = (typeof window !== 'undefined' && window.innerHeight) || 800;
    return {
      minX: 8,
      maxX: Math.max(8, winW - w - 8),
      minY: 8,
      maxY: Math.max(8, winH - h - 8),
      w,
      h,
    };
  }

  function getDefaultFloatPos(el) {
    const vp = getViewportBounds(el);
    try {
      const conv = typeof document !== 'undefined' ? document.querySelector('[data-testid="conversation-view"]') : null;
      const r = conv && typeof conv.getBoundingClientRect === 'function' ? conv.getBoundingClientRect() : null;
      if (r && r.width >= vp.w + 16 && r.height >= 80) {
        const x = Math.round(Math.max(vp.minX, Math.min(vp.maxX, r.right - vp.w - 18)));
        const y = Math.round(Math.max(vp.minY, Math.min(vp.maxY, Math.max(58, r.top + 14))));
        return { x, y };
      }
    } catch {}
    return {
      x: Math.max(vp.minX, vp.maxX - 10),
      y: Math.max(vp.minY, Math.min(vp.maxY, 58)),
    };
  }

  function clampFloatPos(x, y, el, explicitBounds = null) {
    const b = explicitBounds || getViewportBounds(el);
    return {
      x: Math.round(Math.max(b.minX, Math.min(b.maxX, x))),
      y: Math.round(Math.max(b.minY, Math.min(b.maxY, y))),
    };
  }

  function create(ctx) {
    let cardEl = null;
    let clockTimer = null;
    let collapsed = false;
    let dismissedCid = '';
    let floatPos = loadSavedPos();
    let isDragging = false;
    let lastInfo = null;
    const expandedSubIds = new Set();

    try {
      collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {}

    function stopClock() {
      if (clockTimer) {
        clearInterval(clockTimer);
        clockTimer = null;
      }
    }

    function removeCard() {
      stopClock();
      if (cardEl) {
        cardEl.remove();
        cardEl = null;
      }
    }

    let layoutRo = null;
    let observedConv = null;
    function observeConversationLayout(convEl) {
      if (observedConv === convEl) return;
      if (layoutRo) {
        try { layoutRo.disconnect(); } catch {}
        layoutRo = null;
      }
      observedConv = convEl || null;
      if (!convEl || typeof ResizeObserver !== 'function') return;
      try {
        layoutRo = new ResizeObserver(() => {
          if (cardEl && cardEl.isConnected && cardEl.classList.contains('is-floating') && !isDragging) {
            applyFloatPosition(cardEl);
          }
        });
        layoutRo.observe(convEl);
      } catch {
        layoutRo = null;
      }
    }

    function applyFloatPosition(el) {
      if (!el || !el.classList.contains('is-floating')) {
        if (el) {
          el.style.left = '';
          el.style.top = '';
          el.style.right = '';
        }
        return;
      }
      if (floatPos) {
        const clamped = clampFloatPos(floatPos.x, floatPos.y, el);
        el.style.left = `${clamped.x}px`;
        el.style.top = `${clamped.y}px`;
        el.style.right = 'auto';
      } else {
        const def = getDefaultFloatPos(el);
        el.style.left = `${def.x}px`;
        el.style.top = `${def.y}px`;
        el.style.right = 'auto';
      }
    }

    function attachDragHandlers(handleEl, card) {
      let startX = 0;
      let startY = 0;
      let originLeft = 0;
      let originTop = 0;
      let moved = false;

      handleEl.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 || !card.classList.contains('is-floating')) return;
        if (ev.target && ev.target.closest && ev.target.closest('button[data-action]')) return;
        const rect = card.getBoundingClientRect();
        startX = ev.clientX;
        startY = ev.clientY;
        originLeft = rect.left;
        originTop = rect.top;
        moved = false;
        isDragging = true;
        try { handleEl.setPointerCapture(ev.pointerId); } catch {}
      });

      handleEl.addEventListener('pointermove', (ev) => {
        if (!isDragging || !card.classList.contains('is-floating')) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) > 4) {
          moved = true;
          card.classList.add('is-dragging');
        }
        if (moved) {
          const next = clampFloatPos(originLeft + dx, originTop + dy, card);
          floatPos = next;
          card.style.left = `${next.x}px`;
          card.style.top = `${next.y}px`;
          card.style.right = 'auto';
        }
      });

      const endDrag = (ev) => {
        if (!isDragging) return;
        isDragging = false;
        card.classList.remove('is-dragging');
        try { handleEl.releasePointerCapture(ev.pointerId); } catch {}
        if (moved) {
          savePos(floatPos);
          card.setAttribute('data-just-dragged', '1');
          setTimeout(() => card.removeAttribute('data-just-dragged'), 120);
        }
      };
      handleEl.addEventListener('pointerup', endDrag);
      handleEl.addEventListener('pointercancel', endDrag);
      handleEl.addEventListener('dblclick', (ev) => {
        if (!card.classList.contains('is-floating')) return;
        ev.stopPropagation();
        floatPos = null;
        savePos(null);
        applyFloatPosition(card);
      });
    }

    function formatRunningStep(startMs, totalStartMs, nowMs, isZh) {
      const prefix = isZh ? '执行中' : 'Running';
      const stepPart = Number.isFinite(startMs) && startMs > 0 ? formatStepDur(Math.max(0, nowMs - startMs)) : '';
      const totalPart = Number.isFinite(totalStartMs) && totalStartMs > 0 ? formatClock(Math.max(0, nowMs - totalStartMs)) : '';
      if (stepPart && totalPart) return `${prefix} ${stepPart} / ${totalPart}`;
      if (stepPart) return `${prefix} ${stepPart}`;
      if (totalPart) return `${prefix} ${totalPart}`;
      return prefix;
    }

    function formatCompletedStepPair(durMs, totalMs) {
      const stepPart = Number.isFinite(durMs) ? formatStepDur(durMs) : '';
      const totalPart = Number.isFinite(totalMs) ? formatClock(totalMs) : '';
      if (stepPart && totalPart) return `${stepPart} / ${totalPart}`;
      return stepPart || totalPart || '';
    }

    function formatModelWaitPair({ liveSinceMs, baseTotalMs, lastMs, totalStartMs, totalElapsedMs, nowMs, isZh }) {
      const base = Number.isFinite(baseTotalMs) && baseTotalMs > 0 ? baseTotalMs : 0;
      if (liveSinceMs && liveSinceMs > 0) {
        const cur = Math.max(0, nowMs - liveSinceMs);
        const turnTotal =
          totalStartMs && totalStartMs > 0
            ? Math.max(cur, nowMs - totalStartMs)
            : Math.max(cur, base + cur);
        return `${isZh ? '等待中' : 'Waiting'} ${formatStepDur(cur)} / ${formatClock(turnTotal)}`;
      }
      const stepMs = Number.isFinite(lastMs) && lastMs >= 0 ? lastMs : base > 0 ? base : null;
      const stepPart = stepMs !== null ? formatStepDur(stepMs) : '';
      const totalMs =
        Number.isFinite(totalElapsedMs) && totalElapsedMs >= 0
          ? totalElapsedMs
          : base > 0
          ? base
          : null;
      const totalPart = Number.isFinite(totalMs) && totalMs >= 0 ? formatClock(totalMs) : '';
      if (stepPart && totalPart) return `${stepPart} / ${totalPart}`;
      return stepPart || totalPart || '';
    }

    function updateLiveClocks() {
      if (!cardEl || !lastInfo) return;
      const now = Date.now();
      const isZh = lastInfo.isZh !== false;
      const elapsedEl = cardEl.querySelector('.ag-cs-elapsed-val');
      if (elapsedEl && lastInfo.running && lastInfo.startedAtMs) {
        elapsedEl.textContent = formatClock(Math.max(0, now - lastInfo.startedAtMs));
      }
      const respEl = cardEl.querySelector('.ag-cs-resp-val[data-since-ms]');
      if (respEl && lastInfo.running) {
        const since = Number(respEl.getAttribute('data-since-ms'));
        if (Number.isFinite(since) && since > 0) {
          respEl.textContent = formatStepDur(Math.max(0, now - since));
        }
      }
      cardEl.querySelectorAll('[data-model-wait-since]').forEach((el) => {
        const since = Number(el.getAttribute('data-model-wait-since'));
        const base = Number(el.getAttribute('data-model-wait-base')) || 0;
        const totalSince = Number(el.getAttribute('data-total-since')) || 0;
        if (Number.isFinite(since) && since > 0) {
          el.textContent = formatModelWaitPair({
            liveSinceMs: since,
            baseTotalMs: base,
            totalStartMs: totalSince,
            nowMs: now,
            isZh,
          });
        }
      });
      cardEl.querySelectorAll('[data-running-since]').forEach((el) => {
        const since = Number(el.getAttribute('data-running-since'));
        const totalSince = Number(el.getAttribute('data-total-since')) || 0;
        if (Number.isFinite(since) && since > 0) {
          el.textContent = formatRunningStep(since, totalSince, now, isZh);
        }
      });
      cardEl.querySelectorAll('[data-sub-since]').forEach((el) => {
        const since = Number(el.getAttribute('data-sub-since'));
        if (Number.isFinite(since) && since > 0) {
          el.textContent = formatClock(Math.max(0, now - since));
        }
      });
      const collapsedBadgeEl = cardEl.querySelector('.ag-cs-progress-badge[data-elapsed-since]');
      if (collapsedBadgeEl) {
        const since = Number(collapsedBadgeEl.getAttribute('data-elapsed-since'));
        const prefix = collapsedBadgeEl.getAttribute('data-badge-prefix') || '';
        if (Number.isFinite(since) && since > 0 && prefix) {
          const nextTxt = `${prefix} ${formatClock(Math.max(0, now - since))}`;
          if (collapsedBadgeEl.textContent !== nextTxt) collapsedBadgeEl.textContent = nextTxt;
        }
      }
      if (lastInfo.running && lastInfo.phase === 'thinking' && lastInfo.phaseSinceMs) {
        const waitSec = Math.floor(Math.max(0, now - lastInfo.phaseSinceMs) / 1000);
        const titleEl = cardEl.querySelector('.ag-cs-progress-headline');
        if (titleEl && waitSec >= 3) {
          const base = titleEl.getAttribute('data-base-title') || '';
          if (base) titleEl.textContent = `${base} (${waitSec}s)`;
        }
      }
    }

    function sync() {
      if (isDragging) return;
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      if (cfg.taskProgressCard === false) {
        removeCard();
        return;
      }
      const overview = document.querySelector('[data-testid="overview-panel"]');
      const convoView = document.querySelector('[data-testid="conversation-view"]');
      if (!overview && !convoView) {
        removeCard();
        return;
      }

      const isZh = String(cfg.language || 'zh-CN').startsWith('zh') || cfg.language === 'yue';
      const info = readLiveProgress(isZh);
      if (!info) {
        removeCard();
        return;
      }

      // When floating (no native Overview panel), only show when actively running, retrying,
      // having active subagents, or having an active checklist — never spam when idle/done!
      const docked = Boolean(overview);
      const shouldShow = docked
        ? Boolean(info.running || info.checklist.length > 0 || info.recentActivity.length > 0 || info.subagents.length > 0 || info.status === 'error')
        : Boolean(
            dismissedCid !== info.conversationId &&
            (info.running || info.runningSubagentCount > 0 || (info.checklist.length > 0 && info.doneCount < info.totalCount))
          );

      if (!shouldShow) {
        removeCard();
        return;
      }

      if (info.running && dismissedCid === info.conversationId && info.status === 'running') {
        // Keep dismissed for this turn if user explicitly closed it; reset on new conversation.
      }
      lastInfo = { ...info, isZh };
      if (info.running) {
        if (!clockTimer) clockTimer = setInterval(updateLiveClocks, 1000);
      } else {
        stopClock();
      }

      const now = Date.now();
      const elapsedMs = info.startedAtMs
        ? Math.max(0, (info.running ? now : info.lastStepAtMs || now) - info.startedAtMs)
        : null;
      const elapsedText = formatClock(elapsedMs);
      const waitSec = info.phaseSinceMs ? Math.floor(Math.max(0, now - info.phaseSinceMs) / 1000) : 0;

      const stateLabel =
        info.status === 'stopped'
          ? (isZh ? '已停止' : 'Stopped')
          : info.status === 'canceling'
          ? (isZh ? '正在停止' : 'Stopping')
          : info.status === 'running'
          ? (isZh ? '进行中' : 'Running')
          : info.status === 'error'
          ? (isZh ? '执行异常' : 'Error')
          : info.status === 'complete'
          ? (isZh ? '已完成' : 'Completed')
          : (isZh ? '等待任务' : 'Idle');

      let baseHeadline = '';
      if (info.status === 'running' && info.phase) {
        if (info.phase === 'subagent') {
          baseHeadline =
            info.runningSubagentCount > 1
              ? (isZh ? `子智能体运行中（${info.runningSubagentCount} 个）` : `Subagents running (${info.runningSubagentCount})`)
              : (isZh ? `子智能体：${info.phaseDetail}` : `Subagent: ${info.phaseDetail}`);
        } else if (info.phase === 'waiting') {
          baseHeadline = isZh
            ? `等待操作确认${info.phaseDetail ? `：${info.phaseDetail}` : ''}`
            : `Waiting approval${info.phaseDetail ? `: ${info.phaseDetail}` : ''}`;
        } else if (info.phase === 'retrying') {
          baseHeadline = isZh
            ? `正在重试${info.retryCount > 0 ? `（第 ${info.retryCount} 次）` : ''}`
            : `Retrying${info.retryCount > 0 ? ` (#${info.retryCount})` : ''}`;
        } else if (info.phase === 'tool') {
          baseHeadline = isZh
            ? `正在执行：${info.phaseDetail || '工具'}`
            : `Running: ${info.phaseDetail || 'tool'}`;
        } else if (info.phase === 'streaming') {
          baseHeadline = isZh ? '正在生成回复' : 'Generating response';
        } else if (info.phaseDetail === 'waiting-model') {
          baseHeadline = isZh ? '等待模型响应' : 'Waiting for model';
        } else {
          baseHeadline = isZh ? '正在思考' : 'Thinking';
        }
      }
      const headline =
        baseHeadline
          ? info.phase === 'thinking' && waitSec >= 3
            ? `${baseHeadline} (${waitSec}s)`
            : baseHeadline
          : info.checklist.find((t) => t.status === 'in_progress' || t.status === 'running')?.title || stateLabel;

      const isWarning = info.status === 'running' && (info.phase === 'waiting' || info.phase === 'retrying');
      const subText =
        (info.phase === 'retrying' || info.status === 'error') && info.retryReason
          ? (isZh ? info.retryReason.zh : info.retryReason.en)
          : '';

      const shortLive =
        info.phase === 'waiting'
          ? (isZh ? '等待确认' : 'Approval')
          : info.phase === 'retrying'
          ? (isZh ? '重试中' : 'Retrying')
          : info.phase === 'subagent'
          ? (isZh ? '子智能体' : 'Subagent')
          : stateLabel;

      const badge = collapsed
        ? info.totalCount > 0
          ? `${info.doneCount}/${info.totalCount}`
          : elapsedText
          ? `${shortLive} ${elapsedText}`
          : shortLive
        : info.totalCount > 0
        ? `${info.doneCount}/${info.totalCount}`
        : info.toolCount > 0
        ? String(info.toolCount)
        : '';

      const badgeTone = isWarning ? 'warning' : info.running ? 'active' : info.status === 'error' ? 'critical' : '';

      const hostParent = docked ? overview : document.body || convoView;
      if (!cardEl || !cardEl.isConnected || cardEl.parentElement !== hostParent) {
        if (cardEl) cardEl.remove();
        cardEl = document.createElement('section');
        cardEl.className = 'ag-cs-progress-card';
        cardEl.setAttribute('data-ag-no-i18n', '');
        hostParent.appendChild(cardEl);
      }
      cardEl.classList.toggle('is-docked', docked);
      cardEl.classList.toggle('is-floating', !docked);
      cardEl.classList.toggle('is-collapsed', collapsed);
      observeConversationLayout(!docked ? convoView : null);
      applyFloatPosition(cardEl);

      const useLiveCollapsedBadge = Boolean(collapsed && info.totalCount === 0 && info.startedAtMs);
      const badgeKey = useLiveCollapsedBadge ? `${shortLive}|${info.startedAtMs}` : badge;
      const sig = collapsed
        ? JSON.stringify({
            docked,
            collapsed,
            conversationId: info.conversationId,
            status: info.status,
            phase: info.phase,
            badgeKey,
            badgeTone,
          })
        : JSON.stringify({
            docked,
            collapsed,
            conversationId: info.conversationId,
            parentConversationId: info.parentConversationId,
            status: info.status,
            phase: info.phase,
            baseHeadline,
            subText,
            badgeKey,
            badgeTone,
            percent: info.percent,
            checklist: info.checklist,
            recentActivity: info.recentActivity.map((a) => [a.id, a.label, a.status, Math.floor((a.durationMs || 0) / 1000)]),
            modelWait: [
              Math.floor((info.modelWaitTotalMs || 0) / 1000),
              Math.floor((info.modelWaitLastMs || 0) / 1000),
              info.modelWaitCount,
              Boolean(info.modelWaitSinceMs),
            ],
            subagents: info.subagents.map((s) => [
              s.id,
              s.status,
              s.stepCount,
              s.phaseLabel,
              Math.floor((s.modelWaitTotalMs || 0) / 1000),
              expandedSubIds.has(s.id),
            ]),
            toolCount: info.toolCount,
          });
      if (cardEl.getAttribute('data-sig') === sig) {
        updateLiveClocks();
        return;
      }
      cardEl.setAttribute('data-sig', sig);
      cardEl.innerHTML = '';

      // Header bar (acts as drag handle when floating + collapse toggle)
      const head = document.createElement('div');
      head.className = 'ag-cs-progress-head';
      head.setAttribute('role', 'button');
      head.setAttribute('aria-expanded', String(!collapsed));
      head.title = docked
        ? (isZh ? '点击折叠/展开任务进度' : 'Toggle task progress')
        : (isZh ? '拖动移动位置 · 双击复位 · 点击折叠' : 'Drag to move · Double-click to reset · Click to collapse');
      const liveBadgeAttrs = useLiveCollapsedBadge
        ? ` data-elapsed-since="${info.startedAtMs}" data-badge-prefix="${escapeHtml(shortLive)}"`
        : '';
      head.innerHTML = `
        ${!docked ? '<span class="ag-cs-drag-grip" aria-hidden="true">⋮⋮</span>' : ''}
        <span class="ag-cs-progress-label">${isZh ? '任务进度' : 'Task Progress'}</span>
        ${badge ? `<span class="ag-cs-progress-badge"${badgeTone ? ` data-tone="${badgeTone}"` : ''}${liveBadgeAttrs}>${escapeHtml(badge)}</span>` : ''}
        <span class="ag-cs-progress-head-right">
          ${!docked ? `<button type="button" class="ag-cs-progress-close" data-action="close" title="${isZh ? '暂时隐藏（本会话）' : 'Hide for this conversation'}" aria-label="Close">×</button>` : ''}
          <span class="ag-cs-progress-chev" aria-hidden="true">${collapsed ? '▸' : '▾'}</span>
        </span>
      `;
      attachDragHandlers(head, cardEl);
      head.addEventListener('click', (ev) => {
        if (cardEl.getAttribute('data-just-dragged') === '1') return;
        const closeBtn = ev.target && ev.target.closest ? ev.target.closest('button[data-action="close"]') : null;
        if (closeBtn) {
          ev.stopPropagation();
          dismissedCid = info.conversationId;
          removeCard();
          return;
        }
        ev.stopPropagation();
        collapsed = !collapsed;
        try { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {}
        cardEl.removeAttribute('data-sig');
        sync();
      });
      cardEl.appendChild(head);

      if (!collapsed) {
        const body = document.createElement('div');
        body.className = 'ag-cs-progress-body';

        // 1. Hero row with 40px SVG ProgressRing + Headline + Subtitle
        const hero = document.createElement('div');
        hero.className = 'ag-cs-progress-hero';
        hero.innerHTML = `
          ${buildProgressRingSvg({ percent: info.percent, status: info.status, isWarning })}
          <div class="ag-cs-progress-heading">
            <div class="ag-cs-progress-headline" data-phase="${escapeHtml(info.phase)}" data-base-title="${escapeHtml(baseHeadline)}" title="${escapeHtml(info.retryErrorRaw || headline)}">${escapeHtml(headline)}</div>
            ${subText ? `<div class="ag-cs-progress-sub" title="${escapeHtml(info.retryErrorRaw || subText)}">${escapeHtml(subText)}</div>` : ''}
          </div>
        `;
        body.appendChild(hero);

        // 2. Task checklist
        if (info.checklist.length > 0) {
          const list = document.createElement('div');
          list.className = 'ag-cs-task-list';
          for (const step of info.checklist.slice(0, 8)) {
            const st = step.status === 'done' || step.status === 'complete'
              ? 'complete'
              : step.status === 'in_progress' || step.status === 'running'
              ? 'running'
              : 'pending';
            const row = document.createElement('div');
            row.className = `ag-cs-task-row is-${st}`;
            const iconChar = st === 'complete' ? '✓' : st === 'running' ? '●' : '○';
            row.innerHTML = `<span class="ag-cs-task-ic">${iconChar}</span><span class="ag-cs-task-txt" title="${escapeHtml(step.title)}">${escapeHtml(step.title)}</span>`;
            list.appendChild(row);
          }
          body.appendChild(list);
        }

        // 3. Recent tool activity timeline trail (Model Wait Time ALWAYS #1 first, then tool steps)
        const hasModelWait = Boolean(
          info.modelWaitSinceMs || info.modelWaitTotalMs > 0 || Number.isFinite(info.modelWaitLastMs)
        );
        if (hasModelWait || info.recentActivity.length > 0) {
          const trail = document.createElement('div');
          trail.className = 'ag-cs-trail';
          const pairTitle = isZh ? '本次运行时间 / 累计总消耗时间' : 'Step duration / Total elapsed';

          if (hasModelWait) {
            const isWaitLive = Boolean(info.running && info.modelWaitSinceMs);
            const waitLabel =
              info.modelWaitCount > 1
                ? isZh
                  ? `模型等待时间 · ${info.modelWaitCount}次`
                  : `Model wait · ${info.modelWaitCount}×`
                : isZh
                ? '模型等待时间'
                : 'Model wait';
            const totalStart = info.startedAtMs || 0;
            const waitDur = formatModelWaitPair({
              liveSinceMs: isWaitLive ? info.modelWaitSinceMs : 0,
              baseTotalMs: info.modelWaitTotalMs,
              lastMs: info.modelWaitLastMs,
              totalStartMs: totalStart,
              totalElapsedMs: elapsedMs,
              nowMs: now,
              isZh,
            });
            const cumWaitHint = info.modelWaitTotalMs > 0 ? ` · ${isZh ? '累计模型等待' : 'Total model wait'} ${formatStepDur(info.modelWaitTotalMs)}` : '';
            const waitTitle = isZh
              ? `当前或上次模型等待 / 本轮总消耗时间 (${waitDur}${cumWaitHint})`
              : `Current or last model wait / Turn total elapsed (${waitDur}${cumWaitHint})`;
            const waitEl = document.createElement('div');
            waitEl.className = `ag-cs-trail-node is-model-wait is-${isWaitLive ? 'running' : 'complete'}`;
            waitEl.title = waitTitle;
            waitEl.innerHTML = `
              <span class="ag-cs-trail-dot-wrap" aria-hidden="true"><span class="ag-cs-trail-dot"></span></span>
              <span class="ag-cs-trail-label">${escapeHtml(waitLabel)}</span>
              ${waitDur ? `<span class="ag-cs-trail-dur" title="${escapeHtml(waitTitle)}"${isWaitLive ? ` data-model-wait-since="${info.modelWaitSinceMs}" data-model-wait-base="${info.modelWaitTotalMs || 0}" data-total-since="${totalStart}"` : ''}>${escapeHtml(waitDur)}</span>` : ''}
            `;
            trail.appendChild(waitEl);
          }

          for (const call of info.recentActivity) {
            const runStart = call.status === 'running' ? (call.startedAtMs || info.phaseSinceMs || info.startedAtMs || 0) : 0;
            const totalStart = info.startedAtMs || 0;
            const dur =
              call.status === 'running'
                ? formatRunningStep(runStart, totalStart, now, isZh)
                : formatCompletedStepPair(call.durationMs, call.totalAtStepMs ?? elapsedMs);
            const nodeEl = document.createElement('div');
            nodeEl.className = `ag-cs-trail-node is-${call.status}`;
            nodeEl.title = `${call.detail || call.label}${dur ? ` (${pairTitle}: ${dur})` : ''}`;
            nodeEl.innerHTML = `
              <span class="ag-cs-trail-dot-wrap" aria-hidden="true"><span class="ag-cs-trail-dot"></span></span>
              <span class="ag-cs-trail-label">${escapeHtml(call.label)}</span>
              ${dur ? `<span class="ag-cs-trail-dur" title="${pairTitle}"${runStart ? ` data-running-since="${runStart}" data-total-since="${totalStart}"` : ''}>${escapeHtml(dur)}</span>` : ''}
            `;
            trail.appendChild(nodeEl);
          }
          body.appendChild(trail);
        }

        // 4. Subagents / Swarm workers secondary menu: same-row expand progress + jump button
        if (info.subagents.length > 0 || info.parentConversationId) {
          const subWrap = document.createElement('div');
          subWrap.className = 'ag-cs-sub-list';
          if (info.parentConversationId) {
            const backRow = document.createElement('div');
            backRow.className = 'ag-cs-sub-item';
            backRow.innerHTML = `<div class="ag-cs-sub-row"><span class="ag-cs-sub-toggle" style="cursor:default;opacity:.85;"><span class="ag-cs-sub-name">${isZh ? '当前位于子智能体 / Swarm 成员' : 'In Subagent / Swarm Worker'}</span></span><button type="button" class="ag-cs-sub-jump">${isZh ? '← 主会话' : '← Parent'}</button></div>`;
            backRow.querySelector('.ag-cs-sub-jump').addEventListener('click', (ev) => {
              ev.stopPropagation();
              jumpToConversation(info.parentConversationId);
            });
            subWrap.appendChild(backRow);
          }
          for (const sub of info.subagents) {
            const isOpen = expandedSubIds.has(sub.id);
            const item = document.createElement('div');
            item.className = `ag-cs-sub-item is-${sub.status}${isOpen ? ' is-open' : ''}`;

            const row = document.createElement('div');
            row.className = 'ag-cs-sub-row';

            const subDone = sub.checklist.filter((c) => c.status === 'done' || c.status === 'complete').length;
            const subBadge = sub.checklist.length > 0
              ? `${subDone}/${sub.checklist.length}`
              : sub.stepCount > 0
              ? `${sub.stepCount}${isZh ? '步' : 'st'}`
              : '';

            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'ag-cs-sub-toggle';
            toggleBtn.setAttribute('aria-expanded', String(isOpen));
            toggleBtn.title = isZh ? '展开/收起子智能体进度' : 'Toggle subagent progress';
            toggleBtn.innerHTML = `
              <span class="ag-cs-sub-chev" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
              <span class="ag-cs-sub-dot is-${sub.status}" aria-hidden="true"></span>
              <span class="ag-cs-sub-name">${escapeHtml(sub.title)}</span>
              ${subBadge ? `<span class="ag-cs-sub-badge">${escapeHtml(subBadge)}</span>` : ''}
            `;
            toggleBtn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              if (expandedSubIds.has(sub.id)) expandedSubIds.delete(sub.id);
              else expandedSubIds.add(sub.id);
              cardEl.removeAttribute('data-sig');
              sync();
            });

            const jumpBtn = document.createElement('button');
            jumpBtn.type = 'button';
            jumpBtn.className = 'ag-cs-sub-jump';
            jumpBtn.title = isZh ? '跳转到该子智能体 / Swarm 成员会话' : 'Jump to subagent / Swarm worker';
            jumpBtn.textContent = isZh ? '跳至 ↗' : 'Jump ↗';
            jumpBtn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              jumpToConversation(sub.id);
            });

            row.appendChild(toggleBtn);
            row.appendChild(jumpBtn);
            item.appendChild(row);

            if (isOpen) {
              const detail = document.createElement('div');
              detail.className = 'ag-cs-sub-detail';
              const subDur = sub.createdMs
                ? formatClock(Math.max(0, (sub.status === 'running' ? now : sub.modifiedMs || now) - sub.createdMs))
                : '';
              const metaRow = document.createElement('div');
              metaRow.className = 'ag-cs-sub-meta';
              const subSinceAttr = sub.status === 'running' && sub.createdMs ? ` data-sub-since="${sub.createdMs}"` : '';
              const subLastStr = Number.isFinite(sub.lastRunMs) ? formatStepDur(sub.lastRunMs) : '';
              const subTimeHtml = subDur
                ? `<span class="ag-cs-sub-dur" title="${isZh ? '上一次运行时间 / 总消耗时间' : 'Last run / Total elapsed'}">${subLastStr ? `${escapeHtml(subLastStr)} / ` : ''}<span${subSinceAttr}>${escapeHtml(subDur)}</span></span>`
                : '';
              metaRow.innerHTML = `<span class="ag-cs-sub-phase">${escapeHtml(sub.phaseLabel)}</span>${subTimeHtml}`;
              detail.appendChild(metaRow);

              const hasSubWait = Boolean(sub.modelWaitSinceMs || sub.modelWaitTotalMs > 0 || Number.isFinite(sub.modelWaitLastMs));
              if (hasSubWait) {
                const isSubWaitLive = Boolean(sub.status === 'running' && sub.modelWaitSinceMs);
                const swLabel =
                  sub.modelWaitCount > 1
                    ? isZh
                      ? `模型等待时间 · ${sub.modelWaitCount}次`
                      : `Model wait · ${sub.modelWaitCount}×`
                    : isZh
                    ? '模型等待时间'
                    : 'Model wait';
                const subTotalStart = sub.createdMs || 0;
                const swDur = formatModelWaitPair({
                  liveSinceMs: isSubWaitLive ? sub.modelWaitSinceMs : 0,
                  baseTotalMs: sub.modelWaitTotalMs,
                  lastMs: sub.modelWaitLastMs,
                  totalStartMs: subTotalStart,
                  totalElapsedMs: sub.createdMs ? Math.max(0, (sub.status === 'running' ? now : sub.modifiedMs || now) - sub.createdMs) : null,
                  nowMs: now,
                  isZh,
                });
                const swRow = document.createElement('div');
                swRow.className = `ag-cs-sub-step is-model-wait is-${isSubWaitLive ? 'running' : 'complete'}`;
                swRow.innerHTML = `<span class="ag-cs-sub-step-lbl">${isSubWaitLive ? '●' : '◷'} ${escapeHtml(swLabel)}</span>${swDur ? `<span class="ag-cs-sub-dur" title="${isZh ? '模型单次等待 / 子任务总消耗时间' : 'Model wait / Subtask total elapsed'}"${isSubWaitLive ? ` data-model-wait-since="${sub.modelWaitSinceMs}" data-model-wait-base="${sub.modelWaitTotalMs || 0}" data-total-since="${subTotalStart}"` : ''}>${escapeHtml(swDur)}</span>` : ''}`;
                detail.appendChild(swRow);
              }

              if (sub.checklist.length > 0) {
                for (const st of sub.checklist) {
                  const stCls = st.status === 'done' || st.status === 'complete' ? 'complete' : st.status === 'in_progress' || st.status === 'running' ? 'running' : 'pending';
                  const srow = document.createElement('div');
                  srow.className = `ag-cs-sub-step is-${stCls}`;
                  srow.textContent = `${stCls === 'complete' ? '✓' : stCls === 'running' ? '●' : '○'} ${st.title}`;
                  detail.appendChild(srow);
                }
              } else if (sub.recentActivity.length > 0) {
                const subPairTitle = isZh ? '本次运行时间 / 累计总消耗时间' : 'Step duration / Total elapsed';
                for (const act of sub.recentActivity) {
                  const arow = document.createElement('div');
                  arow.className = `ag-cs-sub-step is-${act.status}`;
                  const actRunStart = act.status === 'running' ? (act.startedAtMs || sub.createdMs || 0) : 0;
                  const subTotalStart = sub.createdMs || 0;
                  const d = act.status === 'running'
                    ? formatRunningStep(actRunStart, subTotalStart, now, isZh)
                    : formatCompletedStepPair(act.durationMs, act.totalAtStepMs);
                  arow.innerHTML = `<span class="ag-cs-sub-step-lbl">${act.status === 'running' ? '●' : '✓'} ${escapeHtml(act.label)}</span>${d ? `<span class="ag-cs-sub-dur" title="${subPairTitle}"${actRunStart ? ` data-running-since="${actRunStart}" data-total-since="${subTotalStart}"` : ''}>${escapeHtml(d)}</span>` : ''}`;
                  detail.appendChild(arow);
                }
              } else if (sub.summary) {
                const sdiv = document.createElement('div');
                sdiv.className = 'ag-cs-sub-summary';
                sdiv.textContent = sub.summary;
                detail.appendChild(sdiv);
              }
              item.appendChild(detail);
            }

            subWrap.appendChild(item);
          }
          body.appendChild(subWrap);
        }

        // 5. Footer meta row (tool count + 上一次运行时间 / 总消耗时间)
        const respSince = info.running && (info.phase === 'thinking' || info.phase === 'streaming')
          ? (info.activeResponseSinceMs || info.phaseSinceMs || 0)
          : 0;
        const lastRunMs = Number.isFinite(info.lastResponseMs)
          ? info.lastResponseMs
          : Number.isFinite(info.lastCompletedStepMs)
          ? info.lastCompletedStepMs
          : null;
        const lastRunText = Number.isFinite(lastRunMs)
          ? formatStepDur(lastRunMs)
          : respSince
          ? formatStepDur(Math.max(0, now - respSince))
          : '';
        const useLiveResp = !Number.isFinite(lastRunMs) && Boolean(respSince);
        if (info.toolCount > 0 || elapsedText || lastRunText) {
          const foot = document.createElement('div');
          foot.className = 'ag-cs-progress-foot';
          const leftText = info.toolCount > 0 ? `${isZh ? '工具调用' : 'Tools'} ${info.toolCount}` : '';
          const ratioParts = [];
          if (lastRunText) {
            ratioParts.push(
              `<span class="ag-cs-resp-val"${useLiveResp ? ` data-since-ms="${respSince}"` : ''}>${escapeHtml(lastRunText)}</span>`
            );
          }
          if (elapsedText) {
            ratioParts.push(`<span class="ag-cs-elapsed-val">${escapeHtml(elapsedText)}</span>`);
          }
          const ratioTitle = isZh ? '上一次运行时间 / 总消耗时间' : 'Last run / Total elapsed';
          foot.innerHTML = `
            <span>${escapeHtml(leftText)}</span>
            ${ratioParts.length > 0 ? `<span class="ag-cs-elapsed" title="${ratioTitle}">${ratioParts.join(' / ')}</span>` : ''}
          `;
          body.appendChild(foot);
        }

        cardEl.appendChild(body);
      }
    }

    return {
      ownSelector: '.ag-cs-progress-card',
      sync,
      destroy() {
        observeConversationLayout(null);
        removeCard();
      },
    };
  }

  return {
    create,
    parseChecklist,
    classifyRetryReason,
    friendlyToolLabel,
    summarizeSteps,
    formatStepDur,
    formatClock,
    clampFloatPos,
    jumpToConversation,
  };
});
