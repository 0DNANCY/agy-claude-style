// Aux Pane Sidecar UI server for AGY Claude Style (agy-claude-style).
// Uses Antigravity built-in sidecar_sdk and exits cleanly via host /healthz watchdog.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryTelemetryDashboard } from './lib/telemetry-db.mjs';
import { createPricingStore } from './lib/pricing.mjs';
import { createQuotaTracker } from './lib/quota-tracker.mjs';
import { fetchSshRemoteRequests, listConfiguredSshHosts } from './lib/ssh-remote.mjs';
import { fetchSubagentTree } from './lib/subagent-tree.mjs';
import { SidecarOwner } from './lib/sidecar-owner.mjs';
import {
  buildProxyLaunchOptions,
  detectHostProxyRuntime,
  maskProxyUrl,
  normalizeProxyUrl,
  testProxyConnectivity,
} from './lib/proxy.mjs';

const require = createRequire(import.meta.url);
const cdp = require('../../cdp.js');
const { injectOnce, createWatchController } = require('../../inject.js');
const lifecycle = require('../../plugin/host-lifecycle.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, 'index.html');
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

function ensureLoopbackNoProxy() {
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const raw = String(process.env[key] || '');
    const existing = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const seen = new Set(existing.map((s) => s.toLowerCase()));
    let changed = false;
    for (const needed of ['localhost', '127.0.0.1', '::1', '[::1]']) {
      if (!seen.has(needed)) {
        existing.push(needed);
        seen.add(needed);
        changed = true;
      }
    }
    if (changed || !raw) {
      process.env[key] = existing.join(',');
    }
  }
}

ensureLoopbackNoProxy();

function readHeaderValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return String(headers.get(name) || '').trim();
  }
  return String(headers[name] || headers[name.toLowerCase()] || '').trim();
}

function isLocalHostRequest(req) {
  if (!req?.headers) return false;
  const host = readHeaderValue(req.headers, 'host').toLowerCase();
  const hostMatch = host.match(/^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/);
  if (!hostMatch) return false;

  const origin = readHeaderValue(req.headers, 'origin').toLowerCase();
  const secFetchSite = readHeaderValue(req.headers, 'sec-fetch-site').toLowerCase();
  if (origin && /^plugin:\/\/agy-claude-style--panel(?:-\d+)?$/.test(origin)) {
    return true;
  }
  if (secFetchSite === 'cross-site') return false;

  if (origin) {
    const originMatch = origin.match(/^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/);
    if (!originMatch) return false;
    const defaultPort = originMatch[1] === 'https' ? '443' : '80';
    const originPort = originMatch[3] || defaultPort;
    const hostPort = hostMatch[2] || defaultPort;
    if (originPort !== hostPort) return false;
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

const PROXY_RUNTIME_CACHE_TTL_MS = 5000;
let proxyRuntimeCache = { key: '', value: null, expiresAt: 0 };

function getCachedProxyRuntime(config) {
  const key = `${Boolean(config.proxyEnabled)}|${config.proxyUrl || ''}|${Boolean(config.proxyForceHttp1)}`;
  const now = Date.now();
  if (proxyRuntimeCache.value && proxyRuntimeCache.key === key && now < proxyRuntimeCache.expiresAt) {
    return proxyRuntimeCache.value;
  }
  const value = detectHostProxyRuntime({
    proxyEnabled: Boolean(config.proxyEnabled),
    proxyUrl: config.proxyUrl,
    proxyForceHttp1: Boolean(config.proxyForceHttp1),
  });
  proxyRuntimeCache = { key, value, expiresAt: now + PROXY_RUNTIME_CACHE_TTL_MS };
  return value;
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
    proxyRuntime: getCachedProxyRuntime(config),
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

function logSidecarBoot(msg) {
  try {
    const logPath = join(cdp.STATE_DIR, 'relaunch.log');
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `[${new Date().toISOString()}] [sidecar-boot] ${msg}\n`, 'utf8');
  } catch {}
}

async function maybeAutoRelaunchForProxyColdStart({
  readConfigFn = cdp.readConfig,
  detectRuntimeFn = detectHostProxyRuntime,
  testConnectivityFn = testProxyConnectivity,
  readGuardFn = cdp.readRelaunchGuard,
  evalGuardFn = cdp.evaluateAutoRelaunchGuard,
  recordGuardFn = cdp.recordAutoRelaunchAttempt,
  resetGuardFn = cdp.resetRelaunchGuard,
  isRelaunchInProgressFn = cdp.isRelaunchInProgress,
  relaunchFn = cdp.relaunchAntigravityWithCdp,
  nowMs = Date.now(),
  logFn = null,
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
    if (runtime?.active && runtime?.matchesConfig && typeof resetGuardFn === 'function') {
      try {
        resetGuardFn({ markSuccess: true, reason: 'sidecar-proxy-active', nowMs });
      } catch {}
    }
    if (logFn) logFn(`proxy already matched (active=${Boolean(runtime?.active)}, pid=${runtime?.hostPid || 0})`);
    return { triggered: false, reason: 'already-matched' };
  }

  const hostPid = Number(runtime.hostPid) || 0;
  const guardPidSig = hostPid > 0 ? `proxy:${hostPid}` : 'proxy:unknown';
  if (typeof isRelaunchInProgressFn === 'function' && isRelaunchInProgressFn({ nowMs })) {
    if (logFn) logFn(`proxy mismatch skipped: relaunch already in progress pid=${hostPid}`);
    return { triggered: false, reason: 'relaunch-in-progress' };
  }
  if (typeof readGuardFn === 'function' && typeof evalGuardFn === 'function') {
    const evalRes = evalGuardFn(readGuardFn(), { pidSig: guardPidSig, nowMs });
    if (!evalRes.allowed) {
      if (logFn) logFn(`proxy mismatch (${runtime.reason}) blocked by guard=${evalRes.reason} pid=${hostPid}`);
      return { triggered: false, reason: evalRes.reason || 'guard-blocked' };
    }
  }

  const conn = await testConnectivityFn(normalizedUrl, { timeoutMs: 900 });
  if (!conn?.ok) {
    if (logFn) logFn(`proxy port unreachable (${maskProxyUrl(normalizedUrl)}): ${conn?.error || 'failed'}`);
    return { triggered: false, reason: 'proxy-unreachable', error: conn?.error || '' };
  }

  const proxyOpts = buildProxyLaunchOptions({
    proxyEnabled: true,
    proxyUrl: normalizedUrl,
    proxyBypass: cfg.proxyBypass,
    proxyForceHttp1: cfg.proxyForceHttp1 !== false,
  });
  if (logFn) logFn(`relaunching host pid=${hostPid} with proxy=${maskProxyUrl(normalizedUrl)} (${runtime.reason})`);
  const res = await relaunchFn({
    port: 0,
    detached: true,
    delayMs: 150,
    extraArgs: proxyOpts.args,
    extraEnv: proxyOpts.env,
  });
  if (res?.reason === 'relaunch-in-progress') {
    if (logFn) logFn(`relaunch skipped: another process holds relaunch lock pid=${hostPid}`);
    return { triggered: false, reason: 'relaunch-in-progress' };
  }
  if (typeof recordGuardFn === 'function') {
    recordGuardFn({ pidSig: guardPidSig, reason: 'sidecar-cold-start-no-proxy', nowMs });
  }
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
    // Antigravity built-in sidecar_sdk invokes app.api handlers as handler(data) without req
    // after enforcing loopback bind (127.0.0.1) and x-sidecar-token authentication.
    // Enforce strict Host/Origin validation whenever a request object is provided.
    if (req !== undefined && !isLocalHostRequest(req)) {
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
    try {
      await injectOnce();
      return { ok: true };
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), {
        status: 500,
        contentType: 'application/json',
      });
    }
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
      proxyForceHttp1: cfg.proxyForceHttp1 !== false,
    });
    const res = await cdp.relaunchAntigravityWithCdp({
      detached: true,
      extraArgs: proxyOpts.args,
      extraEnv: proxyOpts.env,
    });
    if (res?.reason === 'relaunch-in-progress') {
      return { ok: true, proxyActive: proxyOpts.args.length > 0, inProgress: true, ...res };
    }
    if (!res?.relaunched) {
      return new Response(JSON.stringify({ ok: false, ...res }), {
        status: 500,
        contentType: 'application/json',
      });
    }
    return { ok: true, proxyActive: proxyOpts.args.length > 0, ...res };
  }), 'POST');

  let lastSshSync = { ok: false, host: '', requests: [], count: 0, error: '' };
  const isTestHost = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid';
  let sidecarOwner = null;
  if (!isTestHost) {
    try {
      mkdirSync(cdp.STATE_DIR, { recursive: true });
      process.chdir(cdp.STATE_DIR);
    } catch {}
    sidecarOwner = new SidecarOwner(cdp.STATE_DIR);
    try {
      const claimed = await sidecarOwner.claim();
      if (!claimed) {
        logSidecarBoot('panel sidecar superseded by newer instance at startup; exiting');
        lifecycle.exitProcessCleanly(0, 20);
        return app;
      }
    } catch {
      sidecarOwner = null;
    }
  }

  const pricingStore = createPricingStore({
    cachePath: join(cdp.STATE_DIR, 'pricing-cache.json'),
  });
  void pricingStore.refresh({ force: false });

  const quotaTracker = createQuotaTracker({
    filePath: join(cdp.STATE_DIR, 'quota-daily.json'),
    ownsFn: sidecarOwner ? () => sidecarOwner.owns() : null,
    allowRediscover: !isTestHost,
  });
  void quotaTracker.sampleNow({ force: true });
  const quotaTimer = setInterval(() => {
    void quotaTracker.sampleNow({ force: false });
  }, 60_000);
  if (typeof quotaTimer.unref === 'function') quotaTimer.unref();

  if (String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim() !== 'test.invalid') {
    // Fallback check in case startPanelSidecar() was called directly without the top-level boot trigger
    if (!bootProxyCheckStarted) {
      bootProxyCheckStarted = true;
      void maybeAutoRelaunchForProxyColdStart({ logFn: logSidecarBoot }).catch(() => {});
    }
  }

  app.api('/api/pricing/refresh', guardApi(async () => {
    return await pricingStore.refresh({ force: true });
  }), 'POST');

  app.api('/api/subagents', guardApi(async () => {
    return await fetchSubagentTree();
  }), 'GET');

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
    const sshHost = String(cfg.sshHost || '').trim();
    const includeSsh = Boolean(cfg.sshRemoteStats && sshHost);
    let sshInfo = lastSshSync;
    if (includeSsh && (data?.syncSsh || lastSshSync.host !== sshHost)) {
      try {
        sshInfo = await fetchSshRemoteRequests(sshHost, { force: Boolean(data?.syncSsh) });
      } catch (err) {
        sshInfo = { ok: false, host: sshHost, requests: [], count: 0, error: err?.message || String(err) };
      }
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
      let raceTimer = null;
      try {
        weeklyQuota = await Promise.race([
          quotaTracker.sampleNow({ force: true }),
          new Promise((resolveTimeout) => {
            raceTimer = setTimeout(() => resolveTimeout(quotaTracker.getSummary()), 2500);
          }),
        ]);
      } finally {
        if (raceTimer) clearTimeout(raceTimer);
      }
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
        host: sshHost,
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
    try {
      const res = await fetchSshRemoteRequests(host, { force: true });
      lastSshSync = res;
      return { ok: res.ok, host: res.host, count: res.count || 0, error: res.error || '' };
    } catch (err) {
      const msg = err?.message || String(err);
      lastSshSync = { ok: false, host, requests: [], count: 0, error: msg };
      return { ok: false, host, count: 0, error: msg };
    }
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

  let shuttingDown = false;
  let watchdog = null;
  let watchController = null;
  let watchReconcileInFlight = null;
  let watchReconcileQueued = false;
  let watchDebounceTimer = null;
  let watchStandbyTimer = null;
  let stateDirWatcher = null;
  let hostConfigWatcher = null;

  const antigravityConfigPath =
    String(process.env.AGY_CLAUDE_STYLE_ANTIGRAVITY_CONFIG || '').trim() ||
    (String(process.env.AGY_CLAUDE_STYLE_STATE_DIR || '').trim()
      ? null
      : join(homedir(), '.gemini', 'config', 'config.json'));

  const runSidecarWatchReconcile = async () => {
    if (shuttingDown || isTestHost) return;
    const pluginState = antigravityConfigPath
      ? lifecycle.readAntigravityPluginEnabledState({
          pluginName: 'agy-claude-style',
          configPath: antigravityConfigPath,
        })
      : 'unknown';
    if (pluginState === 'disabled') {
      if (watchController && !watchController.isStopped()) {
        const ctrl = watchController;
        watchController = null;
        await ctrl.stop({ removeFromPages: true, reason: 'plugin-disabled' }).catch(() => {});
      }
      return;
    }
    if (watchController && !watchController.isStopped()) {
      return;
    }
    watchController = null;
    try {
      const ctrl = await createWatchController({
        allowGracefulDuplicateExit: true,
        allowAutoRelaunch: true,
        enableConsole: false,
        duplicateWaitMs: 0,
        quietDuplicateLog: true,
        logFile: join(cdp.STATE_DIR, 'watch.log'),
      });
      if (!ctrl) return;
      if (shuttingDown) {
        await ctrl.stop({ removeFromPages: false, reason: 'late-shutdown' }).catch(() => {});
        return;
      }
      const postState = antigravityConfigPath
        ? lifecycle.readAntigravityPluginEnabledState({
            pluginName: 'agy-claude-style',
            configPath: antigravityConfigPath,
          })
        : 'unknown';
      if (postState === 'disabled') {
        await ctrl.stop({ removeFromPages: true, reason: 'plugin-disabled' }).catch(() => {});
        return;
      }
      watchController = ctrl;
    } catch (err) {
      logSidecarBoot(`internal watch controller failed: ${err?.message || err}`);
    }
  };

  const triggerSidecarWatchReconcile = () => {
    if (shuttingDown || isTestHost) return watchReconcileInFlight || Promise.resolve();
    if (watchReconcileInFlight) {
      watchReconcileQueued = true;
      return watchReconcileInFlight;
    }
    watchReconcileInFlight = (async () => {
      do {
        watchReconcileQueued = false;
        if (shuttingDown) break;
        await runSidecarWatchReconcile();
      } while (watchReconcileQueued && !shuttingDown);
    })()
      .catch(() => {})
      .finally(() => {
        watchReconcileInFlight = null;
        if (watchReconcileQueued && !shuttingDown) {
          void triggerSidecarWatchReconcile();
        }
      });
    return watchReconcileInFlight;
  };

  const scheduleSidecarWatchReconcile = () => {
    if (shuttingDown || isTestHost) return;
    clearTimeout(watchDebounceTimer);
    watchDebounceTimer = setTimeout(() => {
      watchDebounceTimer = null;
      void triggerSidecarWatchReconcile();
    }, 60);
    if (typeof watchDebounceTimer.unref === 'function') watchDebounceTimer.unref();
  };

  if (!isTestHost) {
    void triggerSidecarWatchReconcile();
    try {
      if (existsSync(cdp.STATE_DIR)) {
        stateDirWatcher = watch(cdp.STATE_DIR, (_, filename) => {
          if (shuttingDown) return;
          if (!filename || filename === '.watch.pid') scheduleSidecarWatchReconcile();
        });
        if (typeof stateDirWatcher.unref === 'function') stateDirWatcher.unref();
      }
    } catch {}
    try {
      const cfgDir = dirname(antigravityConfigPath);
      const cfgBase = 'config.json';
      if (existsSync(cfgDir)) {
        hostConfigWatcher = watch(cfgDir, (_, filename) => {
          if (shuttingDown) return;
          if (!filename || String(filename) === cfgBase) scheduleSidecarWatchReconcile();
        });
        if (typeof hostConfigWatcher.unref === 'function') hostConfigWatcher.unref();
      }
    } catch {}
    const standbyPollMs = Math.max(100, Number(process.env.AGY_CLAUDE_STYLE_STANDBY_POLL_MS) || 1500);
    watchStandbyTimer = setInterval(() => {
      void triggerSidecarWatchReconcile();
    }, standbyPollMs);
    if (typeof watchStandbyTimer.unref === 'function') watchStandbyTimer.unref();
  }

  const shutdown = async (reason = 'shutdown') => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(quotaTimer);
    if (watchStandbyTimer) {
      clearInterval(watchStandbyTimer);
      watchStandbyTimer = null;
    }
    if (watchDebounceTimer) {
      clearTimeout(watchDebounceTimer);
      watchDebounceTimer = null;
    }
    try { stateDirWatcher?.close(); } catch {}
    stateDirWatcher = null;
    try { hostConfigWatcher?.close(); } catch {}
    hostConfigWatcher = null;

    const forceTimer = setTimeout(() => process.exit(0), 2000);
    forceTimer.unref?.();
    try {
      sidecarOwner?.stop();
      watchdog?.stop();
      if (!isTestHost) {
        if (watchReconcileInFlight) {
          await Promise.race([
            watchReconcileInFlight.catch(() => {}),
            new Promise((r) => setTimeout(r, 400)),
          ]);
        }
        const pluginState = antigravityConfigPath
          ? lifecycle.readAntigravityPluginEnabledState({
              pluginName: 'agy-claude-style',
              configPath: antigravityConfigPath,
            })
          : 'unknown';
        const shouldRemove =
          pluginState === 'disabled' && reason !== 'ls-dead' && reason !== 'parent-dead';
        if (watchController) {
          const ctrl = watchController;
          watchController = null;
          await ctrl.stop({ removeFromPages: shouldRemove, reason });
        } else if (shouldRemove) {
          const alivePeers = lifecycle.listAliveMcpHosts({
            stateDir: cdp.STATE_DIR,
            excludePid: process.pid,
            pruneStale: true,
          });
          if (alivePeers.length === 0) {
            await lifecycle.removeInjectedUiFromReachablePages(cdp, { timeoutMs: 1200 }).catch(() => {});
          }
        }
      }
      await app.close();
    } catch {
      // ignore close errors
    } finally {
      clearTimeout(forceTimer);
      lifecycle.exitProcessCleanly(0, 50);
    }
  };

  if (sidecarOwner) {
    sidecarOwner.watch(() => {
      logSidecarBoot('panel sidecar ownership lost to newer instance; shutting down');
      void shutdown('superseded');
    });
  }

  const onPipeError = (err) => {
    if (lifecycle.isBrokenPipeError(err)) void shutdown('broken-pipe');
  };
  process.stdout?.on('error', onPipeError);
  process.stderr?.on('error', onPipeError);

  watchdog = lifecycle.startHostWatchdog({
    lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS,
    watchStdin: false,
    checkIntervalMs: 3000,
    maxLsFailures: 2,
    onShutdown: (reason) => {
      void shutdown(reason);
    },
  });
  if (!isTestHost) {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
      process.on(sig, () => {
        void shutdown(`signal:${sig}`);
      });
    }
  }

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
let bootProxyCheckStarted = false;
if (isMainEntry) {
  // Run non-TUN cold-start proxy check immediately at 0ms (before sidecar_sdk / network init),
  // matching agy-powertools so Antigravity can relaunch into proxy mode before OAuth times out.
  if (String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim() !== 'test.invalid') {
    bootProxyCheckStarted = true;
    void maybeAutoRelaunchForProxyColdStart({ logFn: logSidecarBoot }).catch(() => {});
  }
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
