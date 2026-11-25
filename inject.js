// Inject AGY Claude Style (agy-claude-style) into every open Antigravity window over CDP.
//
//   node inject.js            one-shot: inject now and exit
//   node inject.js --watch    daemon mode: auto-inject into new/reloaded windows
//                             and hot-reload style.css / *.js / config.json
//   node inject.js --launch   launch Antigravity with --remote-debugging-port=0
//                             (add --relaunch to restart a running instance without CDP)
//   node inject.js --managed  managed mode (equivalent to --launch --watch --exit-on-host-close):
//                             launch/attach Antigravity with CDP, watch windows, and exit when host closes
//   Options: --exit-on-host-close, --startup-grace <sec> (default 90s), --poll-ms <ms>, --replace
const fs = require('fs');
const path = require('path');
let cdpApi = require('./cdp');
const {
  PID_FILE,
  CONFIG_FILE,
  SETTING_BINDING,
  STARTUP_GRACE_SECONDS,
} = cdpApi;

const MANAGED = process.argv.includes('--managed');
const LAUNCH = MANAGED || process.argv.includes('--launch');
const WATCH = MANAGED || process.argv.includes('--watch');
const RELAUNCH = process.argv.includes('--relaunch');
const REPLACE_EXISTING = process.argv.includes('--replace');
const SKIP_IF_RUNNING = process.argv.includes('--skip-if-running');
const EXIT_ON_HOST_CLOSE_FLAG = MANAGED || process.argv.includes('--exit-on-host-close');
const LOG_FILE = path.join(cdpApi.STATE_DIR || __dirname, 'watch.log');

function parseIntArg(flag, envName) {
  const prefix = `${flag}=`;
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    let raw = null;
    if (arg === flag && i + 1 < process.argv.length) {
      raw = process.argv[i + 1];
    } else if (arg.startsWith(prefix)) {
      raw = arg.slice(prefix.length);
    }
    if (raw !== null) {
      const n = parseInt(raw, 10);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  if (envName && process.env[envName]) {
    const n = parseInt(process.env[envName], 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

const PARENT_PID = parseIntArg('--parent-pid', 'AG_PARENT_PID');
const STARTUP_GRACE_SECONDS_VAL =
  parseIntArg('--startup-grace', 'AG_STARTUP_GRACE_SEC') || STARTUP_GRACE_SECONDS;
const POLL_INTERVAL_MS = Math.max(
  100,
  Math.min(10000, parseIntArg('--poll-ms', 'AG_WATCH_POLL_MS') || 2000)
);

let consoleLoggingEnabled = true;
let activeLogFile = LOG_FILE;

function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  if (consoleLoggingEnabled) {
    try {
      console.log(line);
    } catch {}
  }
  if (WATCH || !consoleLoggingEnabled) {
    try {
      const dir = path.dirname(activeLogFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const stat = fs.existsSync(activeLogFile) ? fs.statSync(activeLogFile) : null;
      if (stat && stat.size > 1024 * 1024) {
        fs.writeFileSync(activeLogFile, '');
      }
      fs.appendFileSync(activeLogFile, `[${new Date().toISOString()}] ${line}\n`);
    } catch {}
  }
}

function shortTitle(page) {
  const t = page.title || page.url;
  return t.length > 60 ? t.slice(0, 57) + '...' : t;
}

async function injectOnce() {
  const port = cdpApi.readPort();
  if (!port) {
    const proc = cdpApi.detectAntigravityProcess();
    throw new Error(cdpApi.formatCdpUnavailableMessage({ running: proc.running, port: null }));
  }
  let pages;
  try {
    pages = await cdpApi.listPages(port);
  } catch {
    const proc = cdpApi.detectAntigravityProcess();
    throw new Error(cdpApi.formatCdpUnavailableMessage({ running: proc.running, port }));
  }
  if (pages.length === 0) throw new Error('未找到 Antigravity 窗口页面');

  log(`[+] 调试端口 ${port}，发现 ${pages.length} 个窗口`);
  const expr = cdpApi.buildInjectExpression();
  for (const page of pages) {
    const session = await cdpApi.CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      const res = await session.evaluate(expr);
      log(`[✓] ${shortTitle(page)} (agy-claude-style ${res.version} · 状态: ${res.status})`);
    } finally {
      session.close();
    }
  }
}

async function launchWithCdp({ autoRelaunchFromConfig = false } = {}) {
  const cfg =
    typeof cdpApi.readEffectiveLaunchConfig === 'function'
      ? cdpApi.readEffectiveLaunchConfig()
      : cdpApi.readConfig();
  const autoRelaunchWithCdp =
    WATCH || autoRelaunchFromConfig ? cfg.autoRelaunchWithCdp === true : false;
  const proxyOpts =
    typeof cdpApi.buildProxyLaunchOptionsFromConfig === 'function'
      ? cdpApi.buildProxyLaunchOptionsFromConfig(cfg)
      : { args: [], env: {} };
  const res = await cdpApi.ensureAntigravityWithCdp({
    port: 0,
    relaunch: RELAUNCH,
    autoRelaunchWithCdp,
    extraArgs: proxyOpts.args,
    extraEnv: proxyOpts.env,
  });
  if (res.action === 'already-cdp') {
    log(`[✓] Antigravity 已在调试端口 ${res.port} 运行 (${res.pagesCount} 个窗口)`);
    return;
  }
  if (res.action === 'waiting-cdp') {
    log(`[*] Antigravity 已携带调试参数启动 (PID: ${res.pids.join(', ')})，等待调试端口就绪...`);
    return;
  }
  if (res.action === 'relaunched') {
    log('[✓] 已重新启动 Antigravity（CDP 远程调试端口已开启）');
    return;
  }
  if (res.action === 'launched') {
    log('[✓] 已以 --remote-debugging-port=0 启动 Antigravity');
    return;
  }
  if (res.action === 'running-without-cdp') {
    throw new Error(
      `Antigravity 正在运行但未开启 CDP 端口（PID: ${res.pids.join(', ')}）。` +
        `请先完全退出 Antigravity，或运行 node inject.js --launch --relaunch 自动重启。`
    );
  }
  if (res.action === 'relaunch-failed') {
    throw new Error(`自动重启失败 (${res.reason})，请手动完全退出 Antigravity 后重试`);
  }
  throw new Error('未找到 Antigravity 可执行程序，请手动以 --remote-debugging-port=0 启动');
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function releasePidFile() {
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {}
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(opts = {}) {
  const pidFile = opts.pidFile || PID_FILE;
  const targetDir = opts.targetDir || __dirname;
  const replaceExisting = opts.replaceExisting !== undefined ? opts.replaceExisting : REPLACE_EXISTING;
  const allowGracefulDuplicateExit = Boolean(opts.allowGracefulDuplicateExit);
  const duplicateWaitMs = Number.isInteger(opts.duplicateWaitMs) && opts.duplicateWaitMs >= 0 ? opts.duplicateWaitMs : 1500;
  const killFn = typeof opts.killFn === 'function' ? opts.killFn : (p, sig) => process.kill(p, sig);
  const exitFn = typeof opts.exitFn === 'function' ? opts.exitFn : (code) => process.exit(code);
  const aliveCheck = (p) => {
    try {
      killFn(p, 0);
      return true;
    } catch (err) {
      return Boolean(err && err.code === 'EPERM');
    }
  };

  const decision = cdpApi.resolveExistingWatchPidAction(pidFile, targetDir, {
    selfPid: opts.selfPid,
    killFn,
    inspectFn: opts.inspectFn,
    platform: opts.platform,
  });

  if (decision.action === 'refuse') {
    const errMsg = `[!] 无法验证 .watch.pid 进程归属 (PID ${decision.pid})，出于安全策略拒绝终止或覆盖锁文件`;
    console.error(errMsg);
    return exitFn(1, { blocked: true, reason: decision.reason || 'unknown', pid: decision.pid });
  }

  if (decision.action === 'owned') {
    const pid = decision.pid;
    if (replaceExisting) {
      try {
        killFn(pid, 'SIGTERM');
      } catch {}
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && aliveCheck(pid)) {
        sleepSync(50);
      }
      if (aliveCheck(pid)) {
        try {
          killFn(pid, 'SIGKILL');
        } catch {}
      }
    } else if (allowGracefulDuplicateExit) {
      const deadline = Date.now() + duplicateWaitMs;
      while (Date.now() < deadline && aliveCheck(pid)) {
        sleepSync(100);
      }
      if (aliveCheck(pid)) {
        log(`[*] 监听进程已在运行 (PID ${pid})，跳过重复启动`);
        return { acquired: false, duplicate: true, pid };
      }
      const reDecision = cdpApi.resolveExistingWatchPidAction(pidFile, targetDir, {
        selfPid: opts.selfPid,
        killFn,
        inspectFn: opts.inspectFn,
        platform: opts.platform,
      });
      if (reDecision.action === 'refuse') {
        const errMsg = `[!] 无法验证 .watch.pid 进程归属 (PID ${reDecision.pid})，出于安全策略拒绝终止或覆盖锁文件`;
        console.error(errMsg);
        return exitFn(1, { blocked: true, reason: reDecision.reason || 'unknown', pid: reDecision.pid });
      }
      if (reDecision.action === 'owned') {
        log(`[*] 监听进程已在运行 (PID ${reDecision.pid})，跳过重复启动`);
        return { acquired: false, duplicate: true, pid: reDecision.pid };
      }
    } else {
      console.error(`[!] 守护进程已在运行 (PID ${pid})。如需重启请先运行 remove.sh / remove.bat 或附加 --replace`);
      return exitFn(1, { blocked: true, reason: 'already-running', pid });
    }
  }

  // Only reached when action is 'write', 'clear' (dead/foreign/invalid), or 'owned' resolved via --replace / prior exit.
  cdpApi.writeFileAtomic(pidFile, String(opts.selfPid || process.pid));
  if (!opts.skipExitHook) {
    process.on('exit', releasePidFile);
  }
  return { acquired: true, replaced: decision.action === 'owned', priorStatus: decision.status };
}

async function applyPageScripts(entry, { expr, configExpr, refreshOnly = false } = {}) {
  if (refreshOnly && configExpr && entry.bootstrapScriptId) {
    if (entry.configScriptId) {
      await entry.session
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.configScriptId })
        .catch(() => {});
      entry.configScriptId = null;
    }
    const { identifier } = await entry.session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: configExpr,
    });
    entry.configScriptId = identifier;
    const fastRes = await entry.session.evaluate(configExpr).catch(() => null);
    if (fastRes && fastRes.status === 'refreshed') return fastRes;
  }

  if (entry.configScriptId) {
    await entry.session
      .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.configScriptId })
      .catch(() => {});
    entry.configScriptId = null;
  }
  if (entry.bootstrapScriptId) {
    await entry.session
      .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.bootstrapScriptId })
      .catch(() => {});
    entry.bootstrapScriptId = null;
  }
  const { identifier: bootstrapId } = await entry.session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: expr,
  });
  entry.bootstrapScriptId = bootstrapId;
  if (configExpr) {
    const { identifier: cfgId } = await entry.session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: configExpr,
    });
    entry.configScriptId = cfgId;
    // Apply latest config override before evaluating (possibly cached) full bootstrap expr.
    await entry.session.evaluate(configExpr).catch(() => null);
  }
  return await entry.session.evaluate(expr);
}

async function createWatchController({
  forceExitOnHostClose = false,
  startupGraceEnabled = false,
  allowGracefulDuplicateExit = false,
  allowAutoRelaunch = true,
  manageProcessExit = true,
  enableConsole = true,
  logFile = LOG_FILE,
} = {}) {
  consoleLoggingEnabled = Boolean(enableConsole);
  if (logFile) activeLogFile = logFile;
  const lockRes = acquireLock({
    allowGracefulDuplicateExit,
    exitFn: manageProcessExit
      ? (code) => process.exit(code)
      : () => ({ acquired: false }),
  });
  if (!lockRes || !lockRes.acquired) return null;
  const emitLog = (...args) => {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (enableConsole) {
      try { console.log(line); } catch {}
    }
    if (logFile) {
      try {
        const dir = path.dirname(logFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const stat = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
        if (stat && stat.size > 1024 * 1024) fs.writeFileSync(logFile, '');
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);
      } catch {}
    }
  };
  try {
    if (logFile) {
      const dir = path.dirname(logFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(logFile, '');
    }
  } catch {}
  emitLog(
    `[*] AGY Claude Style (agy-claude-style) 守护模式启动 (PID ${process.pid})，每 ${POLL_INTERVAL_MS / 1000} 秒检查一次窗口`
  );

  const watchStartedAt = Date.now();
  const startupGraceMs = STARTUP_GRACE_SECONDS_VAL * 1000;
  const effectiveExitOnCloseFlag = EXIT_ON_HOST_CLOSE_FLAG || forceExitOnHostClose;

  const attached = new Map();
  let currentConfig = cdpApi.readConfig();
  let currentCodeHash = cdpApi.computeHash(cdpApi.readRuntimeBundle());
  let currentCssHash = cdpApi.computeHash(cdpApi.readCss());
  let expr = cdpApi.buildInjectExpression(currentConfig);
  let configExpr = cdpApi.buildConfigScriptExpression(currentConfig, currentCodeHash);
  let shuttingDown = false;
  let tickTimer = null;
  let reloadTimer = null;
  let watcher = null;
  let featuresWatcher = null;
  let configDirWatcher = null;

  function closeAllSessions() {
    for (const entry of attached.values()) {
      if (entry && entry.session) {
        try {
          entry.session.onClose = null;
          entry.session.close();
        } catch {}
      }
    }
    attached.clear();
  }

  async function stop({ removeFromPages = false, code = 0, reason = '' } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (reason) emitLog(`[*] 守护进程退出: ${reason}`);
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
    if (watcher) {
      try { watcher.close(); } catch {}
      watcher = null;
    }
    if (featuresWatcher) {
      try { featuresWatcher.close(); } catch {}
      featuresWatcher = null;
    }
    if (configDirWatcher) {
      try { configDirWatcher.close(); } catch {}
      configDirWatcher = null;
    }
    if (removeFromPages) {
      await Promise.allSettled(
        Array.from(attached.values())
          .filter((entry) => entry && entry.session)
          .map((entry) => entry.session.evaluate(cdpApi.REMOVE_EXPRESSION).catch(() => {}))
      );
    }
    closeAllSessions();
    releasePidFile();
    if (manageProcessExit) {
      process.exit(code);
    }
  }

  function shutdown(code = 0, reason = '') {
    void stop({ removeFromPages: false, code, reason });
  }

  if (manageProcessExit) {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
      process.on(sig, () => shutdown(0, `收到信号 ${sig}`));
    }

    // Prevent orphan CPU spin when stdout/stderr pipe disconnects (e.g. ELECTRON_RUN_AS_NODE=1)
    for (const stream of [process.stdout, process.stderr]) {
      if (stream && typeof stream.on === 'function') {
        stream.on('error', (err) => {
          if (err && (err.code === 'EPIPE' || err.code === 'EOF' || err.code === 'ERR_STREAM_DESTROYED')) {
            shutdown(0);
          }
        });
      }
    }
    if ((PARENT_PID || process.env.ELECTRON_RUN_AS_NODE === '1') && process.stdin && !process.stdin.isTTY) {
      try {
        const st = fs.fstatSync(0);
        if (st.isFIFO() || st.isSocket()) {
          process.stdin.resume();
          process.stdin.on('end', () => shutdown(0, '标准输入管道已关闭'));
          process.stdin.on('close', () => shutdown(0, '标准输入管道已断开'));
        }
      } catch {}
    }
  }

  async function apply(entry, opts = {}) {
    return applyPageScripts(entry, { expr, configExpr, refreshOnly: opts.refreshOnly });
  }

  async function attach(page) {
    attached.set(page.id, null);
    try {
      const session = await cdpApi.CdpSession.connect(page.webSocketDebuggerUrl);
      const entry = { session, bootstrapScriptId: null, configScriptId: null };
      attached.set(page.id, entry);
      session.onClose = () => {
        attached.delete(page.id);
        log(`[-] 窗口已关闭: ${shortTitle(page)}`);
      };
      await session.send('Page.enable');
      session.on('Runtime.bindingCalled', ({ name, payload }) => {
        if (name !== SETTING_BINDING) return;
        try {
          const { key, value } = JSON.parse(payload);
          if (key === '__fileAction' && value && typeof value === 'object') {
            const reqId = typeof value.reqId === 'string' && value.reqId ? value.reqId : '';
            import('./sidecars/panel/lib/file-actions.mjs')
              .then((m) => m.dispatchFileAction(value))
              .then((res) => {
                if (reqId) {
                  session
                    .send('Runtime.evaluate', {
                      expression: `window.__agCsFileActionReply?.(${JSON.stringify(reqId)}, ${JSON.stringify(res || { ok: true })})`,
                    })
                    .catch(() => {});
                }
              })
              .catch((err) => {
                const msg = err && err.message ? err.message : String(err);
                log(`[!] 文件操作失败: ${msg}`);
                if (reqId) {
                  session
                    .send('Runtime.evaluate', {
                      expression: `window.__agCsFileActionReply?.(${JSON.stringify(reqId)}, ${JSON.stringify({ ok: false, error: msg })})`,
                    })
                    .catch(() => {});
                }
              });
            return;
          }
          if (key === '__windowAction' && value === 'hide') {
            if (typeof cdpApi.hideAntigravityWindow === 'function') {
              cdpApi.hideAntigravityWindow();
            }
            return;
          }
          if (cdpApi.updateConfigSetting(key, value)) {
            currentConfig = cdpApi.readConfig();
            log(`[⚙] 设置已保存: ${key} = ${JSON.stringify(value)}`);
          }
        } catch {}
      });
      await session.send('Runtime.enable');
      await session.send('Runtime.addBinding', { name: SETTING_BINDING });
      const res = await apply(entry);
      hadAttachedWindow = true;
      log(`[✓] 已注入 agy-claude-style: ${shortTitle(page)} (${res.status})`);
    } catch (err) {
      const entry = attached.get(page.id);
      if (entry) entry.session.close();
      attached.delete(page.id);
      log(`[!] 注入失败，稍后重试: ${shortTitle(page)} — ${err.message}`);
    }
  }

  let busy = false;
  let lastPort = null;
  let hadAttachedWindow = false;
  let consecutivePortFailures = 0;
  let noCdpRunningTicks = 0;
  let warnedNoCdpSig = '';
  let warnedGuardSig = '';
  let cdpFlagCache = { pidSig: '', hasFlag: false };
  let proxyMismatchCheckedSig = '';

  async function tick() {
    if (busy || shuttingDown) return;
    if (PARENT_PID && !isAlive(PARENT_PID)) {
      shutdown(0, `父进程 ${PARENT_PID} 已退出`);
      return;
    }
    busy = true;
    let nextDelayMs = POLL_INTERVAL_MS;
    try {
      const port = cdpApi.readPort();
      let pages = null;
      if (port) {
        try {
          pages = await cdpApi.listPages(port);
        } catch {
          pages = null;
        }
      }

      if (port && pages !== null) {
        consecutivePortFailures = 0;
        noCdpRunningTicks = 0;
        warnedNoCdpSig = '';
        cdpFlagCache = { pidSig: '', hasFlag: false };

        let proxyMismatchRelaunched = false;
        if (
          allowAutoRelaunch &&
          currentConfig.proxyEnabled === true &&
          !process.env.AG_CDP_PORT &&
          typeof cdpApi.hasConfiguredProxyFlag === 'function'
        ) {
          const proc = cdpApi.detectAntigravityProcess();
          const pids = Array.isArray(proc?.pids) ? proc.pids : [];
          const pidSig = pids.slice().sort((a, b) => a - b).join(',');
          const checkKey = `${pidSig}|${currentConfig.proxyUrl || ''}`;
          if (proc?.running && pidSig && proxyMismatchCheckedSig !== checkKey) {
            const pCheck = cdpApi.hasConfiguredProxyFlag(pids, currentConfig);
            if (pCheck.required && pCheck.inspected && !pCheck.matched) {
              const guard = typeof cdpApi.readRelaunchGuard === 'function' ? cdpApi.readRelaunchGuard() : null;
              const guardPidSig = `proxy:${pidSig}`;
              const evalRes =
                typeof cdpApi.evaluateAutoRelaunchGuard === 'function'
                  ? cdpApi.evaluateAutoRelaunchGuard(guard, { pidSig: guardPidSig, nowMs: Date.now() })
                  : { allowed: true };
              if (!evalRes.allowed) {
                proxyMismatchCheckedSig = checkKey;
                const gSig = `${evalRes.reason}:${guardPidSig}`;
                if (warnedGuardSig !== gSig) {
                  warnedGuardSig = gSig;
                  log(`[*] 检测到 Antigravity 未携带已配置的独立代理，但处于自动重启保护 (${evalRes.reason})，已跳过`);
                }
              } else {
                proxyMismatchCheckedSig = checkKey;
                if (typeof cdpApi.recordAutoRelaunchAttempt === 'function') {
                  cdpApi.recordAutoRelaunchAttempt({ pidSig: guardPidSig, reason: 'cold-start-no-proxy' });
                }
                const proxyOpts = cdpApi.buildProxyLaunchOptionsFromConfig(currentConfig);
                log('[↻] 检测到 Antigravity 已开启 CDP 但未进入已保存的独立代理，正在优雅重启并应用代理...');
                const res = await cdpApi.relaunchAntigravityWithCdp({
                  port: 0,
                  detached: true,
                  extraArgs: proxyOpts.args,
                  extraEnv: proxyOpts.env,
                });
                if (res.relaunched) {
                  proxyMismatchRelaunched = true;
                  log('[✓] 已调度后台重启 Antigravity（CDP + 独立代理模式），等待新窗口就绪...');
                }
              }
            } else if (pCheck.inspected && pCheck.matched) {
              proxyMismatchCheckedSig = checkKey;
              warnedGuardSig = '';
              if (typeof cdpApi.resetRelaunchGuard === 'function') {
                cdpApi.resetRelaunchGuard({ markSuccess: true });
              }
            }
          }
        } else {
          warnedGuardSig = '';
          if (typeof cdpApi.resetRelaunchGuard === 'function') {
            cdpApi.resetRelaunchGuard({ markSuccess: true });
          }
        }

        if (!proxyMismatchRelaunched) {
          if (port !== lastPort) {
            closeAllSessions();
            log(`[+] 连接到调试端口 ${port}`);
            lastPort = port;
          }
          await Promise.all(pages.filter((p) => !attached.has(p.id)).map(attach));
        }
      } else {
        consecutivePortFailures++;
        if (consecutivePortFailures >= 3 && (attached.size > 0 || lastPort !== null)) {
          closeAllSessions();
          lastPort = null;
        }

        const proc = process.env.AG_CDP_PORT ? { running: false, pids: [] } : cdpApi.detectAntigravityProcess();
        const shouldExitOnClose = effectiveExitOnCloseFlag || currentConfig.exitOnHostClose === true;
        if (shouldExitOnClose && hadAttachedWindow && attached.size === 0 && consecutivePortFailures >= 3 && !proc.running) {
          shutdown(0, 'Antigravity 宿主已关闭');
          return;
        }
        if (
          shouldExitOnClose &&
          startupGraceEnabled &&
          !hadAttachedWindow &&
          attached.size === 0 &&
          consecutivePortFailures >= 2 &&
          !proc.running &&
          Date.now() - watchStartedAt >= startupGraceMs
        ) {
          shutdown(0, `启动超过 ${STARTUP_GRACE_SECONDS_VAL} 秒仍未检测到 Antigravity CDP 端口`);
          return;
        }

        if (proc.running) {
          noCdpRunningTicks++;
          const pidSig = proc.pids.slice().sort((a, b) => a - b).join(',');
          if (cdpFlagCache.pidSig !== pidSig) {
            cdpFlagCache = { pidSig, hasFlag: cdpApi.hasRemoteDebuggingFlag(proc.pids) };
          }
          if (cdpFlagCache.hasFlag) {
            if (noCdpRunningTicks >= 3 && warnedNoCdpSig !== `cdp:${pidSig}`) {
              warnedNoCdpSig = `cdp:${pidSig}`;
              log('[*] 检测到 Antigravity 已携带 --remote-debugging-port 参数，继续等待调试端口响应...');
            }
          } else {
            if (warnedNoCdpSig !== pidSig) {
              warnedNoCdpSig = pidSig;
              log(`[!] ${cdpApi.formatCdpUnavailableMessage({ running: true, port })}`);
              if (!currentConfig.autoRelaunchWithCdp) {
                log('[*] 提示：可在 config.json 中设置 "autoRelaunchWithCdp": true 以启用自动温和重启接管');
              }
            }
            if (allowAutoRelaunch && (currentConfig.autoRelaunchWithCdp === true || currentConfig.proxyEnabled === true)) {
              const guard = typeof cdpApi.readRelaunchGuard === 'function' ? cdpApi.readRelaunchGuard() : null;
              const evalRes =
                typeof cdpApi.evaluateAutoRelaunchGuard === 'function'
                  ? cdpApi.evaluateAutoRelaunchGuard(guard, { pidSig, nowMs: Date.now() })
                  : { allowed: true };
              if (!evalRes.allowed) {
                const gSig = `${evalRes.reason}:${pidSig}`;
                if (warnedGuardSig !== gSig) {
                  warnedGuardSig = gSig;
                  if (evalRes.reason === 'circuit-breaker') {
                    log('[!] 自动重启连续失败已达熔断上限（2 次），已暂停自动重启；请在控制室手动点击「立即重启启用」');
                  } else if (evalRes.reason === 'cooldown') {
                    const sec = Math.ceil((evalRes.remainingCooldownMs || 0) / 1000);
                    log(`[*] 自动重启冷却保护中（剩余 ${sec}s），跳过本次冷启动自动重启`);
                  }
                }
              } else {
                if (typeof cdpApi.recordAutoRelaunchAttempt === 'function') {
                  cdpApi.recordAutoRelaunchAttempt({ pidSig, reason: 'cold-start-no-cdp' });
                }
                const proxyOpts =
                  typeof cdpApi.buildProxyLaunchOptionsFromConfig === 'function'
                    ? cdpApi.buildProxyLaunchOptionsFromConfig(currentConfig)
                    : { args: [], env: {} };
                log(
                  `[↻] 冷启动未检测到 CDP，正在优雅重启原版 Antigravity 并附加 --remote-debugging-port=0${proxyOpts.args.length ? ' + 独立代理' : ''} ...`
                );
                const res = await cdpApi.relaunchAntigravityWithCdp({
                  port: 0,
                  detached: true,
                  extraArgs: proxyOpts.args,
                  extraEnv: proxyOpts.env,
                });
                if (res.relaunched) {
                  log('[✓] 已调度后台重启 Antigravity（CDP 模式），等待新窗口就绪...');
                  noCdpRunningTicks = 0;
                  cdpFlagCache = { pidSig: '', hasFlag: false };
                } else {
                  log(`[!] 自动重启未完成 (${res.reason})，请手动完全退出 Antigravity 后以 --remote-debugging-port=0 启动`);
                }
              }
            }
          }
        } else {
          noCdpRunningTicks = 0;
          warnedNoCdpSig = '';
          cdpFlagCache = { pidSig: '', hasFlag: false };
          if (consecutivePortFailures >= 3 && !(startupGraceEnabled && !hadAttachedWindow)) {
            nextDelayMs = Math.max(5000, POLL_INTERVAL_MS);
          }
        }
      }
    } finally {
      busy = false;
      if (!shuttingDown) {
        tickTimer = setTimeout(tick, nextDelayMs);
      }
    }
  }

  const scheduleHotReload = (filename) => {
    if (shuttingDown) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      let refreshOnly = false;
      try {
        delete require.cache[require.resolve('./cdp')];
        cdpApi = require('./cdp');
        currentConfig = cdpApi.readConfig();
        const nextCodeHash = cdpApi.computeHash(cdpApi.readRuntimeBundle());
        const nextCssHash = cdpApi.computeHash(cdpApi.readCss());
        refreshOnly =
          Boolean(currentCodeHash) &&
          nextCodeHash === currentCodeHash &&
          nextCssHash === currentCssHash;
        currentCodeHash = nextCodeHash;
        currentCssHash = nextCssHash;
        if (!refreshOnly) {
          expr = cdpApi.buildInjectExpression(currentConfig);
        }
        configExpr = cdpApi.buildConfigScriptExpression(currentConfig, currentCodeHash);
      } catch (err) {
        emitLog(`[!] 读取文件失败: ${err.message}`);
        return;
      }
      let n = 0;
      for (const entry of attached.values()) {
        if (!entry) continue;
        try {
          await apply(entry, { refreshOnly });
          n++;
        } catch {}
      }
      emitLog(`[↻] ${filename} 已变更，已热更新 ${n} 个窗口${refreshOnly ? '（轻量配置同步）' : ''}`);
    }, 120);
  };

  watcher = fs.watch(__dirname, (_, filename) => {
    if (!filename || !/\.(css|js|json)$/i.test(filename) || filename.startsWith('.')) return;
    scheduleHotReload(filename);
  });

  const featuresDir = path.join(__dirname, 'features');
  if (fs.existsSync(featuresDir)) {
    try {
      featuresWatcher = fs.watch(featuresDir, (_, filename) => {
        if (!filename || !/\.js$/i.test(filename) || filename.startsWith('.')) return;
        scheduleHotReload(`features/${filename}`);
      });
      if (typeof featuresWatcher.unref === 'function') featuresWatcher.unref();
    } catch {}
  }

  const cfgDir = path.dirname(cdpApi.CONFIG_FILE);
  const cfgBase = path.basename(cdpApi.CONFIG_FILE);
  const sameConfigDir =
    process.platform === 'win32'
      ? path.resolve(cfgDir).toLowerCase() === path.resolve(__dirname).toLowerCase()
      : path.resolve(cfgDir) === path.resolve(__dirname);
  if (!sameConfigDir) {
    try {
      if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
      configDirWatcher = fs.watch(cfgDir, (_, filename) => {
        if (!filename || String(filename) === cfgBase) {
          scheduleHotReload(cfgBase);
        }
      });
      if (typeof configDirWatcher.unref === 'function') configDirWatcher.unref();
    } catch {}
  }

  if (WATCH && manageProcessExit) {
    process.on('uncaughtException', (err) => {
      emitLog(`[!] 未捕获异常: ${err && err.stack ? err.stack : err}`);
    });
    process.on('unhandledRejection', (err) => {
      emitLog(`[!] 未处理 Promise 拒绝: ${err && err.stack ? err.stack : err}`);
    });
  }

  await tick();
  return {
    stop,
    isStopped: () => shuttingDown,
    getAttachedCount: () => attached.size,
  };
}

async function watch(opts = {}) {
  return createWatchController({ ...opts, manageProcessExit: true });
}

async function main() {
  if (LAUNCH && WATCH) {
    await launchWithCdp({ autoRelaunchFromConfig: true });
    await watch({
      forceExitOnHostClose: true,
      startupGraceEnabled: true,
      allowGracefulDuplicateExit: true,
    });
  } else if (LAUNCH) {
    await launchWithCdp({ autoRelaunchFromConfig: false });
  } else if (WATCH) {
    await watch({
      forceExitOnHostClose: false,
      startupGraceEnabled: EXIT_ON_HOST_CLOSE_FLAG,
      allowGracefulDuplicateExit: SKIP_IF_RUNNING,
    });
  } else {
    await injectOnce();
  }
}

module.exports = {
  injectOnce,
  createWatchController,
  acquireLock,
  applyPageScripts,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[✗] ${err.message}`);
    process.exit(1);
  });
}
