// Tab 3: SSH Remote Telemetry & TUN-Free Proxy module for AGY Claude Style Aux Pane.
(function (root) {
  root.AGYPanelRemote = function initRemoteTab(app) {
    function syncForm(cfg) {
      document.getElementById('sw-ssh-enabled').checked = Boolean(cfg.sshRemoteStats);
      document.getElementById('inp-ssh-host').value = cfg.sshHost || '';
      document.getElementById('ssh-badge').textContent = cfg.sshRemoteStats ? '已开启' : '关闭';

      document.getElementById('sw-proxy-enabled').checked = Boolean(cfg.proxyEnabled);
      document.getElementById('inp-proxy-url').value = cfg.proxyUrl || '';
      document.getElementById('inp-proxy-bypass').value = cfg.proxyBypass || 'localhost,127.0.0.1,::1';
      document.getElementById('sw-proxy-h1').checked = Boolean(cfg.proxyForceHttp1);
      document.getElementById('proxy-badge').textContent = cfg.proxyEnabled ? '已开启' : '关闭';
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
      await app.saveUpdates({ sshHost: host, sshRemoteStats: true });
      const note = document.getElementById('ssh-note');
      note.textContent = '正在通过 SSH 拉取远端统计…';
      try {
        const res = await app.apiFetch('/api/ssh/sync', { method: 'POST', body: JSON.stringify({ host }) });
        const d = await res.json();
        note.textContent = d.ok ? `同步成功：${d.host}（共 ${d.count} 条请求已并入看板）` : `同步失败：${d.error || '未知错误'}`;
      } catch (err) {
        note.textContent = `同步异常：${err.message}`;
      }
    });

    document.getElementById('sw-proxy-enabled').addEventListener('change', (ev) => app.saveOne('proxyEnabled', ev.target.checked));
    document.getElementById('sw-proxy-h1').addEventListener('change', (ev) => app.saveOne('proxyForceHttp1', ev.target.checked));
    document.getElementById('btn-proxy-save').addEventListener('click', () =>
      app.saveUpdates({
        proxyUrl: document.getElementById('inp-proxy-url').value.trim(),
        proxyBypass: document.getElementById('inp-proxy-bypass').value.trim() || 'localhost,127.0.0.1,::1',
      })
    );
    document.getElementById('btn-proxy-test').addEventListener('click', async () => {
      const note = document.getElementById('proxy-note');
      const proxyUrl = document.getElementById('inp-proxy-url').value.trim();
      note.textContent = '正在测试代理连通性…';
      try {
        const res = await app.apiFetch('/api/proxy/test', { method: 'POST', body: JSON.stringify({ proxyUrl }) });
        const d = await res.json();
        note.textContent = d.ok ? `✓ 连通成功 (${d.host}:${d.port} · ${d.latencyMs}ms)` : `✕ 连通失败：${d.error || '无法连接'}`;
      } catch (err) {
        note.textContent = `✕ 测试异常：${err.message}`;
      }
    });
    document.getElementById('btn-proxy-relaunch').addEventListener('click', async () => {
      await app.saveUpdates({
        proxyEnabled: true,
        proxyUrl: document.getElementById('inp-proxy-url').value.trim(),
        proxyBypass: document.getElementById('inp-proxy-bypass').value.trim() || 'localhost,127.0.0.1,::1',
        proxyForceHttp1: document.getElementById('sw-proxy-h1').checked,
      });
      await app.postAction('/api/relaunch', 'btnRelaunch');
    });

    return { syncForm, onActivate: loadSshHosts };
  };
})(window);
