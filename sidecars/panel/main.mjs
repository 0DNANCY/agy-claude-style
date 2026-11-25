// Aux Pane Sidecar UI server for AGY Claude Style (agy-claude-style).
// Uses Antigravity built-in sidecar_sdk and exits cleanly via host /healthz watchdog.
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchFileAction } from './lib/file-actions.mjs';
import { queryTelemetryDashboard } from './lib/telemetry-db.mjs';
import { createPricingStore } from './lib/pricing.mjs';
import { createQuotaTracker } from './lib/quota-tracker.mjs';
import { fetchSshRemoteRequests, listConfiguredSshHosts } from './lib/ssh-remote.mjs';
import {
  buildProxyLaunchOptions,
  detectHostProxyRuntime,
  normalizeProxyUrl,
  testProxyConnectivity,
} from './lib/proxy.mjs';

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

const CDP_TRANSIENT_GRACE_MISSES = 2;
const CDP_TRANSIENT_GRACE_MS = 20_000;
const cdpPollTracker = {
  lastOkAt: 0,
  lastPort: null,
  lastPages: [],
  consecutiveMisses: 0,
};

function resolveCdpPollStatus({ port, pagesList = null, nowMs = Date.now(), tracker = cdpPollTracker } = {}) {
  if (port && Array.isArray(pagesList)) {
    tracker.lastOkAt = nowMs;
    tracker.lastPort = port;
    tracker.lastPages = pagesList;
    tracker.consecutiveMisses = 0;
    return {
      connected: true,
      reconnecting: false,
      port,
      pages: pagesList,
      needsCdpRestart: false,
    };
  }
  if (!port) {
    tracker.consecutiveMisses = CDP_TRANSIENT_GRACE_MISSES + 1;
    tracker.lastPort = null;
    tracker.lastPages = [];
    return {
      connected: false,
      reconnecting: false,
      port: null,
      pages: [],
      needsCdpRestart: true,
    };
  }
  tracker.consecutiveMisses = (tracker.consecutiveMisses || 0) + 1;
  const withinGrace =
    tracker.lastPort === port &&
    tracker.lastOkAt > 0 &&
    nowMs - tracker.lastOkAt <= CDP_TRANSIENT_GRACE_MS &&
    tracker.consecutiveMisses <= CDP_TRANSIENT_GRACE_MISSES;
  if (withinGrace) {
    return {
      connected: true,
      reconnecting: true,
      port,
      pages: tracker.lastPages || [],
      needsCdpRestart: false,
    };
  }
  return {
    connected: false,
    reconnecting: false,
    port: null,
    pages: [],
    needsCdpRestart: true,
  };
}

async function getPanelStatus() {
  const config = cdp.readConfig();
  const watcher = readWatcherStatus();
  const port = cdp.readPort();
  let pagesList = null;

  if (port) {
    try {
      const list = await cdp.listPages(port);
      pagesList = list.map((p) => {
        const url = String(p.url || '');
        const isSwarm = url.toLowerCase().startsWith(cdp.SWARM_SIDECAR_URL_PREFIX);
        return {
          id: p.id,
          title: p.title || url || 'Antigravity',
          kind: isSwarm ? 'swarm' : 'window',
        };
      });
    } catch {
      pagesList = null;
    }
  }
  const cdpState = resolveCdpPollStatus({ port, pagesList });
  const pages = cdpState.pages;

  return {
    ok: true,
    version: cdp.PLUGIN_VERSION,
    platform: process.platform,
    config,
    defaults: cdp.DEFAULT_CONFIG,
    stateDir: cdp.STATE_DIR,
    configFile: cdp.CONFIG_FILE,
    watcher,
    relaunchGuard: typeof cdp.readRelaunchGuard === 'function' ? cdp.readRelaunchGuard() : null,
    cdp: {
      connected: cdpState.connected,
      reconnecting: cdpState.reconnecting,
      port: cdpState.port,
      pageCount: pages.length,
      pagesCount: pages.length,
      needsCdpRestart: cdpState.needsCdpRestart,
      pages,
    },
    companions: {
      capsule: inspectCompanionPlugin('agy-capsule'),
      bridge: inspectCompanionPlugin('agy-claude-capsule-bridge'),
    },
    conflicts: {
      studio: inspectCompanionPlugin('agy-claude-studio'),
    },
    proxyRuntime: detectHostProxyRuntime({
      proxyEnabled: Boolean(config.proxyEnabled),
      proxyUrl: config.proxyUrl,
      proxyForceHttp1: Boolean(config.proxyForceHttp1),
    }),
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

async function maybeAutoRelaunchForProxyColdStart({
  readConfigFn = cdp.readConfig,
  detectRuntimeFn = detectHostProxyRuntime,
  testConnectivityFn = testProxyConnectivity,
  readGuardFn = cdp.readRelaunchGuard,
  evalGuardFn = cdp.evaluateAutoRelaunchGuard,
  recordGuardFn = cdp.recordAutoRelaunchAttempt,
  relaunchFn = cdp.relaunchAntigravityWithCdp,
  nowMs = Date.now(),
} = {}) {
  const cfg = readConfigFn();
  if (!cfg || cfg.proxyEnabled !== true) return { triggered: false, reason: 'disabled' };
  const normalizedUrl = normalizeProxyUrl(cfg.proxyUrl);
  if (!normalizedUrl) return { triggered: false, reason: 'invalid-url' };

  const runtime = detectRuntimeFn({
    proxyEnabled: true,
    proxyUrl: normalizedUrl,
    proxyForceHttp1: cfg.proxyForceHttp1 !== false,
  });
  if (!runtime?.inspected || !runtime.coldStartMismatch) {
    return { triggered: false, reason: 'already-matched' };
  }

  const hostPid = Number(runtime.hostPid) || 0;
  const guardPidSig = hostPid > 0 ? `proxy:${hostPid}` : 'proxy:unknown';
  if (typeof readGuardFn === 'function' && typeof evalGuardFn === 'function') {
    const evalRes = evalGuardFn(readGuardFn(), { pidSig: guardPidSig, nowMs });
    if (!evalRes.allowed) {
      return { triggered: false, reason: evalRes.reason || 'guard-blocked' };
    }
  }

  const conn = await testConnectivityFn(normalizedUrl, { timeoutMs: 1500 });
  if (!conn?.ok) {
    return { triggered: false, reason: 'proxy-unreachable', error: conn?.error || '' };
  }

  if (typeof recordGuardFn === 'function') {
    recordGuardFn({ pidSig: guardPidSig, reason: 'sidecar-cold-start-no-proxy', nowMs });
  }

  const proxyOpts = buildProxyLaunchOptions({
    proxyEnabled: true,
    proxyUrl: normalizedUrl,
    proxyBypass: cfg.proxyBypass,
    proxyForceHttp1: cfg.proxyForceHttp1 !== false,
  });
  const res = await relaunchFn({
    port: 0,
    detached: true,
    extraArgs: proxyOpts.args,
    extraEnv: proxyOpts.env,
  });
  return { triggered: Boolean(res?.relaunched), reason: res?.relaunched ? 'relaunched' : res?.reason || 'failed' };
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
    if (typeof cdp.resetRelaunchGuard === 'function') {
      cdp.resetRelaunchGuard({ reason: 'manual-relaunch' });
    }
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
  const pricingStore = createPricingStore({
    cachePath: join(cdp.STATE_DIR, 'pricing-cache.json'),
  });
  void pricingStore.refresh({ force: false });

  const quotaTracker = createQuotaTracker({
    filePath: join(cdp.STATE_DIR, 'quota-daily.json'),
  });
  void quotaTracker.sampleNow({ force: true });
  const quotaTimer = setInterval(() => {
    void quotaTracker.sampleNow({ force: false });
  }, 60_000);
  if (typeof quotaTimer.unref === 'function') quotaTimer.unref();

  if (String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim() !== 'test.invalid') {
    const autoProxyTimer = setTimeout(() => {
      void maybeAutoRelaunchForProxyColdStart().catch(() => {});
    }, 1500);
    if (typeof autoProxyTimer.unref === 'function') autoProxyTimer.unref();
  }

  app.api('/api/pricing/refresh', guardApi(async () => {
    return await pricingStore.refresh({ force: true });
  }), 'POST');

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
    // Decouple local SQLite/JSONL dashboard load from remote quota RPC so dashboard renders instantly.
    const dash = queryTelemetryDashboard({
      range,
      date,
      conversationId,
      model,
      status,
      search,
      offset,
      limit,
      extraRequests,
      priceLookup: pricingStore.lookupPrice,
    });
    let weeklyQuota;
    if (data?.syncSsh) {
      weeklyQuota = await Promise.race([
        quotaTracker.sampleNow({ force: true }),
        new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(quotaTracker.getSummary()), 2500)),
      ]);
    } else {
      weeklyQuota = quotaTracker.getSummary();
      void quotaTracker.sampleNow({ force: false });
    }
    return {
      ...dash,
      weeklyQuota,
      pricing: pricingStore.getMeta(),
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
const isMainEntry =
  Boolean(invokedPath) &&
  (process.platform === 'win32'
    ? invokedPath.toLowerCase() === currentPath.toLowerCase()
    : invokedPath === currentPath);
if (isMainEntry) {
  startPanelSidecar().catch((err) => {
    console.error('[agy-claude-style panel sidecar] failed:', err?.message || err);
    process.exit(1);
  });
}

export {
  isLocalHostRequest,
  inspectCompanionPlugin,
  readWatcherStatus,
  resolveCdpPollStatus,
  getPanelStatus,
  applyConfigUpdate,
  resetConfig,
  maybeAutoRelaunchForProxyColdStart,
  startPanelSidecar,
};
