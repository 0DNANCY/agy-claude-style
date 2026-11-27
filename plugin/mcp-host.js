// Zero-tool MCP Stdio lifecycle host for native AGY Claude Style plugin.
// - Exposes 0 tools (`tools/list -> []`) so it consumes 0 context tokens.
// - Supervises the CDP watcher inside the Antigravity plugin lifecycle.
// - Distinguishes plugin disable (host alive -> live restore UI) from host shutdown (silent clean exit).
const fs = require('fs');
const os = require('os');
const path = require('path');
const cdpApi = require('../cdp');
const { createWatchController } = require('../inject');
const {
  isBrokenPipeError,
  normalizeLsHealthzUrl,
  startHostWatchdog,
  registerMcpHost,
  listAliveMcpHosts,
  readAntigravityPluginEnabledState,
  removeInjectedUiFromReachablePages,
  exitProcessCleanly,
} = require('./host-lifecycle');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const PLUGIN_MANIFEST_PATH = path.join(PLUGIN_ROOT, 'plugin.json');

const SUPPORTED_MCP_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const DEFAULT_MCP_VERSION = '2025-03-26';

function readPluginManifest() {
  try {
    if (fs.existsSync(PLUGIN_MANIFEST_PATH)) {
      return JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_PATH, 'utf8'));
    }
  } catch {}
  return null;
}

function readPluginVersion() {
  const parsed = readPluginManifest();
  return typeof parsed?.version === 'string' && parsed.version.trim()
    ? parsed.version.trim()
    : cdpApi.PLUGIN_VERSION || '2.2.0';
}

function readPluginName() {
  const parsed = readPluginManifest();
  return typeof parsed?.name === 'string' && parsed.name.trim()
    ? parsed.name.trim()
    : 'agy-claude-style';
}

function resolveHostPluginConfigPath({ env = process.env, homeDir = os.homedir() } = {}) {
  const explicit = String(env?.AGY_CLAUDE_STYLE_ANTIGRAVITY_CONFIG || '').trim();
  if (explicit) return path.resolve(explicit);
  if (String(env?.AGY_CLAUDE_STYLE_STATE_DIR || '').trim()) return null;
  return path.join(homeDir, '.gemini', 'config', 'config.json');
}

function handleMcpJsonRpcMessage(msg, serverVersion = '2.2.0') {
  if (!msg || typeof msg !== 'object') return null;
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
  if (!hasId) return null;

  const id = msg.id;
  const method = String(msg.method || '');

  if (method === 'initialize') {
    const requested = String(msg.params?.protocolVersion || '').trim();
    const protocolVersion = SUPPORTED_MCP_VERSIONS.has(requested)
      ? requested
      : DEFAULT_MCP_VERSION;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'agy-claude-style-host',
          version: serverVersion,
        },
      },
    };
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [] } };
  }
  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: [] } };
  }
  if (method === 'resources/templates/list') {
    return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
  }
  if (method === 'prompts/list') {
    return { jsonrpc: '2.0', id, result: { prompts: [] } };
  }
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  };
}

async function isHostStillAlive(reason, healthzUrl) {
  if (reason === 'ls-dead' || reason === 'parent-dead') return false;
  if (!healthzUrl) return false;
  try {
    await fetch(healthzUrl, { signal: AbortSignal.timeout(450) });
    return true;
  } catch {
    return false;
  }
}

async function shouldRemoveUiOnShutdown({
  reason,
  healthzUrl,
  stateDir,
  antigravityConfigPath,
  pluginName,
  isLeader = false,
  excludePid = process.pid,
  settleDelayMs = 120,
} = {}) {
  const readState = () =>
    antigravityConfigPath
      ? readAntigravityPluginEnabledState({ pluginName, configPath: antigravityConfigPath })
      : 'unknown';

  const hasOtherPeers = () =>
    Boolean(stateDir) && listAliveMcpHosts({ stateDir, excludePid, pruneStale: true }).length > 0;

  let pluginState = readState();
  if (pluginState === 'disabled') {
    return Boolean(isLeader) || !hasOtherPeers();
  }
  if (!isLeader) return false;
  if (reason === 'ls-dead' || reason === 'parent-dead') return false;

  if (
    settleDelayMs > 0 &&
    (reason === 'stdin-end' || reason === 'stdin-close' || reason === 'signal:SIGTERM')
  ) {
    await new Promise((r) => setTimeout(r, settleDelayMs));
    pluginState = readState();
    if (pluginState === 'disabled') return true;
  }

  if (hasOtherPeers()) return false;
  if (pluginState === 'enabled') return false;
  return await isHostStillAlive(reason, healthzUrl);
}

function detectNonDesktopHost({
  env = process.env,
  ppid = process.ppid,
  inspectCmdFn = cdpApi.inspectProcessCommand,
} = {}) {
  if (String(env?.AGY_CLAUDE_STYLE_FORCE_WATCH || '').trim() === '1') {
    return { nonDesktop: false, kind: 'desktop', reason: 'forced' };
  }
  const envCandidates = [
    env?.AGY_CLAUDE_STYLE_PLUGIN_DATA,
    env?.PLUGIN_DATA,
    env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR,
    env?.ANTIGRAVITY_APP_DATA_DIR,
    env?.JETSKI_APP_DATA_DIR,
  ];
  for (const raw of envCandidates) {
    const val = String(raw || '').trim();
    if (!val) continue;
    const m = val.match(/(?:^|[\\/])(antigravity-(?:cli|ide))(?:[\\/]|$)/i);
    if (m) {
      return { nonDesktop: true, kind: m[1].toLowerCase(), reason: 'env-data-dir' };
    }
  }
  if (Number.isInteger(ppid) && ppid > 1 && typeof inspectCmdFn === 'function') {
    try {
      const parentCmd = String(inspectCmdFn(ppid) || '').trim();
      if (
        parentCmd &&
        /(?:^|[\\/])agy(?:\.exe)?(?:\s|$)/i.test(parentCmd) &&
        !/Antigravity\.app|Antigravity\.exe|language_server/i.test(parentCmd)
      ) {
        return { nonDesktop: true, kind: 'antigravity-cli', reason: 'parent-process' };
      }
    } catch {}
  }
  return { nonDesktop: false, kind: 'desktop', reason: 'default' };
}

function startMcpPluginHost() {
  const serverVersion = readPluginVersion();
  const pluginName = readPluginName();
  const hostContext = detectNonDesktopHost();
  const passiveMcpOnly = Boolean(hostContext.nonDesktop);
  const healthzUrl = normalizeLsHealthzUrl(process.env.ANTIGRAVITY_LS_ADDRESS);
  const stateDir = cdpApi.STATE_DIR || PLUGIN_ROOT;
  const logFile = path.join(stateDir, 'watch.log');
  const antigravityConfigPath = resolveHostPluginConfigPath();
  const standbyPollMs = Math.max(100, Number(process.env.AGY_CLAUDE_STYLE_STANDBY_POLL_MS) || 1500);
  const rawSettleMs = process.env.AGY_CLAUDE_STYLE_SHUTDOWN_SETTLE_MS;
  const settleDelayMs = rawSettleMs !== undefined ? Math.max(0, Number(rawSettleMs) || 0) : 120;

  let shuttingDown = false;
  let shutdownTookControl = false;
  let framingMode = 'line';
  let rawBuffer = Buffer.alloc(0);

  function appendSafeLog(msg) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    } catch {}
  }

  let hostLease = { unregister() {} };
  if (!passiveMcpOnly) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
    } catch {}
    hostLease = registerMcpHost({
      stateDir,
      pid: process.pid,
      lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS || '',
    });
  }

  let controller = null;
  let reconcileInFlight = null;
  let reconcileQueued = false;
  let reconcileDebounceTimer = null;
  let standbyTimer = null;
  let stateDirWatcher = null;
  let configWatcher = null;
  let watchdog = null;

  async function runReconcileStep() {
    if (shuttingDown) return;

    const pluginState = antigravityConfigPath
      ? readAntigravityPluginEnabledState({ pluginName, configPath: antigravityConfigPath })
      : 'unknown';

    if (pluginState === 'disabled') {
      if (controller && !controller.isStopped()) {
        const ctrl = controller;
        controller = null;
        await ctrl.stop({ removeFromPages: true, reason: 'plugin-disabled' });
      }
      return;
    }

    if (controller && !controller.isStopped()) {
      return;
    }
    controller = null;

    try {
      const ctrl = await createWatchController({
        forceExitOnHostClose: false,
        startupGraceEnabled: false,
        allowGracefulDuplicateExit: true,
        allowAutoRelaunch: true,
        manageProcessExit: false,
        enableConsole: false,
        logFile,
      });

      if (!ctrl) {
        // Another watcher already owns the lock; remain in standby
        return;
      }

      if (shuttingDown) {
        if (shutdownTookControl) {
          await ctrl.stop({ removeFromPages: false, reason: 'late-shutdown' }).catch(() => {});
        } else {
          controller = ctrl;
        }
        return;
      }

      const postAcquireState = antigravityConfigPath
        ? readAntigravityPluginEnabledState({ pluginName, configPath: antigravityConfigPath })
        : 'unknown';
      if (postAcquireState === 'disabled') {
        await ctrl.stop({ removeFromPages: true, reason: 'plugin-disabled' }).catch(() => {});
        return;
      }

      controller = ctrl;
      try {
        listAliveMcpHosts({ stateDir, excludePid: process.pid, pruneStale: true });
      } catch {}
    } catch (err) {
      appendSafeLog(`[!] MCP watcher 启动失败，将在 standby 周期重试: ${err?.message || err}`);
    }
  }

  function triggerReconcile() {
    if (shuttingDown) return reconcileInFlight || Promise.resolve();
    if (reconcileInFlight) {
      reconcileQueued = true;
      return reconcileInFlight;
    }
    reconcileInFlight = (async () => {
      do {
        reconcileQueued = false;
        if (shuttingDown) break;
        await runReconcileStep();
      } while (reconcileQueued && !shuttingDown);
    })()
      .catch((err) => {
        appendSafeLog(`[!] MCP watcher 协调异常: ${err?.message || err}`);
      })
      .finally(() => {
        reconcileInFlight = null;
        if (reconcileQueued && !shuttingDown) {
          void triggerReconcile();
        }
      });
    return reconcileInFlight;
  }

  function scheduleReconcile() {
    if (shuttingDown) return;
    clearTimeout(reconcileDebounceTimer);
    reconcileDebounceTimer = setTimeout(() => {
      reconcileDebounceTimer = null;
      void triggerReconcile();
    }, 60);
    if (typeof reconcileDebounceTimer.unref === 'function') {
      reconcileDebounceTimer.unref();
    }
  }

  if (!passiveMcpOnly) {
    void triggerReconcile();

    try {
      if (fs.existsSync(stateDir)) {
        stateDirWatcher = fs.watch(stateDir, (_, filename) => {
          if (shuttingDown) return;
          if (!filename || filename === '.watch.pid') scheduleReconcile();
        });
        if (typeof stateDirWatcher.unref === 'function') stateDirWatcher.unref();
      }
    } catch {}

    if (antigravityConfigPath) {
      try {
        const configDir = path.dirname(antigravityConfigPath);
        const configBase = path.basename(antigravityConfigPath);
        if (fs.existsSync(configDir)) {
          configWatcher = fs.watch(configDir, (_, filename) => {
            if (shuttingDown) return;
            if (!filename || String(filename) === configBase) scheduleReconcile();
          });
          if (typeof configWatcher.unref === 'function') configWatcher.unref();
        }
      } catch {}
    }

    standbyTimer = setInterval(() => {
      void triggerReconcile();
    }, standbyPollMs);
    if (typeof standbyTimer.unref === 'function') standbyTimer.unref();
  }

  async function shutdownHost(reason = 'shutdown') {
    if (shuttingDown) return;
    shuttingDown = true;
    watchdog?.stop();
    watchdog = null;
    if (standbyTimer) {
      clearInterval(standbyTimer);
      standbyTimer = null;
    }
    if (reconcileDebounceTimer) {
      clearTimeout(reconcileDebounceTimer);
      reconcileDebounceTimer = null;
    }
    try { stateDirWatcher?.close(); } catch {}
    stateDirWatcher = null;
    try { configWatcher?.close(); } catch {}
    configWatcher = null;

    hostLease.unregister();

    const forceTimer = setTimeout(() => process.exit(0), 2200);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    try {
      if (passiveMcpOnly) {
        return;
      }
      if (reconcileInFlight) {
        await Promise.race([
          reconcileInFlight.catch(() => {}),
          new Promise((r) => setTimeout(r, 500)),
        ]);
      }
      shutdownTookControl = true;
      const isLeader = Boolean(controller && !controller.isStopped());
      const shouldRemove = await shouldRemoveUiOnShutdown({
        reason,
        healthzUrl,
        stateDir,
        antigravityConfigPath,
        pluginName,
        isLeader,
        excludePid: process.pid,
        settleDelayMs,
      });

      if (controller) {
        const ctrl = controller;
        controller = null;
        await ctrl.stop({ removeFromPages: shouldRemove, reason });
      } else if (shouldRemove) {
        await removeInjectedUiFromReachablePages(cdpApi, { timeoutMs: 1200 }).catch(() => {});
      }
    } catch {
      // ignore shutdown errors
    } finally {
      clearTimeout(forceTimer);
      exitProcessCleanly(0, 50);
    }
  }

  const onPipeError = (err) => {
    if (isBrokenPipeError(err)) void shutdownHost('broken-pipe');
  };
  process.stdout?.on('error', onPipeError);
  process.stderr?.on('error', onPipeError);

  watchdog = startHostWatchdog({
    lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS,
    watchStdin: true,
    checkIntervalMs: 3000,
    maxLsFailures: 2,
    onShutdown: (reason) => {
      void shutdownHost(reason);
    },
  });

  function writeJsonRpcResponse(payload, mode) {
    if (shuttingDown) return;
    try {
      const serialized = JSON.stringify(payload);
      if (mode === 'lsp') {
        const byteLen = Buffer.byteLength(serialized, 'utf8');
        process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${serialized}`);
      } else {
        process.stdout.write(`${serialized}\n`);
      }
    } catch (err) {
      onPipeError(err);
    }
  }

  function dispatchParsedPayload(parsed, mode) {
    if (Array.isArray(parsed)) {
      const batchOut = parsed
        .map((item) => handleMcpJsonRpcMessage(item, serverVersion))
        .filter(Boolean);
      if (batchOut.length > 0) writeJsonRpcResponse(batchOut, mode);
      return;
    }
    const response = handleMcpJsonRpcMessage(parsed, serverVersion);
    if (response) writeJsonRpcResponse(response, mode);
  }

  function drainInputBuffer() {
    while (rawBuffer.length > 0) {
      const preview = rawBuffer.subarray(0, Math.min(rawBuffer.length, 64)).toString('utf8');
      if (/^Content-Length:/i.test(preview.trimStart())) {
        framingMode = 'lsp';
        const sepIdx = rawBuffer.indexOf('\r\n\r\n');
        const lfSepIdx = sepIdx < 0 ? rawBuffer.indexOf('\n\n') : -1;
        const headerEnd = sepIdx >= 0 ? sepIdx : lfSepIdx;
        const sepLen = sepIdx >= 0 ? 4 : 2;
        if (headerEnd < 0) return;
        const headerStr = rawBuffer.subarray(0, headerEnd).toString('utf8');
        const lenMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!lenMatch) {
          rawBuffer = rawBuffer.subarray(headerEnd + sepLen);
          continue;
        }
        const contentLen = Number(lenMatch[1]);
        const totalFrameLen = headerEnd + sepLen + contentLen;
        if (rawBuffer.length < totalFrameLen) return;
        const bodyStr = rawBuffer.subarray(headerEnd + sepLen, totalFrameLen).toString('utf8');
        rawBuffer = rawBuffer.subarray(totalFrameLen);
        try {
          dispatchParsedPayload(JSON.parse(bodyStr), 'lsp');
        } catch {}
        continue;
      }

      const nlIdx = rawBuffer.indexOf(0x0a);
      if (nlIdx < 0) return;
      const lineStr = rawBuffer.subarray(0, nlIdx).toString('utf8').trim();
      rawBuffer = rawBuffer.subarray(nlIdx + 1);
      if (!lineStr) continue;
      try {
        dispatchParsedPayload(JSON.parse(lineStr), framingMode);
      } catch {}
    }
  }

  process.stdin.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    rawBuffer = rawBuffer.length === 0 ? buf : Buffer.concat([rawBuffer, buf]);
    drainInputBuffer();
  });
  process.stdin.resume();
}

if (require.main === module) {
  startMcpPluginHost();
}

module.exports = {
  readPluginVersion,
  readPluginName,
  resolveHostPluginConfigPath,
  detectNonDesktopHost,
  isHostStillAlive,
  shouldRemoveUiOnShutdown,
  handleMcpJsonRpcMessage,
  startMcpPluginHost,
};
