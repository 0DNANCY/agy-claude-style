// Aux Pane Sidecar UI server for AGY Claude Style (agy-claude-style).
// Uses Antigravity built-in sidecar_sdk and exits cleanly via host /healthz watchdog.
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchFileAction } from './lib/file-actions.mjs';
import { queryTelemetryDashboard } from './lib/telemetry-db.mjs';
import { createQuotaTracker } from './lib/quota-tracker.mjs';
import { fetchSshRemoteRequests, listConfiguredSshHosts } from './lib/ssh-remote.mjs';
import { buildProxyLaunchOptions, normalizeProxyUrl, testProxyConnectivity } from './lib/proxy.mjs';

const require = createRequire(import.meta.url);
const cdp = require('../../cdp.js');
const { injectOnce } = require('../../inject.js');
const lifecycle = require('../../plugin/host-lifecycle.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, 'index.html');
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

function isLocalHostRequest(req) {
  if (!req?.headers) return true;
  const host = String(req.headers.host || '').trim().toLowerCase();
  const hostMatch = host.match(/^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/);
  if (host && !hostMatch) return false;

  const origin = String(req.headers.origin || '').trim().toLowerCase();
  if (origin && /^(?:vscode-webview|plugin):\/\/[a-z0-9._-]+$/.test(origin)) {
    return true;
  }
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'cross-site') return false;

  if (origin) {
    const originMatch = origin.match(/^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/);
    if (!originMatch) return false;
    if (hostMatch) {
      const defaultPort = originMatch[1] === 'https' ? '443' : '80';
      const originPort = originMatch[3] || defaultPort;
      const hostPort = hostMatch[2] || defaultPort;
      if (originPort !== hostPort) return false;
    }
  }
  return true;
}

function inspectCompanionPlugin(pluginName, homeDir = homedir()) {
  const pluginsRoot = join(homeDir, '.gemini', 'config', 'plugins');
  const manifestPath = join(pluginsRoot, pluginName, 'plugin.json');
  const installed = existsSync(manifestPath);
  let version = '';
  if (installed) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
      version = String(parsed?.version || '');
    } catch {}
  }
  const enabledState = lifecycle.readAntigravityPluginEnabledState({
    pluginName,
    configPath: join(homeDir, '.gemini', 'config', 'config.json'),
  });
  return {
    installed,
    version,
    enabled: installed ? enabledState !== 'disabled' : false,
  };
}

function readWatcherStatus() {
  try {
    if (!existsSync(cdp.PID_FILE)) return { alive: false, pid: null };
    const pid = parseInt(readFileSync(cdp.PID_FILE, 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return { alive: false, pid: null };
    if (!lifecycle.isPidAlive(pid)) return { alive: false, pid: null };
    return { alive: true, pid };
  } catch {
    return { alive: false, pid: null };
  }
}

async function getPanelStatus() {
  const config = cdp.readConfig();
  const watcher = readWatcherStatus();
  const port = cdp.readPort();
  let activePort = null;
  let pages = [];

  if (port) {
    try {
      const list = await cdp.listPages(port);
      activePort = port;
      pages = list.map((p) => {
        const url = String(p.url || '');
        const isSwarm = url.toLowerCase().startsWith(cdp.SWARM_SIDECAR_URL_PREFIX);
        return {
          id: p.id,
          title: p.title || url || 'Antigravity',
          kind: isSwarm ? 'swarm' : 'window',
        };
      });
    } catch {}
  }

  return {
    ok: true,
    version: cdp.PLUGIN_VERSION,
    config,
    defaults: cdp.DEFAULT_CONFIG,
    stateDir: cdp.STATE_DIR,
    configFile: cdp.CONFIG_FILE,
    watcher,
    cdp: {
      connected: Boolean(activePort),
      port: activePort,
      pageCount: pages.length,
      pagesCount: pages.length,
      needsCdpRestart: !activePort,
      pages,
    },
    companions: {
      capsule: inspectCompanionPlugin('agy-capsule'),
      bridge: inspectCompanionPlugin('agy-claude-capsule-bridge'),
    },
  };
}

async function applyConfigUpdate(data) {
  const updates =
    data && typeof data.updates === 'object' && data.updates !== null
      ? data.updates
      : data && typeof data.key === 'string'
      ? { [data.key]: data.value }
      : {};

  try {
    mkdirSync(dirname(cdp.CONFIG_FILE), { recursive: true });
  } catch {}

  const applied = [];
  const rejected = [];
  for (const [k, v] of Object.entries(updates)) {
    if (cdp.updateConfigSetting(k, v)) {
      applied.push(k);
    } else {
      rejected.push(k);
    }
  }

  const watcher = readWatcherStatus();
  if (applied.length > 0 && !watcher.alive) {
    try {
      await injectOnce();
    } catch {}
  }

  return {
    ok: rejected.length === 0,
    applied,
    rejected,
    config: cdp.readConfig(),
  };
}

async function resetConfig() {
  try {
    mkdirSync(dirname(cdp.CONFIG_FILE), { recursive: true });
  } catch {}
  cdp.writeFileAtomic(cdp.CONFIG_FILE, JSON.stringify(cdp.DEFAULT_CONFIG, null, 2) + '\n');
  const watcher = readWatcherStatus();
  if (!watcher.alive) {
    try {
      await injectOnce();
    } catch {}
  }
  return { ok: true, config: cdp.readConfig() };
}

async function startPanelSidecar() {
  const { Response, SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();

  app.page('/', () => {
    const html = readFileSync(HTML_PATH, 'utf8');
    return new Response(html, {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: NO_STORE_HEADERS,
    });
  });

  const uiDir = join(__dirname, 'ui');
  const uiAssets = [
    ['/ui/panel.css', 'panel.css', 'text/css; charset=utf-8'],
    ['/ui/control-tab.js', 'control-tab.js', 'application/javascript; charset=utf-8'],
    ['/ui/dashboard-tab.js', 'dashboard-tab.js', 'application/javascript; charset=utf-8'],
    ['/ui/remote-tab.js', 'remote-tab.js', 'application/javascript; charset=utf-8'],
  ];
  for (const [route, fileName, contentType] of uiAssets) {
    app.page(route, () => {
      const content = readFileSync(join(uiDir, fileName), 'utf8');
      return new Response(content, {
        status: 200,
        contentType,
        headers: NO_STORE_HEADERS,
      });
    });
  }

  const guardApi = (fn) => async (data, req) => {
    if (!isLocalHostRequest(req)) {
      return new Response(JSON.stringify({ ok: false, error: 'Forbidden host or origin' }), {
        status: 403,
        contentType: 'application/json',
      });
    }
    return fn(data, req);
  };

  app.api('/api/status', guardApi(async () => getPanelStatus()), 'GET');
  app.api('/api/config', guardApi(async (data) => applyConfigUpdate(data)), 'POST');
  app.api('/api/reset', guardApi(async () => resetConfig()), 'POST');
  app.api('/api/reinject', guardApi(async () => {
    await injectOnce();
    return { ok: true };
  }), 'POST');
  app.api('/api/remove', guardApi(async () => {
    const removed = await lifecycle.removeInjectedUiFromReachablePages(cdp, { timeoutMs: 2000 });
    return { ok: true, removed };
  }), 'POST');
  app.api('/api/relaunch', guardApi(async () => {
    const cfg = cdp.readConfig();
    const proxyOpts = buildProxyLaunchOptions({
      proxyEnabled: Boolean(cfg.proxyEnabled),
      proxyUrl: cfg.proxyUrl,
      proxyBypass: cfg.proxyBypass,
      proxyForceHttp1: Boolean(cfg.proxyForceHttp1),
    });
    const res = await cdp.relaunchAntigravityWithCdp({
      detached: true,
      extraArgs: proxyOpts.args,
      extraEnv: proxyOpts.env,
    });
    if (!res?.relaunched) {
      return new Response(JSON.stringify({ ok: false, ...res }), {
        status: 500,
        contentType: 'application/json',
      });
    }
    return { ok: true, proxyActive: proxyOpts.args.length > 0, ...res };
  }), 'POST');

  let lastSshSync = { ok: false, host: '', requests: [], count: 0, error: '' };
  const quotaTracker = createQuotaTracker({
    filePath: join(cdp.STATE_DIR, 'quota-daily.json'),
  });
  void quotaTracker.sampleNow({ force: true });
  const quotaTimer = setInterval(() => {
    void quotaTracker.sampleNow({ force: false });
  }, 60_000);
  if (typeof quotaTimer.unref === 'function') quotaTimer.unref();

  app.api('/api/telemetry', guardApi(async (data) => {
    const cfg = cdp.readConfig();
    const range = String(data?.range || '7d');
    const date = String(data?.date || '');
    const conversationId = String(data?.conversationId || '');
    const model = String(data?.model || '');
    const status = String(data?.status || 'all');
    const search = String(data?.search || '');
    const offset = Number(data?.offset) || 0;
    const limit = Number(data?.limit) || 50;
    const includeSsh = Boolean(cfg.sshRemoteStats && cfg.sshHost);
    let sshInfo = lastSshSync;
    if (includeSsh && (data?.syncSsh || lastSshSync.host !== cfg.sshHost)) {
      sshInfo = await fetchSshRemoteRequests(cfg.sshHost, { force: Boolean(data?.syncSsh) });
      lastSshSync = sshInfo;
    }
    const extraRequests = includeSsh && sshInfo.ok ? sshInfo.requests : [];
    const [dash, weeklyQuota] = await Promise.all([
      Promise.resolve(
        queryTelemetryDashboard({
          range,
          date,
          conversationId,
          model,
          status,
          search,
          offset,
          limit,
          extraRequests,
        })
      ),
      quotaTracker.sampleNow({ force: Boolean(data?.syncSsh) }),
    ]);
    return {
      ...dash,
      weeklyQuota,
      ssh: {
        enabled: includeSsh,
        host: cfg.sshHost || '',
        ok: sshInfo.ok,
        count: sshInfo.count || 0,
        error: sshInfo.error || '',
      },
    };
  }), 'POST');

  app.api('/api/ssh/hosts', guardApi(async () => ({
    ok: true,
    hosts: listConfiguredSshHosts(),
  })), 'GET');

  app.api('/api/ssh/sync', guardApi(async (data) => {
    const cfg = cdp.readConfig();
    const host = String(data?.host || cfg.sshHost || '').trim();
    if (!host) return { ok: false, error: '请先填写 SSH 主机名' };
    const res = await fetchSshRemoteRequests(host, { force: true });
    lastSshSync = res;
    return { ok: res.ok, host: res.host, count: res.count || 0, error: res.error || '' };
  }), 'POST');

  app.api('/api/proxy/test', guardApi(async (data) => {
    const cfg = cdp.readConfig();
    const rawUrl = String(data?.proxyUrl || cfg.proxyUrl || '').trim();
    if (!rawUrl) return { ok: false, error: '请先填写代理地址' };
    if (!normalizeProxyUrl(rawUrl)) {
      return { ok: false, error: '代理地址格式无效（支持 http://、https://、socks5://、socks5h://）' };
    }
    return await testProxyConnectivity(rawUrl);
  }), 'POST');

  app.api('/api/file/action', guardApi(async (data) => {
    try {
      return await dispatchFileAction(data || {});
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), {
        status: 400,
        contentType: 'application/json',
      });
    }
  }), 'POST');

  let shuttingDown = false;
  let watchdog = null;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => process.exit(0), 1500);
    forceTimer.unref?.();
    try {
      watchdog?.stop();
      await app.close();
    } catch {
      // ignore close errors
    } finally {
      clearTimeout(forceTimer);
      lifecycle.exitProcessCleanly(0, 50);
    }
  };

  const onPipeError = (err) => {
    if (lifecycle.isBrokenPipeError(err)) void shutdown();
  };
  process.stdout?.on('error', onPipeError);
  process.stderr?.on('error', onPipeError);

  watchdog = lifecycle.startHostWatchdog({
    lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS,
    watchStdin: false,
    checkIntervalMs: 3000,
    maxLsFailures: 2,
    onShutdown: () => {
      void shutdown();
    },
  });

  await app.run();
  return app;
}

function safeRealpath(filePath) {
  if (!filePath) return '';
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

const invokedPath = process.argv[1] ? safeRealpath(process.argv[1]) : '';
const currentPath = safeRealpath(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === currentPath) {
  startPanelSidecar().catch((err) => {
    console.error('[agy-claude-style panel sidecar] failed:', err?.message || err);
    process.exit(1);
  });
}

export {
  isLocalHostRequest,
  inspectCompanionPlugin,
  readWatcherStatus,
  getPanelStatus,
  applyConfigUpdate,
  resetConfig,
  startPanelSidecar,
};
