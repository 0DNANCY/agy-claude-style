// Lifecycle helpers for native Antigravity plugin host & Aux Pane sidecar.
// Zero external dependencies (Node >= 22).
const fs = require('fs');
const os = require('os');
const path = require('path');

function isBrokenPipeError(err) {
  if (!err) return false;
  const code = String(err.code || '').toUpperCase();
  return code === 'EPIPE' || code === 'EOF' || code === 'ERR_STREAM_DESTROYED';
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function normalizeLsHealthzUrl(lsAddress) {
  const raw = String(lsAddress || '').trim();
  if (!raw) return null;
  if (raw === 'test.invalid' || raw.includes('test.invalid')) return null;
  if (/^https?:\/\//i.test(raw)) {
    return `${raw.replace(/\/+$/, '')}/healthz`;
  }
  return `http://${raw.replace(/\/+$/, '')}/healthz`;
}

function startHostWatchdog({
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS,
  parentPid = 0,
  watchStdin = false,
  checkIntervalMs = 3000,
  maxLsFailures = 2,
  onShutdown,
} = {}) {
  const healthzUrl = normalizeLsHealthzUrl(lsAddress);
  const ppid = Number.isInteger(parentPid) && parentPid > 0 ? parentPid : 0;
  let stopped = false;
  let triggered = false;
  let lsFailures = 0;
  let polling = false;
  let intervalTimer = null;
  const cleanups = [];

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        fn();
      } catch {}
    }
  };

  const trigger = (reason) => {
    if (stopped || triggered) return;
    triggered = true;
    stop();
    if (typeof onShutdown === 'function') {
      Promise.resolve()
        .then(() => onShutdown(reason))
        .catch(() => {});
    }
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    const handler = () => trigger(`signal:${sig}`);
    try {
      process.on(sig, handler);
      cleanups.push(() => process.off(sig, handler));
    } catch {}
  }

  if (watchStdin && process.stdin) {
    const onEnd = () => trigger('stdin-end');
    const onClose = () => trigger('stdin-close');
    const onErr = (err) => {
      if (isBrokenPipeError(err)) trigger('stdin-error');
    };
    process.stdin.on('end', onEnd);
    process.stdin.on('close', onClose);
    process.stdin.on('error', onErr);
    cleanups.push(() => {
      try {
        process.stdin.off('end', onEnd);
        process.stdin.off('close', onClose);
        process.stdin.off('error', onErr);
      } catch {}
    });
  }

  const checkHost = async () => {
    if (stopped || triggered) return;
    if (ppid > 0 && !isPidAlive(ppid)) {
      trigger('parent-dead');
      return;
    }
    if (!healthzUrl || polling) return;
    polling = true;
    try {
      await fetch(healthzUrl, { signal: AbortSignal.timeout(1500) });
      lsFailures = 0;
    } catch {
      lsFailures += 1;
      if (lsFailures >= Math.max(1, maxLsFailures)) {
        trigger('ls-dead');
      }
    } finally {
      polling = false;
    }
  };

  if (ppid > 0 || healthzUrl) {
    intervalTimer = setInterval(() => {
      void checkHost();
    }, Math.max(100, checkIntervalMs));
    if (typeof intervalTimer.unref === 'function') {
      intervalTimer.unref();
    }
  }

  return {
    stop,
    isTriggered: () => triggered,
    checkNow: checkHost,
  };
}

function getMcpHostsDir(stateDir) {
  return path.join(stateDir, '.mcp-hosts');
}

function registerMcpHost({
  stateDir,
  pid = process.pid,
  lsAddress = '',
  startedAt = new Date().toISOString(),
} = {}) {
  const dir = getMcpHostsDir(stateDir);
  const filePath = path.join(dir, `${pid}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ pid, lsAddress: String(lsAddress || ''), startedAt }, null, 2) + '\n',
      'utf8'
    );
  } catch {}
  return {
    filePath,
    unregister() {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {}
    },
  };
}

function listAliveMcpHosts({
  stateDir,
  excludePid = 0,
  pruneStale = true,
  isAliveFn = isPidAlive,
} = {}) {
  const dir = getMcpHostsDir(stateDir);
  if (!fs.existsSync(dir)) return [];
  const alive = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(dir, name);
    const pid = parseInt(name.slice(0, -5), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      if (pruneStale) {
        try { fs.unlinkSync(filePath); } catch {}
      }
      continue;
    }
    if (!isAliveFn(pid)) {
      if (pruneStale) {
        try { fs.unlinkSync(filePath); } catch {}
      }
      continue;
    }
    if (pid === excludePid) continue;
    alive.push({ pid, filePath });
  }
  return alive;
}

function readAntigravityPluginEnabledState({
  pluginName = 'agy-claude-style',
  configPath = path.join(os.homedir(), '.gemini', 'config', 'config.json'),
} = {}) {
  if (!configPath) return 'unknown';
  try {
    if (!fs.existsSync(configPath)) return 'unknown';
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const entry = parsed?.plugins?.[pluginName];
    if (entry && typeof entry.enabled === 'boolean') {
      return entry.enabled ? 'enabled' : 'disabled';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function removeInjectedUiFromReachablePages(cdpApi, { timeoutMs = 1500 } = {}) {
  const run = async () => {
    const port = cdpApi.readPort();
    if (!port) return 0;
    const pages = await cdpApi.listPages(port);
    if (!pages || pages.length === 0) return 0;
    let removed = 0;
    await Promise.allSettled(
      pages.map(async (page) => {
        const session = await cdpApi.CdpSession.connect(page.webSocketDebuggerUrl, 900);
        try {
          await session.evaluate(cdpApi.REMOVE_EXPRESSION);
          removed += 1;
        } finally {
          session.close();
        }
      })
    );
    return removed;
  };
  const timeout = new Promise((resolve) => {
    const t = setTimeout(() => resolve(0), Math.max(100, Number(timeoutMs) || 1500));
    if (typeof t.unref === 'function') t.unref();
  });
  return await Promise.race([run().catch(() => 0), timeout]);
}

function exitProcessCleanly(code = 0, settleMs = 50) {
  const delay = Math.max(0, Number(settleMs) || 0);
  if (delay === 0) {
    process.exit(code);
    return;
  }
  const t = setTimeout(() => process.exit(code), delay);
  if (typeof t.unref === 'function') t.unref();
}

module.exports = {
  isBrokenPipeError,
  isPidAlive,
  normalizeLsHealthzUrl,
  startHostWatchdog,
  getMcpHostsDir,
  registerMcpHost,
  listAliveMcpHosts,
  readAntigravityPluginEnabledState,
  removeInjectedUiFromReachablePages,
  exitProcessCleanly,
};
