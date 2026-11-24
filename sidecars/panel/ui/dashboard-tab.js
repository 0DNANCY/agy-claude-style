// Tab 2: Usage & Request Records Dashboard for AGY Claude Style Aux Pane.
// Features: 5s auto-refresh, 53w interactive heatmap (auto-scroll to today + zero-delay tooltip),
// inline request filters directly above request cards, conversation source title + filter, and pagination.
(function (root) {
  const PAGE_SIZE = 50;

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return String(v);
  }

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms === 0) return '<1s';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
  }

  function fmtDateTime(ms) {
    if (!ms) return '--';
    const d = new Date(ms);
    const pad = (x) => String(x).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  root.AGYPanelDashboard = function initDashboardTab(app) {
    let lastHeatCells = [];
    let heatMetric = 'tokens';
    let selectedHeatDate = '';
    let selectedConvoId = '';
    let selectedConvoTitle = '';
    let selectedStatus = 'all';
    let loadedLimit = PAGE_SIZE;
    let lastTodaySummary = null;
    let autoRefresh = true;
    let autoTimer = null;
    let inflight = false;

    function scrollHeatmapToToday() {
      const wrap = document.getElementById('heatmap-wrap');
      if (!wrap) return;
      requestAnimationFrame(() => {
        wrap.scrollLeft = wrap.scrollWidth;
      });
    }

    function showHeatTooltip(cell, targetEl) {
      const tip = document.getElementById('heat-tooltip');
      if (!tip || !cell) return;
      const errPart = cell.errorCount > 0 ? ` · 报错 ${cell.errorCount}` : '';
      const anomPart = cell.anomalyCount > 0 ? ` · 掉缓存 ${cell.anomalyCount}` : '';
      tip.innerHTML = `
        <div class="heat-tt-date">
          <span>${cell.date}</span>
          ${cell.isToday ? '<span class="heat-tt-tag">今天</span>' : ''}
        </div>
        <div class="heat-tt-row"><span>请求次数</span><b>${cell.count} 次${errPart}${anomPart}</b></div>
        <div class="heat-tt-row"><span>总 Token</span><b>${fmtTokens(cell.tokens)}</b></div>
        <div class="heat-tt-row"><span>缓存命中</span><b>${cell.count > 0 ? cell.cacheHitPct + '%' : '-'}</b></div>
        <div class="heat-tt-row"><span>参考费用</span><b>$${Number(cell.costUsd || 0).toFixed(3)}</b></div>
        <div class="heat-tt-hint">${selectedHeatDate === cell.date ? '再次点击取消按日筛选' : '点击筛选当日请求记录'}</div>
      `;
      tip.classList.add('show');
      const rect = targetEl.getBoundingClientRect();
      const tw = tip.offsetWidth || 180;
      const th = tip.offsetHeight || 110;
      let left = rect.left + rect.width / 2 - tw / 2;
      left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));
      let top = rect.top - th - 8;
      if (top < 8) top = rect.bottom + 8;
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
    }

    function hideHeatTooltip() {
      const tip = document.getElementById('heat-tooltip');
      if (tip) tip.classList.remove('show');
    }

    function renderHeatmap(cells, { autoScroll = false } = {}) {
      const grid = document.getElementById('heatmap-grid');
      if (!grid) return;
      grid.innerHTML = '';
      if (!Array.isArray(cells) || cells.length === 0) return;

      const metricVal = (c) => (heatMetric === 'count' ? c.count : heatMetric === 'cost' ? c.costUsd : c.tokens) || 0;
      let maxVal = 0;
      for (const c of cells) maxVal = Math.max(maxVal, metricVal(c));

      const weeks = [];
      for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

      let prevMonth = '';
      for (const colCells of weeks) {
        const col = document.createElement('div');
        col.className = 'heat-col';
        const firstDate = colCells[0]?.date || '';
        const ym = firstDate.slice(0, 7);
        const mLabel = document.createElement('div');
        mLabel.className = 'heat-month';
        if (ym && ym !== prevMonth) {
          mLabel.textContent = `${Number(ym.slice(5))}月`;
          prevMonth = ym;
        }
        col.appendChild(mLabel);

        for (const cell of colCells) {
          const val = metricVal(cell);
          const lvl = val > 0 && maxVal > 0 ? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(val / maxVal) * 4))) : 0;
          const el = document.createElement('button');
          el.type = 'button';
          el.className =
            'heat-cell' +
            (cell.isToday ? ' is-today' : '') +
            (selectedHeatDate === cell.date ? ' is-selected' : '');
          el.setAttribute('data-l', String(lvl));
          el.setAttribute('data-date', cell.date);
          el.setAttribute('aria-label', `${cell.date}: ${cell.count} 次 · ${fmtTokens(cell.tokens)} Token`);
          el.addEventListener('mouseenter', () => showHeatTooltip(cell, el));
          el.addEventListener('focus', () => showHeatTooltip(cell, el));
          el.addEventListener('mouseleave', hideHeatTooltip);
          el.addEventListener('blur', hideHeatTooltip);
          el.addEventListener('click', () => {
            selectedHeatDate = selectedHeatDate === cell.date ? '' : cell.date;
            loadedLimit = PAGE_SIZE;
            void refresh({ syncSsh: false, preserveScroll: false });
          });
          col.appendChild(el);
        }
        grid.appendChild(col);
      }
      if (autoScroll) scrollHeatmapToToday();
    }

    function renderActiveFilterChips() {
      const box = document.getElementById('req-active-chips');
      if (!box) return;
      box.innerHTML = '';
      if (selectedHeatDate) {
        const chip = document.createElement('span');
        chip.className = 'filter-chip';
        chip.innerHTML = `<span>📅 ${escapeHtml(selectedHeatDate)}${lastTodaySummary?.date === selectedHeatDate ? '（今日）' : ''}</span><button type="button" aria-label="清除日期">×</button>`;
        chip.querySelector('button').addEventListener('click', () => {
          selectedHeatDate = '';
          loadedLimit = PAGE_SIZE;
          void refresh({ syncSsh: false });
        });
        box.appendChild(chip);
      }
      if (selectedConvoId) {
        const chip = document.createElement('span');
        chip.className = 'filter-chip';
        chip.innerHTML = `<span>💬 ${escapeHtml(selectedConvoTitle || selectedConvoId.slice(0, 8))}</span><button type="button" aria-label="清除会话">×</button>`;
        chip.querySelector('button').addEventListener('click', () => {
          selectedConvoId = '';
          selectedConvoTitle = '';
          loadedLimit = PAGE_SIZE;
          void refresh({ syncSsh: false });
        });
        box.appendChild(chip);
      }
    }

    function syncAutoButton() {
      const btn = document.getElementById('btn-dash-auto');
      if (!btn) return;
      btn.classList.toggle('is-on', autoRefresh);
      btn.innerHTML = `<span class="auto-dot"></span><span>${autoRefresh ? '自动刷新 5s' : '已暂停刷新'}</span>`;
    }

    async function refresh({ syncSsh = false, preserveScroll = true, silent = false } = {}) {
      if (inflight) return;
      inflight = true;
      const range = document.getElementById('dash-range').value;
      const model = document.getElementById('dash-model').value;
      const search = document.getElementById('dash-search').value;
      const reqListEl = document.getElementById('req-list');
      const prevScrollTop = preserveScroll && reqListEl ? reqListEl.scrollTop : 0;

      try {
        const res = await app.apiFetch('/api/telemetry', {
          method: 'POST',
          body: JSON.stringify({
            range,
            date: selectedHeatDate,
            conversationId: selectedConvoId,
            status: selectedStatus,
            model,
            search,
            offset: 0,
            limit: loadedLimit,
            syncSsh,
          }),
        });
        const d = await res.json();
        if (!d || !d.ok) return;

        document.getElementById('kpi-reqs').textContent = String(d.summary.totalRequests);
        document.getElementById('kpi-errs').textContent = d.summary.errorCount > 0 ? `报错 ${d.summary.errorCount}` : '无报错';
        document.getElementById('kpi-tokens').textContent = fmtTokens(d.summary.totalTokens);
        document.getElementById('kpi-cost').textContent = `参考费用 $${d.summary.totalCostUsd.toFixed(3)}`;
        document.getElementById('kpi-cache').textContent = `${d.summary.cacheHitPct}%`;
        const anomEl = document.getElementById('kpi-anomaly');
        anomEl.textContent = d.summary.anomalyCount > 0 ? `⚠ 掉缓存异常 ${d.summary.anomalyCount} 次` : '缓存正常';
        anomEl.className = 'kpi-sub' + (d.summary.anomalyCount > 0 ? ' warn' : '');
        document.getElementById('kpi-src').textContent = d.ssh?.enabled ? `本机 + SSH (${d.ssh.count})` : '本机';
        const latEl = document.getElementById('kpi-latency');
        if (latEl) {
          latEl.textContent = Number.isFinite(d.summary.avgResponseMs)
            ? `平均响应 ${fmtDuration(d.summary.avgResponseMs)}`
            : '平均响应 -';
        }

        const updEl = document.getElementById('dash-updated');
        if (updEl) {
          const dt = new Date(d.updatedAtMs || Date.now());
          updEl.textContent = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }

        const modelSel = document.getElementById('dash-model');
        const prevModel = modelSel.value;
        modelSel.innerHTML = '<option value="">全部模型</option>';
        for (const m of d.availableModels || []) {
          const o = document.createElement('option');
          o.value = m;
          o.textContent = m;
          if (m === prevModel) o.selected = true;
          modelSel.appendChild(o);
        }

        lastTodaySummary = d.todaySummary || null;
        const todayText = document.getElementById('heat-today-text');
        const filterTodayBtn = document.getElementById('btn-filter-today');
        if (lastTodaySummary) {
          const td = lastTodaySummary;
          todayText.innerHTML = td.count > 0
            ? `今日 <b>${td.count} 次</b> · ${fmtTokens(td.tokens)} tok · 缓存 ${td.cacheHitPct}% · $${Number(td.costUsd || 0).toFixed(2)}`
            : `今日 (${td.date.slice(5)}) <span class="muted">暂无请求</span>`;
          filterTodayBtn.textContent = selectedHeatDate === td.date ? '已选今日 ×' : '只看今日';
        }

        renderActiveFilterChips();

        const isFirstHeat = lastHeatCells.length === 0;
        lastHeatCells = d.heatmap || [];
        const activeDays = lastHeatCells.filter((c) => c.count > 0).length;
        document.getElementById('heat-summary').textContent = `活跃 ${activeDays} 天`;
        renderHeatmap(lastHeatCells, { autoScroll: isFirstHeat });

        const pag = d.pagination || { totalFiltered: (d.requests || []).length, returned: (d.requests || []).length, hasMore: false };
        document.getElementById('req-count').textContent =
          pag.totalFiltered > pag.returned ? `${pag.returned} / 共 ${pag.totalFiltered} 条` : `共 ${pag.totalFiltered} 条`;

        reqListEl.innerHTML = '';
        if (!d.requests || d.requests.length === 0) {
          reqListEl.innerHTML = '<div style="text-align:center;color:var(--muted-fg);padding:16px 0;">暂无匹配请求记录</div>';
        } else {
          for (const r of d.requests) {
            const card = document.createElement('div');
            card.className = 'req-item' + (r.anomaly ? ' is-anomaly' : r.status === 'error' ? ' is-error' : '');
            const isSsh = r.source && r.source !== 'local';
            const srcLabel = isSsh ? `SSH:${r.source}` : '本机';
            const shortCid = r.conversationId ? `#${String(r.conversationId).slice(0, 8)}` : '';
            const convoTitle = r.conversationTitle || shortCid || '未知会话';
            const dropHtml = r.anomaly
              ? `<div class="req-badge-drop">⚠ 短间隔掉缓存 (${r.anomaly.gapSec}s): ${r.anomaly.prevHit}% → ${r.anomaly.curHit}%</div>`
              : '';
            const errHtml = r.errorText ? `<div style="color:var(--danger);font-size:11px;">${escapeHtml(r.errorText)}</div>` : '';
            const respStr = Number.isFinite(r.responseMs) ? fmtDuration(r.responseMs) : '';
            card.innerHTML = `
              <div class="req-top">
                <span class="req-model" title="${escapeHtml(r.model)}">${escapeHtml(r.model)}</span>
                <span class="req-time">${respStr ? `⏱ ${respStr} · ` : ''}${fmtDateTime(r.timestampMs)}</span>
              </div>
              <div class="req-source-row">
                <span class="req-src-tag${isSsh ? ' is-ssh' : ''}">${escapeHtml(srcLabel)}</span>
                <button type="button" class="req-convo-btn" title="点击按会话筛选 · ${escapeHtml(convoTitle)} (${escapeHtml(r.conversationId || '')})">💬 ${escapeHtml(convoTitle)} <span style="opacity:.65;">${escapeHtml(shortCid)}</span></button>
              </div>
              <div class="req-meta">
                <span>In ${fmtTokens(r.inputTokens)}</span>
                <span>Cache ${r.cacheHitPct}%</span>
                <span>Out ${fmtTokens(r.outputTokens)}</span>
                ${respStr ? `<span>响应 ${respStr}</span>` : ''}
                <span>$${Number(r.costUsd || 0).toFixed(4)}</span>
              </div>
              ${dropHtml}${errHtml}
            `;
            card.querySelector('.req-convo-btn').addEventListener('click', () => {
              if (!r.conversationId) return;
              if (selectedConvoId === r.conversationId) {
                selectedConvoId = '';
                selectedConvoTitle = '';
              } else {
                selectedConvoId = r.conversationId;
                selectedConvoTitle = convoTitle;
              }
              loadedLimit = PAGE_SIZE;
              void refresh({ syncSsh: false, preserveScroll: false });
            });
            reqListEl.appendChild(card);
          }
          if (preserveScroll && prevScrollTop > 0) reqListEl.scrollTop = prevScrollTop;
        }

        const pager = document.getElementById('req-pager');
        pager.innerHTML = '';
        if (pag.hasMore) {
          const remain = Math.max(0, pag.totalFiltered - pag.returned);
          const moreBtn = document.createElement('button');
          moreBtn.type = 'button';
          moreBtn.textContent = `加载更多 (+${Math.min(PAGE_SIZE, remain)}，剩余 ${remain} 条)`;
          moreBtn.addEventListener('click', () => {
            loadedLimit = Math.min(2000, loadedLimit + PAGE_SIZE);
            void refresh({ syncSsh: false, preserveScroll: true });
          });
          const allBtn = document.createElement('button');
          allBtn.type = 'button';
          allBtn.textContent = pag.totalFiltered <= 2000 ? `展开全部 (${pag.totalFiltered})` : '展开前 2000 条';
          allBtn.addEventListener('click', () => {
            loadedLimit = Math.min(2000, pag.totalFiltered);
            void refresh({ syncSsh: false, preserveScroll: true });
          });
          pager.style.display = 'flex';
          pager.appendChild(moreBtn);
          pager.appendChild(allBtn);
        } else {
          pager.style.display = 'none';
        }
      } catch (err) {
        if (!silent) app.showToast(`看板加载失败: ${err.message}`);
      } finally {
        inflight = false;
      }
    }

    function startAutoPoll() {
      stopAutoPoll();
      if (!autoRefresh) return;
      autoTimer = setInterval(() => {
        if (document.visibilityState !== 'hidden' && app.getActiveTab() === 'dashboard') {
          void refresh({ syncSsh: false, preserveScroll: true, silent: true });
        }
      }, 5000);
    }

    function stopAutoPoll() {
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
      }
    }

    // Bind events
    document.getElementById('dash-range').addEventListener('change', () => {
      selectedHeatDate = '';
      loadedLimit = PAGE_SIZE;
      void refresh({ syncSsh: false, preserveScroll: false });
    });
    document.getElementById('dash-model').addEventListener('change', () => {
      loadedLimit = PAGE_SIZE;
      void refresh({ syncSsh: false, preserveScroll: false });
    });
    document.getElementById('req-status-pills').querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedStatus = btn.getAttribute('data-status') || 'all';
        document.getElementById('req-status-pills').querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b === btn));
        loadedLimit = PAGE_SIZE;
        void refresh({ syncSsh: false, preserveScroll: false });
      });
    });
    let searchTimer = null;
    document.getElementById('dash-search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        loadedLimit = PAGE_SIZE;
        void refresh({ syncSsh: false, preserveScroll: false });
      }, 220);
    });
    document.getElementById('btn-dash-refresh').addEventListener('click', () => void refresh({ syncSsh: true, preserveScroll: true }));
    document.getElementById('btn-dash-auto').addEventListener('click', () => {
      autoRefresh = !autoRefresh;
      syncAutoButton();
      if (autoRefresh) startAutoPoll();
      else stopAutoPoll();
    });
    document.getElementById('heat-metric-seg').querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        heatMetric = btn.getAttribute('data-metric') || 'tokens';
        document.getElementById('heat-metric-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b === btn));
        renderHeatmap(lastHeatCells, { autoScroll: false });
      });
    });
    document.getElementById('btn-heat-today').addEventListener('click', () => {
      scrollHeatmapToToday();
      if (lastTodaySummary) {
        const todayCell = document.querySelector('#heatmap-grid .heat-cell.is-today');
        if (todayCell) {
          showHeatTooltip(lastTodaySummary, todayCell);
          setTimeout(hideHeatTooltip, 2600);
        }
      }
    });
    document.getElementById('btn-filter-today').addEventListener('click', () => {
      if (!lastTodaySummary) return;
      selectedHeatDate = selectedHeatDate === lastTodaySummary.date ? '' : lastTodaySummary.date;
      loadedLimit = PAGE_SIZE;
      scrollHeatmapToToday();
      void refresh({ syncSsh: false, preserveScroll: false });
    });
    document.getElementById('heat-head').addEventListener('click', () => {
      document.getElementById('sec-heatmap').classList.toggle('collapsed');
    });
    document.getElementById('heatmap-wrap').addEventListener('scroll', hideHeatTooltip, { passive: true });

    syncAutoButton();
    startAutoPoll();

    return {
      onActivate() {
        void refresh({ syncSsh: false, preserveScroll: true });
        scrollHeatmapToToday();
      },
      refresh,
    };
  };
})(window);
