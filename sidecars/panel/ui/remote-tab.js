// Tab 3: SSH Remote Telemetry & TUN-Free Proxy module for AGY Claude Style Aux Pane.
(function (root) {
  root.AGYPanelRemote = function initRemoteTab(app) {
    let lastSynced = { sshHost: '', proxyUrl: '', proxyBypass: 'localhost,127.0.0.1,::1' };
    function syncForm(cfg, { force = false, preserveDirty = false } = {}) {
      const paneEl = document.getElementById('pane-remote');
      const hasFocus = Boolean(paneEl && document.activeElement && paneEl.contains(document.activeElement));
      const inpSsh = document.getElementById('inp-ssh-host');
      const inpProxy = document.getElementById('inp-proxy-url');
      const inpBypass = document.getElementById('inp-proxy-bypass');

      const nextSsh = cfg.sshHost || '';
      const nextProxy = cfg.proxyUrl || '';
      const nextBypass = cfg.proxyBypass || 'localhost,127.0.0.1,::1';

      document.getElementById('sw-ssh-enabled').checked = Boolean(cfg.sshRemoteStats);
      if (force || !preserveDirty || (!hasFocus && inpSsh.value === lastSynced.sshHost)) {
        inpSsh.value = nextSsh;
        lastSynced.sshHost = nextSsh;
      }
      document.getElementById('ssh-badge').textContent = cfg.sshRemoteStats ? '已开启' : '关闭';

      document.getElementById('sw-proxy-enabled').checked = Boolean(cfg.proxyEnabled);
      if (force || !preserveDirty || (!hasFocus && inpProxy.value === lastSynced.proxyUrl)) {
        inpProxy.value = nextProxy;
        lastSynced.proxyUrl = nextProxy;
      }
      if (inpBypass && (force || !preserveDirty || (!hasFocus && inpBypass.value === lastSynced.proxyBypass))) {
        inpBypass.value = nextBypass;
        lastSynced.proxyBypass = nextBypass;
      }
      const h1El = document.getElementById('sw-proxy-h1');
      if (h1El) h1El.checked = cfg.proxyForceHttp1 !== false;
      document.getElementById('proxy-badge').textContent = cfg.proxyEnabled ? '已开启' : '关闭';

      const box = document.getElementById('proxy-runtime-box');
      const pr = app.getLastStatus?.()?.proxyRuntime;
      if (box) {
        if (!pr || !pr.inspected || (!pr.configured && !pr.active)) {
          box.style.display = 'none';
        } else if (pr.coldStartMismatch) {
          box.style.display = 'block';
          box.className = 'proxy-runtime-box is-warn';
          box.textContent = `⚠ ${pr.reason}。请点击下方「保存并重启生效」。`;
        } else if (pr.active) {
          box.style.display = 'block';
          box.className = 'proxy-runtime-box is-ok';
          box.textContent = `✓ 当前进程已生效独立代理：${pr.activeProxyMasked}${pr.forceHttp1Active ? ' · HTTP/1.1' : ''}`;
        } else {
          box.style.display = 'none';
        }
      }
    }

    async function loadSshHosts() {
      try {
        const res = await app.apiFetch('/api/ssh/hosts', { method: 'GET' });
        const d = await res.json();
        const dl = document.getElementById('ssh-host-list');
        dl.innerHTML = '';
        for (const h of d.hosts || []) {
          const o = document.createElement('option');
          o.value = h;
          dl.appendChild(o);
        }
      } catch {}
    }

    document.getElementById('sw-ssh-enabled').addEventListener('change', (ev) => app.saveOne('sshRemoteStats', ev.target.checked));
    document.getElementById('btn-ssh-save').addEventListener('click', () => app.saveOne('sshHost', document.getElementById('inp-ssh-host').value.trim()));
    document.getElementById('btn-ssh-sync').addEventListener('click', async () => {
      const host = document.getElementById('inp-ssh-host').value.trim();
      const saved = await app.saveUpdates({ sshHost: host, sshRemoteStats: true });
      const note = document.getElementById('ssh-note');
      if (!saved) {
        note.textContent = '同步失败：SSH 主机格式无效';
        return;
      }
      note.textContent = '正在通过 SSH 拉取远端统计…';
      try {
        const res = await app.apiFetch('/api/ssh/sync', { method: 'POST', body: JSON.stringify({ host }) });
        const rawText = await res.text();
        let d = null;
        if (rawText) {
          try { d = JSON.parse(rawText); } catch {}
        }
        if (!d) throw new Error(res.ok ? '服务端返回空响应（面板可能正在重启，请重试）' : `HTTP ${res.status}`);
        note.textContent = d.ok ? `同步成功：${d.host}（共 ${d.count} 条请求已并入看板）` : `同步失败：${d.error || '未知错误'}`;
      } catch (err) {
        note.textContent = `同步异常：${err.message}`;
      }
    });

    const saveProxyFields = async () => {
      const ok = await app.saveUpdates({
        proxyUrl: document.getElementById('inp-proxy-url').value.trim(),
        proxyBypass: document.getElementById('inp-proxy-bypass')?.value.trim() || 'localhost,127.0.0.1,::1',
      });
      if (ok && typeof app.refreshStatus === 'function') await app.refreshStatus();
      return ok;
    };

    document.getElementById('sw-proxy-enabled').addEventListener('change', async (ev) => {
      const ok = await app.saveUpdates({
        proxyEnabled: ev.target.checked,
        proxyUrl: document.getElementById('inp-proxy-url').value.trim(),
      });
      if (ok && typeof app.refreshStatus === 'function') await app.refreshStatus();
    });
    const inpProxyUrl = document.getElementById('inp-proxy-url');
    inpProxyUrl.addEventListener('change', saveProxyFields);
    inpProxyUrl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') saveProxyFields();
    });
    const inpProxyBypass = document.getElementById('inp-proxy-bypass');
    if (inpProxyBypass) inpProxyBypass.addEventListener('change', saveProxyFields);
    const swProxyH1 = document.getElementById('sw-proxy-h1');
    if (swProxyH1) {
      swProxyH1.addEventListener('change', async (ev) => {
        const ok = await app.saveOne('proxyForceHttp1', ev.target.checked);
        if (ok && typeof app.refreshStatus === 'function') await app.refreshStatus();
      });
    }
    document.getElementById('btn-proxy-test').addEventListener('click', async () => {
      const note = document.getElementById('proxy-note');
      const proxyUrl = document.getElementById('inp-proxy-url').value.trim();
      note.textContent = '正在测试代理连通性…';
      try {
        const res = await app.apiFetch('/api/proxy/test', { method: 'POST', body: JSON.stringify({ proxyUrl }) });
        const rawText = await res.text();
        let d = null;
        if (rawText) {
          try { d = JSON.parse(rawText); } catch {}
        }
        if (!d) throw new Error(res.ok ? '服务端返回空响应（面板可能正在重启，请重试）' : `HTTP ${res.status}`);
        note.textContent = d.ok ? `✓ 连通成功 (${d.host}:${d.port} · ${d.latencyMs}ms)` : `✕ 连通失败：${d.error || '无法连接'}`;
      } catch (err) {
        note.textContent = `✕ 测试异常：${err.message}`;
      }
    });
    let proxyRelaunchBusy = false;
    const btnProxyRelaunch = document.getElementById('btn-proxy-relaunch');
    btnProxyRelaunch.addEventListener('click', async () => {
      if (proxyRelaunchBusy) return;
      const note = document.getElementById('proxy-note');
      const proxyUrl = document.getElementById('inp-proxy-url').value.trim();
      if (!proxyUrl || !/^(?:https?|socks5h?):\/\/.+/i.test(proxyUrl)) {
        if (note) note.textContent = '✕ 请填写合法的代理地址（例如 http://127.0.0.1:7890）后再重启';
        return;
      }
      proxyRelaunchBusy = true;
      btnProxyRelaunch.disabled = true;
      try {
        const saved = await app.saveUpdates({
          proxyEnabled: true,
          proxyUrl,
          proxyBypass: document.getElementById('inp-proxy-bypass')?.value.trim() || 'localhost,127.0.0.1,::1',
          proxyForceHttp1: swProxyH1 ? swProxyH1.checked : true,
        });
        if (!saved) {
          if (note) note.textContent = '✕ 代理配置校验未通过，未触发重启';
          return;
        }
        await app.postAction('/api/relaunch', 'btnRelaunch');
      } finally {
        setTimeout(() => {
          proxyRelaunchBusy = false;
          btnProxyRelaunch.disabled = false;
        }, 3000);
      }
    });

    return { syncForm, onActivate: loadSshHosts };
  };
})(window);
