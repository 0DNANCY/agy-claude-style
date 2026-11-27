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
    let lastWeeklyQuota = null;
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
    let reqSeq = 0;
    let queuedRefresh = null;

    function scrollHeatmapToToday() {
      const wrap = document.getElementById('heatmap-wrap');
      if (!wrap) return;
      requestAnimationFrame(() => {
        wrap.scrollLeft = wrap.scrollWidth;
      });
    }

    function shortPoolName(name = '') {
      const cleaned = String(name || '')
        .replace(/\s*\([^)]*\)\s*/g, '')
        .replace(/\s*models?\s*/gi, '')
        .replace(/\s+and\s+/gi, ' / ')
        .trim();
      return cleaned || String(name || '');
    }

    function renderPricingMeta(meta) {
      const btn = document.getElementById('btn-dash-pricing');
      const costEl = document.getElementById('kpi-cost');
      if (!btn) return;
      if (!meta || meta.source !== 'online') {
        btn.classList.remove('is-synced');
        btn.textContent = '$ 单价';
        btn.title = meta?.lastError
          ? `当前使用内置参考单价（上次同步失败：${meta.lastError}），点击重试在线同步`
          : '当前使用内置参考单价，点击在线同步官方 API 参考单价';
        if (costEl) costEl.title = '内置参考单价';
        return;
      }
      btn.classList.add('is-synced');
      btn.textContent = '$ 官方';
      const syncTime = meta.updatedAtMs ? fmtDateTime(meta.updatedAtMs) : '';
      const tip = `已同步 ${meta.sourceName || '官方单价'}（${meta.modelCount || 0} 模型${syncTime ? ` · ${syncTime}` : ''}），点击手动刷新`;
      btn.title = tip;
      if (costEl) costEl.title = tip;
    }

    function renderModelHealth(health) {
      const listEl = document.getElementById('health-list');
      const badgeEl = document.getElementById('health-summary');
      if (!listEl || !badgeEl) return;
      const models = Array.isArray(health?.models) ? health.models : [];
      if (models.length === 0) {
        badgeEl.textContent = '暂无数据';
        listEl.innerHTML = '<div style="text-align:center;color:var(--muted-fg);padding:10px 0;font-size:11px;">当前时间范围内无模型请求</div>';
        return;
      }
      const errModels = models.filter((m) => m.overallStatus === 'err').length;
      const warnModels = models.filter((m) => m.overallStatus === 'warn').length;
      badgeEl.textContent =
        errModels > 0
          ? `${errModels} 异常 · ${models.length} 模型`
          : warnModels > 0
          ? `${warnModels} 波动 · ${models.length} 模型`
          : `全部正常 · ${models.length} 模型`;

      listEl.innerHTML = '';
      for (const m of models) {
        const row = document.createElement('div');
        row.className = 'health-row';
        const shownTtft = Number.isFinite(m.medianTtftMs) ? m.medianTtftMs : m.avgTtftMs;
        const ttftTxt = Number.isFinite(shownTtft)
          ? `${Number.isFinite(m.medianTtftMs) ? 'P50 首字' : '首字'} ${fmtDuration(shownTtft)}`
          : '';
        const errTag = m.errorCount > 0 ? `<span class="health-pill is-err">报错 ${m.errorCount}${m.topError ? ` (${escapeHtml(m.topError)})` : ''}</span>` : '';
        const dropTag = m.anomalyCount > 0 ? `<span class="health-pill is-warn">掉缓存 ${m.anomalyCount}</span>` : '';
        const slotsHtml = (m.slots || [])
          .map((s) => {
            const win = `${fmtDateTime(s.startMs).slice(0, 11)} ~ ${fmtDateTime(s.endMs).slice(6, 11)}`;
            const detail =
              s.count > 0
                ? `${win} · ${s.count} 次${s.errors ? ` · 报错 ${s.errors}` : ''}${s.anomalies ? ` · 掉缓存 ${s.anomalies}` : ''}${Number.isFinite(s.avgTtftMs) ? ` · 首字 ${fmtDuration(s.avgTtftMs)}` : ''}`
                : `${win} · 无请求`;
            return `<span class="health-slot is-${escapeHtml(s.status)}" title="${escapeHtml(detail)}"></span>`;
          })
          .join('');
        row.innerHTML = `
          <div class="health-top">
            <button type="button" class="health-model-btn" title="点击按该模型筛选下方请求记录">
              <span class="health-dot is-${escapeHtml(m.overallStatus)}"></span>
              <span class="health-name">${escapeHtml(m.model)}</span>
            </button>
            <span class="health-rate">${m.successRatePct}% · ${m.requests}次</span>
          </div>
          <div class="health-slots">${slotsHtml}</div>
          <div class="health-meta">
            ${ttftTxt ? `<span>${escapeHtml(ttftTxt)}</span>` : ''}
            ${errTag}${dropTag}
          </div>
        `;
        row.querySelector('.health-model-btn').addEventListener('click', () => {
          const sel = document.getElementById('dash-model');
          if (!sel) return;
          sel.value = sel.value === m.model ? '' : m.model;
          loadedLimit = PAGE_SIZE;
          void refresh({ syncSsh: false, preserveScroll: false });
        });
        listEl.appendChild(row);
      }
    }

    function renderModelsBreakdown(models = []) {
      const wrapEl = document.getElementById('models-table-wrap');
      const badgeEl = document.getElementById('models-summary');
      if (!wrapEl || !badgeEl) return;
      const list = Array.isArray(models) ? models : [];
      badgeEl.textContent = `${list.length} 模型`;
      if (list.length === 0) {
        wrapEl.innerHTML = '<div style="text-align:center;color:var(--muted-fg);padding:8px 0;font-size:11px;">当前范围内无模型统计</div>';
        return;
      }
      const activeModel = document.getElementById('dash-model')?.value || '';
      const hasTps = list.some((m) => Number.isFinite(m.decodeTps));
      const rowsHtml = list
        .map((m) => {
          const hit = m.cacheHitPct;
          const hitCls = hit === null || hit === undefined ? '' : hit >= 70 ? ' is-high' : hit >= 30 ? ' is-mid' : ' is-low';
          const hitTxt = hit === null || hit === undefined ? '-' : `${hit}%`;
          const ttftTxt = Number.isFinite(m.medianTtftMs) ? fmtDuration(m.medianTtftMs) : '-';
          const tpsTxt = Number.isFinite(m.decodeTps) ? `${m.decodeTps}` : '-';
          const activeCls = activeModel && activeModel === m.model ? ' class="is-active"' : '';
          const tip = `${m.model} · 请求 ${m.requests} 次 · 输入 ${fmtTokens(m.inputTokens)} · 缓存读 ${fmtTokens(m.cacheReadTokens)} · 输出 ${fmtTokens(m.outputTokens)}${Number.isFinite(m.e2eTps) ? ` · E2E ${m.e2eTps} tok/s` : ''}`;
          return `
            <tr data-model="${escapeHtml(m.model)}"${activeCls} title="${escapeHtml(tip)}">
              <td>${escapeHtml(m.model)}</td>
              <td>${m.requests}</td>
              <td>${fmtTokens(m.totalTokens || (m.inputTokens || 0) + (m.outputTokens || 0))}</td>
              <td><span class="models-cache-pill${hitCls}">${hitTxt}</span></td>
              <td>${ttftTxt}</td>
              ${hasTps ? `<td>${tpsTxt}</td>` : ''}
              <td>$${Number(m.costUsd || 0).toFixed(3)}</td>
            </tr>
          `;
        })
        .join('');
      wrapEl.innerHTML = `
        <table class="models-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>次数</th>
              <th>Token</th>
              <th>缓存率</th>
              <th>P50首字</th>
              ${hasTps ? '<th>tok/s</th>' : ''}
              <th>费用</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `;
      wrapEl.querySelectorAll('tbody tr').forEach((tr) => {
        tr.addEventListener('click', () => {
          const mName = tr.getAttribute('data-model') || '';
          const sel = document.getElementById('dash-model');
          if (!sel || !mName) return;
          sel.value = sel.value === mName ? '' : mName;
          loadedLimit = PAGE_SIZE;
          void refresh({ syncSsh: false, preserveScroll: false });
        });
      });
    }

    function renderWeeklyQuotaCard(wq) {
      const labelEl = document.getElementById('kpi-weekly-label');
      const poolsEl = document.getElementById('kpi-weekly-pools');
      const subEl = document.getElementById('kpi-weekly-sub');
      if (!poolsEl || !subEl) return;
      if (!wq) {
        if (labelEl) labelEl.textContent = '当日消耗周额度';
        poolsEl.innerHTML = '<span class="kpi-val" style="font-size:13px;color:var(--muted-fg);">待面板服务重载</span>';
        subEl.textContent = '开关插件或重启 Antigravity 后启用';
        return;
      }

      // When filtering a specific historical date via heatmap click, show that date's snapshot
      const isHistoricalDate = Boolean(selectedHeatDate && selectedHeatDate !== wq.date);
      if (isHistoricalDate) {
        if (labelEl) labelEl.textContent = `当日消耗周额度 · ${selectedHeatDate}`;
        const dayRec = wq.byDate?.[selectedHeatDate];
        if (!dayRec || !Array.isArray(dayRec.pools) || dayRec.pools.length === 0) {
          poolsEl.innerHTML = '<span class="kpi-val" style="font-size:13px;color:var(--muted-fg);">无采样数据</span>';
          subEl.textContent = '该日期暂无周额度记录';
          return;
        }
        subEl.textContent = '按日筛选历史快照';
        poolsEl.innerHTML = dayRec.pools
          .map((p) => {
            const burned = Number(p.consumedPct ?? p.consumedTodayPct ?? 0);
            const hasRem = typeof p.lastPct === 'number';
            const rem = hasRem ? Number(p.lastPct) : null;
            const cls = burned > 0 ? ' is-burned' : '';
            return `
              <div class="kpi-weekly-pill${cls}" title="${escapeHtml(p.name)}：${selectedHeatDate} 消耗 ${burned.toFixed(1)}% 周额度${hasRem ? `，当日末次采样剩余 ${rem.toFixed(1)}%` : ''}">
                <span class="kw-name">${escapeHtml(shortPoolName(p.name))}</span>
                <span class="kw-burn">-${burned.toFixed(1)}%</span>
                ${hasRem ? `<span class="kw-rem">余 ${rem.toFixed(0)}%</span>` : ''}
              </div>
            `;
          })
          .join('');
        return;
      }

      if (labelEl) labelEl.textContent = selectedHeatDate ? `当日消耗周额度 · 今日` : '当日消耗周额度';
      if (!wq.available || !Array.isArray(wq.pools) || wq.pools.length === 0) {
        poolsEl.innerHTML = '<span class="kpi-val" style="font-size:13.5px;color:var(--muted-fg);">暂无周额度数据</span>';
        subEl.textContent = '仅订阅配额模式可用';
        return;
      }
      const pools = wq.pools;
      const acctSuffix = wq.accountLabel ? ` · ${wq.accountLabel}` : '';
      const resetNote = pools.find((p) => p.resetIn)?.resetIn;
      subEl.textContent = resetNote
        ? `重置 ${resetNote} · 仅统计本机${acctSuffix}`
        : `仅统计本机消耗${acctSuffix}`;
      poolsEl.innerHTML = pools
        .map((p) => {
          const burned = Number(p.consumedTodayPct || 0);
          const rem = Number(p.remainingPct || 0);
          const cls = burned > 0 ? ' is-burned' : '';
          return `
            <div class="kpi-weekly-pill${cls}" title="${escapeHtml(p.name)}：今日已消耗 ${burned.toFixed(1)}% 周额度，当前剩余 ${rem.toFixed(1)}%${p.resetIn ? `（${p.resetIn}后重置）` : ''}">
              <span class="kw-name">${escapeHtml(shortPoolName(p.name))}</span>
              <span class="kw-burn">-${burned.toFixed(1)}%</span>
              <span class="kw-rem">剩 ${rem.toFixed(0)}%</span>
            </div>
          `;
        })
        .join('');
    }

    function showHeatTooltip(cell, targetEl) {
      const tip = document.getElementById('heat-tooltip');
      if (!tip || !cell) return;
      const flags = [];
      if (cell.errorCount > 0) {
        flags.push(`<span class="heat-tt-badge is-err">报错 ${cell.errorCount}</span>`);
      }
      if (cell.anomalyCount > 0) {
        flags.push(`<span class="heat-tt-badge is-warn">掉缓存 ${cell.anomalyCount}</span>`);
      }
      const flagsHtml = flags.length > 0 ? `<div class="heat-tt-badges">${flags.join('')}</div>` : '';

      const dayQuota = lastWeeklyQuota?.byDate?.[cell.date];
      const quotaSection =
        dayQuota && Array.isArray(dayQuota.pools) && dayQuota.pools.length > 0
          ? `<div class="heat-tt-sec">
              <div class="heat-tt-sec-title">周额度消耗</div>
              ${dayQuota.pools
                .map((p) => {
                  const burned = Number(p.consumedPct ?? p.consumedTodayPct ?? 0);
                  const burnedCls = burned > 0 ? ' is-burned' : ' is-zero';
                  const remPart =
                    typeof p.lastPct === 'number'
                      ? `<span class="heat-tt-rem">剩 ${Math.round(p.lastPct)}%</span>`
                      : '';
                  return `<div class="heat-tt-row">
                    <span class="heat-tt-k">${escapeHtml(shortPoolName(p.name))}</span>
                    <span class="heat-tt-v${burnedCls}">-${burned.toFixed(1)}%${remPart}</span>
                  </div>`;
                })
                .join('')}
            </div>`
          : '';

      tip.innerHTML = `
        <div class="heat-tt-date">
          <span>${cell.date}</span>
          ${cell.isToday ? '<span class="heat-tt-tag">今天</span>' : ''}
        </div>
        <div class="heat-tt-rows">
          <div class="heat-tt-row"><span class="heat-tt-k">请求次数</span><span class="heat-tt-v">${cell.count} 次</span></div>
          <div class="heat-tt-row"><span class="heat-tt-k">总 Token</span><span class="heat-tt-v">${fmtTokens(cell.tokens)}</span></div>
          <div class="heat-tt-row"><span class="heat-tt-k">缓存命中</span><span class="heat-tt-v">${cell.count > 0 ? cell.cacheHitPct + '%' : '-'}</span></div>
          <div class="heat-tt-row"><span class="heat-tt-k">参考费用</span><span class="heat-tt-v">$${Number(cell.costUsd || 0).toFixed(3)}</span></div>
        </div>
        ${flagsHtml}
        ${quotaSection}
        <div class="heat-tt-hint">${selectedHeatDate === cell.date ? '再次点击取消按日筛选' : '点击筛选当日请求记录'}</div>
      `;
      tip.classList.add('show');
      const rect = targetEl.getBoundingClientRect();
      const tw = tip.offsetWidth || 216;
      const th = tip.offsetHeight || 130;
      let left = rect.left + rect.width / 2 - tw / 2;
      left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));
      let top = rect.top - th - 10;
      if (top < 8) top = rect.bottom + 10;
      if (top + th > window.innerHeight - 8) top = Math.max(8, window.innerHeight - th - 8);
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
      btn.innerHTML = `<span class="auto-dot"></span><span>${autoRefresh ? '自动刷新 8s' : '已暂停刷新'}</span>`;
    }

    async function refresh({ syncSsh = false, preserveScroll = true, silent = false } = {}) {
      if (inflight) {
        // Coalesce user-triggered refreshes/filters instead of silently dropping them during 8s auto-poll.
        if (!silent) {
          queuedRefresh = {
            syncSsh: Boolean(queuedRefresh?.syncSsh || syncSsh),
            preserveScroll: Boolean(queuedRefresh ? queuedRefresh.preserveScroll && preserveScroll : preserveScroll),
            silent: false,
          };
        }
        return;
      }
      inflight = true;
      const mySeq = ++reqSeq;
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
        if (mySeq !== reqSeq || !d || !d.ok) return;

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
          const p50 = d.summary.medianTtftMs;
          const avg = d.summary.avgTtftMs;
          const tps = d.summary.decodeTps;
          const parts = [];
          if (Number.isFinite(p50)) parts.push(`P50 首字 ${fmtDuration(p50)}`);
          else if (Number.isFinite(avg)) parts.push(`平均首字 ${fmtDuration(avg)}`);
          if (Number.isFinite(tps)) parts.push(`${tps} tok/s`);
          latEl.textContent = parts.length ? parts.join(' · ') : '首字 -';
          latEl.title = [
            Number.isFinite(p50) ? `首字 P50：${fmtDuration(p50)}` : '',
            Number.isFinite(avg) ? `首字均值：${fmtDuration(avg)}` : '',
            Number.isFinite(tps) ? `加权解码速率：${tps} tok/s` : '',
            Number.isFinite(d.summary.e2eTps) ? `端到端速率：${d.summary.e2eTps} tok/s` : '',
          ]
            .filter(Boolean)
            .join(' · ');
        }

        const updEl = document.getElementById('dash-updated');
        if (updEl) {
          const dt = new Date(d.updatedAtMs || Date.now());
          updEl.textContent = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }

        const modelSel = document.getElementById('dash-model');
        const prevModel = modelSel.value;
        const availModels = d.availableModels || [];
        modelSel.innerHTML = '<option value="">全部模型</option>';
        let foundPrevModel = !prevModel;
        for (const m of availModels) {
          const o = document.createElement('option');
          o.value = m;
          o.textContent = m;
          if (m === prevModel) {
            o.selected = true;
            foundPrevModel = true;
          }
          modelSel.appendChild(o);
        }
        if (prevModel && !foundPrevModel) {
          modelSel.value = '';
          if (!queuedRefresh) {
            queuedRefresh = { syncSsh: false, preserveScroll: false, silent: true };
          }
        }

        lastTodaySummary = d.todaySummary || null;
        lastWeeklyQuota = d.weeklyQuota || null;
        renderPricingMeta(d.pricing || null);
        renderModelHealth(d.modelHealth || null);
        renderModelsBreakdown(d.modelsBreakdown || []);
        renderWeeklyQuotaCard(lastWeeklyQuota);
        const nowSubMs = Date.now();
        if (!silent || nowSubMs - lastSubagentFetchAt >= 8000) {
          lastSubagentFetchAt = nowSubMs;
          void refreshSubagents();
        }
        const todayText = document.getElementById('heat-today-text');
        const filterTodayBtn = document.getElementById('btn-filter-today');
        if (lastTodaySummary) {
          const td = lastTodaySummary;
          const burnedPools =
            lastWeeklyQuota?.available && Array.isArray(lastWeeklyQuota.pools)
              ? lastWeeklyQuota.pools.filter((p) => Number(p.consumedTodayPct || 0) > 0)
              : [];
          const todayBurnPart =
            burnedPools.length > 0
              ? ` · 周额度 ${burnedPools.map((p) => `${shortPoolName(p.name)} -${Number(p.consumedTodayPct || 0).toFixed(1)}%`).join(' / ')}`
              : lastWeeklyQuota?.available && lastWeeklyQuota.pools?.length
              ? ' · 周额度 -0.0%'
              : '';
          todayText.innerHTML = td.count > 0
            ? `今日 <b>${td.count} 次</b> · ${fmtTokens(td.tokens)} tok · 缓存 ${td.cacheHitPct}% · $${Number(td.costUsd || 0).toFixed(2)}${escapeHtml(todayBurnPart)}`
            : `今日 (${td.date.slice(5)}) <span class="muted">暂无请求</span>${escapeHtml(todayBurnPart)}`;
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
            const srcName = isSsh ? String(r.source).replace(/^ssh:/i, '') : '';
            const srcLabel = isSsh ? `SSH:${srcName}` : '本机';
            const shortCid = r.conversationId ? `#${String(r.conversationId).slice(0, 8)}` : '';
            const convoTitle = r.conversationTitle || shortCid || '未知会话';
            const dropHtml = r.anomaly
              ? `<div class="req-badge-drop">⚠ 短间隔掉缓存 (${r.anomaly.gapSec}s): ${r.anomaly.prevHit}% → ${r.anomaly.curHit}%</div>`
              : '';
            const errHtml = r.errorText ? `<div style="color:var(--danger);font-size:11px;">${escapeHtml(r.errorText)}</div>` : '';
            const ttftStr = Number.isFinite(r.ttftMs) ? fmtDuration(r.ttftMs) : '';
            card.innerHTML = `
              <div class="req-top">
                <span class="req-model" title="${escapeHtml(r.model)}">${escapeHtml(r.model)}</span>
                <span class="req-time">${ttftStr ? `首字 ${ttftStr} · ` : ''}${fmtDateTime(r.timestampMs)}</span>
              </div>
              <div class="req-source-row">
                <span class="req-src-tag${isSsh ? ' is-ssh' : ''}">${escapeHtml(srcLabel)}</span>
                <button type="button" class="req-convo-btn" title="点击按会话筛选 · ${escapeHtml(convoTitle)} (${escapeHtml(r.conversationId || '')})">💬 ${escapeHtml(convoTitle)} <span style="opacity:.65;">${escapeHtml(shortCid)}</span></button>
              </div>
              <div class="req-meta">
                <span>In ${fmtTokens(r.inputTokens)}</span>
                <span>Cache ${r.cacheHitPct}%</span>
                <span>Out ${fmtTokens(r.outputTokens)}</span>
                ${ttftStr ? `<span>首字 ${ttftStr}</span>` : ''}
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
        if (queuedRefresh) {
          const nextOpts = queuedRefresh;
          queuedRefresh = null;
          void refresh(nextOpts);
        }
      }
    }

    let lastSubagentFetchAt = 0;
    function startAutoPoll() {
      stopAutoPoll();
      if (!autoRefresh) return;
      autoTimer = setInterval(() => {
        const visible = typeof app.isPanelVisible === 'function' ? app.isPanelVisible() : document.visibilityState !== 'hidden';
        if (visible && app.getActiveTab() === 'dashboard') {
          void refresh({ syncSsh: false, preserveScroll: true, silent: true });
        }
      }, 8000);
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
    let todayTipTimer = null;
    document.getElementById('btn-heat-today').addEventListener('click', () => {
      if (todayTipTimer) {
        clearTimeout(todayTipTimer);
        todayTipTimer = null;
      }
      scrollHeatmapToToday();
      requestAnimationFrame(() => {
        if (lastTodaySummary) {
          const todayCell = document.querySelector('#heatmap-grid .heat-cell.is-today');
          if (todayCell) {
            showHeatTooltip(lastTodaySummary, todayCell);
            todayTipTimer = setTimeout(() => {
              todayTipTimer = null;
              hideHeatTooltip();
            }, 2600);
          }
        }
      });
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
    const healthHead = document.getElementById('health-head');
    if (healthHead) {
      healthHead.addEventListener('click', () => {
        document.getElementById('sec-health').classList.toggle('collapsed');
      });
    }
    const modelsHead = document.getElementById('models-head');
    if (modelsHead) {
      modelsHead.addEventListener('click', () => {
        document.getElementById('sec-models')?.classList.toggle('collapsed');
      });
    }
    const subagentsHead = document.getElementById('subagents-head');
    if (subagentsHead) {
      subagentsHead.addEventListener('click', () => {
        document.getElementById('sec-subagents')?.classList.toggle('collapsed');
      });
    }

    function renderSubagentTree(tree) {
      const listEl = document.getElementById('subagent-list');
      const sumEl = document.getElementById('subagent-summary');
      if (!listEl || !sumEl) return;
      if (!tree || !tree.available) {
        sumEl.textContent = '未连接 LS';
        listEl.innerHTML = '<div style="text-align:center;color:var(--muted-fg);padding:8px 0;font-size:11px;">暂未连接到 Language Server，无法读取实时任务树</div>';
        return;
      }
      const items = [...(tree.running || []), ...(tree.recent || [])];
      const activeSubs = items.reduce((acc, it) => acc + (Number(it.activeSubagentCount) || 0), 0);
      sumEl.textContent =
        (tree.running?.length || 0) > 0
          ? `${tree.running.length} 运行中${activeSubs > 0 ? ` · ${activeSubs} 子代理` : ''}`
          : items.length > 0
          ? `空闲 · 最近 ${items.length} 个`
          : '暂无任务';

      if (items.length === 0) {
        listEl.innerHTML = '<div style="text-align:center;color:var(--muted-fg);padding:8px 0;font-size:11px;">暂无活跃或近期对话</div>';
        return;
      }

      listEl.innerHTML = '';
      for (const item of items) {
        const isRun = item.runState === 'RUN_STATE_RUNNING' || item.runState === 'RUN_STATE_CANCELLING';
        const card = document.createElement('div');
        card.className = 'subagent-tree-item';
        const head = document.createElement('div');
        head.className = 'subagent-tree-head';
        const title = document.createElement('span');
        title.className = 'subagent-tree-title';
        title.textContent = item.title || 'Untitled Conversation';
        title.title = `${item.title || ''} (${item.id || ''})`;
        const badge = document.createElement('span');
        badge.className = 'subagent-badge' + (isRun ? ' is-running' : '');
        badge.textContent = isRun
          ? `运行中${item.subagentCount ? ` · ${item.subagentCount} 子代理` : ''}`
          : item.subagentCount
          ? `${item.subagentCount} 子代理`
          : `${item.stepCount || 0} 步`;
        head.appendChild(title);
        head.appendChild(badge);
        card.appendChild(head);

        const subs = Array.isArray(item.subagents) ? item.subagents : [];
        if (subs.length > 0) {
          const children = document.createElement('div');
          children.className = 'subagent-tree-children';
          for (const sub of subs) {
            const row = document.createElement('div');
            row.className = 'subagent-child-row';
            const st = document.createElement('span');
            st.className = 'subagent-tree-title';
            st.textContent = `${sub.kind === 'swarm' ? '🐝' : '↳'} ${sub.title || 'Subagent'}`;
            const sb = document.createElement('span');
            sb.className =
              'subagent-badge' +
              (sub.state === 'running' || sub.state === 'cancelling'
                ? ' is-running'
                : sub.state === 'error'
                ? ' is-error'
                : sub.kind === 'swarm'
                ? ' is-swarm'
                : '');
            sb.textContent =
              sub.state === 'running'
                ? '运行中'
                : sub.state === 'cancelling'
                ? '停止中'
                : sub.state === 'error'
                ? '异常'
                : sub.state === 'stopped'
                ? '已中止'
                : `已完成 · ${sub.stepCount || 0}步`;
            row.appendChild(st);
            row.appendChild(sb);
            children.appendChild(row);
          }
          card.appendChild(children);
        }
        listEl.appendChild(card);
      }
    }

    async function refreshSubagents() {
      try {
        const res = await app.apiFetch('/api/subagents', { method: 'GET' });
        const tree = await res.json();
        renderSubagentTree(tree);
      } catch {}
    }
    const pricingBtn = document.getElementById('btn-dash-pricing');
    if (pricingBtn) {
      pricingBtn.addEventListener('click', async () => {
        const prevText = pricingBtn.textContent;
        pricingBtn.disabled = true;
        pricingBtn.textContent = '同步中…';
        try {
          const res = await app.apiFetch('/api/pricing/refresh', { method: 'POST', body: '{}' });
          const d = await res.json();
          if (d.ok) {
            app.showToast(`已同步官方单价（${d.modelCount || 0} 个模型）`);
            await refresh({ syncSsh: false, preserveScroll: true });
          } else {
            app.showToast(`单价同步失败，继续使用内置单价：${d.error || '网络异常'}`);
            renderPricingMeta(d);
          }
        } catch (err) {
          app.showToast(`单价同步异常：${err.message}`);
          if (pricingBtn.textContent === '同步中…') pricingBtn.textContent = prevText || '$ 单价';
        } finally {
          pricingBtn.disabled = false;
          if (pricingBtn.textContent === '同步中…') pricingBtn.textContent = prevText || '$ 单价';
        }
      });
    }
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
