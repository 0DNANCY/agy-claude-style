// Internal CDP injection and hot-reload controller for AGY Claude Style (agy-claude-style).
// Invoked exclusively by native Antigravity Desktop plugin hosts (sidecars/panel/main.mjs and plugin/mcp-host.js).
const fs = require('fs');
const path = require('path');
let cdpApi = require('./cdp');
const { createWallpaperMediaServer, isSafeWallpaperFileName } = require('./wallpaper-server');
const {
  PID_FILE,
  SETTING_BINDING,
} = cdpApi;

function getWallpapersDir() {
  return path.join(cdpApi.STATE_DIR || __dirname, 'wallpapers');
}

function readWallpaperChunkForCdp(fileName, offset = 0, length = 524288) {
  const wallpapersDir = getWallpapersDir();
  if (!isSafeWallpaperFileName(fileName) || !fs.existsSync(wallpapersDir)) {
    return { ok: false, error: 'Wallpaper not found' };
  }
  const realRoot = fs.realpathSync(wallpapersDir);
  const abs = path.resolve(realRoot, fileName);
  if (!abs.startsWith(realRoot + path.sep) || !fs.existsSync(abs)) {
    return { ok: false, error: 'Wallpaper not found' };
  }
  const st = fs.statSync(abs);
  const safeOffset = Math.max(0, Math.min(st.size, Number(offset) || 0));
  const safeLen = Math.max(1, Math.min(524288, Number(length) || 524288));
  const toRead = Math.max(0, Math.min(safeLen, st.size - safeOffset));
  const ext = path.extname(fileName).toLowerCase();
  const { WALLPAPER_MIME_BY_EXT } = require('./wallpaper-server');
  const mime = WALLPAPER_MIME_BY_EXT[ext] || 'application/octet-stream';
  if (toRead === 0) {
    return { ok: true, base64: '', offset: safeOffset, nextOffset: safeOffset, totalSize: st.size, mime, eof: true };
  }
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(toRead);
    const bytesRead = fs.readSync(fd, buf, 0, toRead, safeOffset);
    const nextOffset = safeOffset + bytesRead;
    return {
      ok: true,
      base64: buf.subarray(0, bytesRead).toString('base64'),
      offset: safeOffset,
      nextOffset,
      totalSize: st.size,
      mime,
      eof: nextOffset >= st.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

const LOG_FILE = path.join(cdpApi.STATE_DIR || __dirname, 'watch.log');
const POLL_INTERVAL_MS = Math.max(
  100,
  Math.min(10000, parseInt(process.env.AG_WATCH_POLL_MS || '', 10) || 2000)
);

let consoleLoggingEnabled = false;
let activeLogFile = LOG_FILE;
let lastDuplicateLogPid = null;

function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  if (consoleLoggingEnabled) {
    try {
      console.log(line);
    } catch {}
  }
  if (!consoleLoggingEnabled && activeLogFile) {
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
  const cfg = cdpApi.readConfig();
  const codeHash = cdpApi.computeHash(cdpApi.readRuntimeBundle());
  const configExpr =
    typeof cdpApi.buildConfigScriptExpression === 'function'
      ? cdpApi.buildConfigScriptExpression(cfg, codeHash)
      : null;
  let wallpaperMeta = null;
  if (cfg.wpMode && cfg.wpMode !== 'off' && cfg.wpFile) {
    const tmpSrv = createWallpaperMediaServer({ wallpapersDir: getWallpapersDir() });
    wallpaperMeta = tmpSrv.resolveActiveMeta(cfg.wpFile);
  }
  const expr = cdpApi.buildInjectExpression(cfg, { wallpaperMeta });
  for (const page of pages) {
    const session = await cdpApi.CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      if (configExpr) await session.evaluate(configExpr).catch(() => null);
      const res = await session.evaluate(expr);
      log(`[✓] ${shortTitle(page)} (agy-claude-style ${res.version} · 状态: ${res.status})`);
    } finally {
      session.close();
    }
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
  const replaceExisting = Boolean(opts.replaceExisting);
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
      if (duplicateWaitMs > 0) {
        const deadline = Date.now() + duplicateWaitMs;
        while (Date.now() < deadline && aliveCheck(pid)) {
          sleepSync(100);
        }
      }
      if (aliveCheck(pid)) {
        if (!opts.quietDuplicateLog || lastDuplicateLogPid !== pid) {
          lastDuplicateLogPid = pid;
          log(`[*] 监听进程已在运行 (PID ${pid})，跳过重复启动`);
        }
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
        if (!opts.quietDuplicateLog || lastDuplicateLogPid !== reDecision.pid) {
          lastDuplicateLogPid = reDecision.pid;
          log(`[*] 监听进程已在运行 (PID ${reDecision.pid})，跳过重复启动`);
        }
        return { acquired: false, duplicate: true, pid: reDecision.pid };
      }
    } else {
      console.error(`[!] 插件宿主监听进程已在运行 (PID ${pid})`);
      return exitFn(1, { blocked: true, reason: 'already-running', pid });
    }
  }

  // Only reached when action is 'write', 'clear' (dead/foreign/invalid), or 'owned' resolved via --replace / prior exit.
  lastDuplicateLogPid = null;
  cdpApi.writeFileAtomic(pidFile, String(opts.selfPid || process.pid));
  if (!opts.skipExitHook) {
    process.removeListener('exit', releasePidFile);
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
  allowGracefulDuplicateExit = true,
  allowAutoRelaunch = true,
  enableConsole = false,
  logFile = LOG_FILE,
  duplicateWaitMs = 0,
  quietDuplicateLog = true,
} = {}) {
  consoleLoggingEnabled = Boolean(enableConsole);
  if (logFile) activeLogFile = logFile;
  const lockRes = acquireLock({
    allowGracefulDuplicateExit,
    duplicateWaitMs,
    quietDuplicateLog,
    exitFn: () => ({ acquired: false }),
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
    `[*] AGY Claude Style (agy-claude-style) 原生插件监听启动 (PID ${process.pid})，每 ${POLL_INTERVAL_MS / 1000} 秒检查一次窗口`
  );

  const attached = new Map();
  let currentConfig = cdpApi.readConfig();
  let currentCodeHash = cdpApi.computeHash(cdpApi.readRuntimeBundle());
  let currentCssHash = cdpApi.computeHash(cdpApi.readCss());
  const wpMediaServer = createWallpaperMediaServer({ wallpapersDir: getWallpapersDir() });
  async function resolveCurrentWallpaperMeta(cfgObj) {
    const targetCfg = cfgObj || currentConfig;
    if (!targetCfg || targetCfg.wpMode === 'off' || !targetCfg.wpFile) return null;
    if (!wpMediaServer.getPort()) {
      try {
        await wpMediaServer.ensureStarted();
      } catch {}
    }
    return wpMediaServer.resolveActiveMeta(targetCfg.wpFile);
  }
  let currentWpMeta = await resolveCurrentWallpaperMeta(currentConfig);
  let expr = cdpApi.buildInjectExpression(currentConfig, { wallpaperMeta: currentWpMeta });
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

  async function stop({ removeFromPages = false, reason = '' } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (reason) emitLog(`[*] 监听控制器退出: ${reason}`);
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
    await wpMediaServer.close().catch(() => {});
    closeAllSessions();
    releasePidFile();
    process.removeListener('exit', releasePidFile);
  }

  async function apply(entry, opts = {}) {
    if (opts.wpMeta !== undefined) {
      await entry.session
        .evaluate(`window.__agClaudeStyle?.setWallpaperMeta?.(${JSON.stringify(opts.wpMeta)})`)
        .catch(() => {});
    }
    return applyPageScripts(entry, { expr, configExpr, refreshOnly: opts.refreshOnly });
  }

  async function attach(page) {
    attached.set(page.id, null);
    try {
      const session = await cdpApi.CdpSession.connect(page.webSocketDebuggerUrl);
      if (shuttingDown) {
        try { session.close(); } catch {}
        attached.delete(page.id);
        return;
      }
      const entry = { session, bootstrapScriptId: null, configScriptId: null };
      attached.set(page.id, entry);
      session.onClose = () => {
        attached.delete(page.id);
        log(`[-] 窗口已关闭: ${shortTitle(page)}`);
      };
      await session.send('Page.enable');
      if (shuttingDown) {
        attached.delete(page.id);
        try { session.onClose = null; session.close(); } catch {}
        return;
      }
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
          if (key === '__wallpaperRead' && value && typeof value === 'object') {
            const reqId = typeof value.reqId === 'string' ? value.reqId : '';
            const reply = (() => {
              try {
                return readWallpaperChunkForCdp(value.file, value.offset, value.length);
              } catch (err) {
                return { ok: false, error: err?.message || String(err) };
              }
            })();
            if (reqId) {
              session
                .send('Runtime.evaluate', {
                  expression: `window.__agCsWallpaperChunkReply?.(${JSON.stringify(reqId)}, ${JSON.stringify(reply)})`,
                })
                .catch(() => {});
            }
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
            proxyMismatchCheckedSig = '';
            proxyMismatchLastCheckAt = 0;
            log(`[⚙] 设置已保存: ${key} = ${JSON.stringify(value)}`);
          }
        } catch {}
      });
      await session.send('Runtime.enable');
      await session.send('Runtime.addBinding', { name: SETTING_BINDING });
      if (shuttingDown) {
        attached.delete(page.id);
        try { session.onClose = null; session.close(); } catch {}
        return;
      }
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
  let proxyMismatchLastCheckAt = 0;
  const PROXY_MISMATCH_RECHECK_MS = 30000;

  async function tick() {
    if (busy || shuttingDown) return;
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
        const expectedProxyKey = `${port}|${currentConfig.proxyUrl || ''}`;
        const nowMs = Date.now();
        const shouldCheckProxyMismatch =
          allowAutoRelaunch &&
          currentConfig.proxyEnabled === true &&
          !process.env.AG_CDP_PORT &&
          typeof cdpApi.hasConfiguredProxyFlag === 'function' &&
          (proxyMismatchCheckedSig !== expectedProxyKey || nowMs - proxyMismatchLastCheckAt >= PROXY_MISMATCH_RECHECK_MS);
        if (shouldCheckProxyMismatch) {
          proxyMismatchLastCheckAt = nowMs;
          const proc = cdpApi.detectAntigravityProcess();
          const pids = Array.isArray(proc?.pids) ? proc.pids : [];
          const pidSig = pids.slice().sort((a, b) => a - b).join(',');
          const checkKey = `${port}|${pidSig}|${currentConfig.proxyUrl || ''}`;
          if (proc?.running && pidSig && proxyMismatchCheckedSig !== checkKey) {
            const pCheck = cdpApi.hasConfiguredProxyFlag(pids, currentConfig);
            if (!pCheck.required || !pCheck.inspected || pCheck.matched) {
              proxyMismatchCheckedSig = checkKey;
              if (pCheck.inspected && pCheck.matched) {
                warnedGuardSig = '';
                if (typeof cdpApi.resetRelaunchGuard === 'function') {
                  cdpApi.resetRelaunchGuard({ markSuccess: true });
                }
              }
            } else {
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
              } else if (typeof cdpApi.isRelaunchInProgress === 'function' && cdpApi.isRelaunchInProgress()) {
                log('[*] 检测到已有重启任务进行中，跳过重复代理重启调度');
              } else {
                const proxyOpts = cdpApi.buildProxyLaunchOptionsFromConfig(currentConfig);
                log('[↻] 检测到 Antigravity 已开启 CDP 但未进入已保存的独立代理，正在优雅重启并应用代理...');
                const res = await cdpApi.relaunchAntigravityWithCdp({
                  port: 0,
                  detached: true,
                  extraArgs: proxyOpts.args,
                  extraEnv: proxyOpts.env,
                });
                if (res.reason === 'relaunch-in-progress') {
                  log('[*] 检测到已有重启任务进行中，跳过重复代理重启调度');
                } else {
                  proxyMismatchCheckedSig = checkKey;
                  if (typeof cdpApi.recordAutoRelaunchAttempt === 'function') {
                    cdpApi.recordAutoRelaunchAttempt({ pidSig: guardPidSig, reason: 'cold-start-no-proxy' });
                  }
                  if (res.relaunched) {
                    proxyMismatchRelaunched = true;
                    log('[✓] 已调度后台重启 Antigravity（CDP + 独立代理模式），等待新窗口就绪...');
                  }
                }
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
              } else if (typeof cdpApi.isRelaunchInProgress === 'function' && cdpApi.isRelaunchInProgress()) {
                log('[*] 检测到已有重启任务进行中，跳过本次冷启动重复重启');
              } else {
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
                if (res.reason === 'relaunch-in-progress') {
                  log('[*] 检测到已有重启任务进行中，跳过本次冷启动重复重启');
                } else {
                  if (typeof cdpApi.recordAutoRelaunchAttempt === 'function') {
                    cdpApi.recordAutoRelaunchAttempt({ pidSig, reason: 'cold-start-no-cdp' });
                  }
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
          }
        } else {
          noCdpRunningTicks = 0;
          warnedNoCdpSig = '';
          cdpFlagCache = { pidSig: '', hasFlag: false };
          if (consecutivePortFailures >= 3) {
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
        currentWpMeta = await resolveCurrentWallpaperMeta(currentConfig);
        if (!refreshOnly) {
          expr = cdpApi.buildInjectExpression(currentConfig, { wallpaperMeta: currentWpMeta });
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
          await apply(entry, { refreshOnly, wpMeta: currentWpMeta });
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

  await tick();
  return {
    stop,
    isStopped: () => shuttingDown,
    getAttachedCount: () => attached.size,
  };
}

module.exports = {
  injectOnce,
  createWatchController,
  acquireLock,
  applyPageScripts,
};
