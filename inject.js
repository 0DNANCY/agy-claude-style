// Inject AGY Claude Style (agy-claude-style) into every open Antigravity window over CDP.
//
//   node inject.js           one-shot: inject now and exit
//   node inject.js --watch   daemon mode: auto-inject into new/reloaded windows
//                            and hot-reload style.css / *.js / config.json
//   node inject.js --launch  launch Antigravity with --remote-debugging-port=0
//                            (add --relaunch to restart a running instance without CDP)
const fs = require('fs');
const path = require('path');
const {
  PORT_FILE,
  PID_FILE,
  CONFIG_FILE,
  SETTING_BINDING,
  readConfig,
  readPort,
  listPages,
  detectAntigravityProcess,
  launchAntigravityWithCdp,
  relaunchAntigravityWithCdp,
  formatCdpUnavailableMessage,
  CdpSession,
  buildInjectExpression,
} = require('./cdp');

const WATCH = process.argv.includes('--watch');
const LAUNCH = process.argv.includes('--launch');
const RELAUNCH = process.argv.includes('--relaunch');
const REPLACE_EXISTING = process.argv.includes('--replace');
const EXIT_ON_HOST_CLOSE_FLAG = process.argv.includes('--exit-on-host-close');
const LOG_FILE = path.join(__dirname, 'watch.log');

function parseIntArg(flag, envName) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const n = parseInt(process.argv[idx + 1], 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  if (envName && process.env[envName]) {
    const n = parseInt(process.env[envName], 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

const PARENT_PID = parseIntArg('--parent-pid', 'AG_PARENT_PID');

function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try {
    console.log(line);
  } catch {}
  if (WATCH) {
    try {
      const stat = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
      if (stat && stat.size > 1024 * 1024) {
        fs.writeFileSync(LOG_FILE, '');
      }
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
    } catch {}
  }
}

function shortTitle(page) {
  const t = page.title || page.url;
  return t.length > 60 ? t.slice(0, 57) + '...' : t;
}

function updateConfigSetting(key, value) {
  const validators = {
    language: (v) => v === 'zh-CN' || v === 'zh-TW' || v === 'yue' || v === 'en' || v === 'ja',
    palette: (v) => v === 'obsidian' || v === 'claude' || v === 'host',
    homeLayout: (v) => v === 'studio' || v === 'classic' || v === 'off',
    homeRipple: (v) => typeof v === 'boolean',
    composerRestyle: (v) => typeof v === 'boolean',
    mascot: (v) => v === 'crab' || v === 'off',
    logoInk: (v) => v === 'accent' || v === 'foreground',
    inlineStats: (v) => typeof v === 'boolean',
    ringMode: (v) => v === 'context' || v === 'quota',
    turnBadges: (v) => typeof v === 'boolean',
    hudTopBar: (v) => typeof v === 'boolean',
    hudBottomBar: (v) => typeof v === 'boolean',
    hudRimProgress: (v) => typeof v === 'boolean',
    hudFooterChip: (v) => typeof v === 'boolean',
    hudCompact: (v) => typeof v === 'boolean',
    effortSliderStyle: (v) => v === 'claude' || v === 'chatgpt' || v === 'liangwufeng',
    effortAccent: (v) => typeof v === 'boolean',
    performanceBackdrop: (v) => v === 'off' || v === 'card' || v === 'page',
    smoothCaret: (v) => typeof v === 'boolean',
    sidebarRestyle: (v) => typeof v === 'boolean',
    sidebarCompact: (v) => typeof v === 'boolean',
    placeholderStyle: (v) => v === 'studio' || v === 'host',
    autoRelaunchWithCdp: (v) => typeof v === 'boolean',
    exitOnHostClose: (v) => typeof v === 'boolean',
  };
  if (!Object.prototype.hasOwnProperty.call(validators, key) || !validators[key](value)) return false;
  const next = { ...readConfig(), [key]: value };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
  return true;
}

async function injectOnce() {
  const port = readPort();
  if (!port) {
    const proc = detectAntigravityProcess();
    throw new Error(formatCdpUnavailableMessage({ running: proc.running, port: null }));
  }
  let pages;
  try {
    pages = await listPages(port);
  } catch {
    const proc = detectAntigravityProcess();
    throw new Error(formatCdpUnavailableMessage({ running: proc.running, port }));
  }
  if (pages.length === 0) throw new Error('未找到 Antigravity 窗口页面');

  log(`[+] 调试端口 ${port}，发现 ${pages.length} 个窗口`);
  const expr = buildInjectExpression();
  for (const page of pages) {
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      const res = await session.evaluate(expr);
      log(`[✓] ${shortTitle(page)} (agy-claude-style ${res.version} · 状态: ${res.status})`);
    } finally {
      session.close();
    }
  }
}

async function launchWithCdp() {
  const port = readPort();
  if (port) {
    try {
      const pages = await listPages(port);
      if (pages.length > 0) {
        log(`[✓] Antigravity 已在调试端口 ${port} 运行 (${pages.length} 个窗口)`);
        return;
      }
    } catch {}
  }
  const proc = detectAntigravityProcess();
  if (proc.running) {
    if (!RELAUNCH) {
      throw new Error(
        `Antigravity 正在运行但未开启 CDP 端口（PID: ${proc.pids.join(', ')}）。` +
          `请先完全退出 Antigravity，或运行 node inject.js --launch --relaunch 自动重启。`
      );
    }
    log('[*] 正在温和关闭当前 Antigravity 并以 --remote-debugging-port=0 重新启动...');
    const res = await relaunchAntigravityWithCdp({ port: 0 });
    if (!res.relaunched) {
      throw new Error(`自动重启失败 (${res.reason})，请手动完全退出 Antigravity 后重试`);
    }
    log('[✓] 已重新启动 Antigravity（CDP 远程调试端口已开启）');
    return;
  }
  const ok = launchAntigravityWithCdp({ port: 0 });
  if (!ok) {
    throw new Error('未找到 Antigravity 可执行程序，请手动以 --remote-debugging-port=0 启动');
  }
  log('[✓] 已以 --remote-debugging-port=0 启动 Antigravity');
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

function acquireLock() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    if (pid && pid !== process.pid && isAlive(pid)) {
      if (REPLACE_EXISTING) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && isAlive(pid)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
        if (isAlive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
      } else {
        console.error(`[!] 守护进程已在运行 (PID ${pid})。如需重启请先运行 remove.sh / remove.bat 或附加 --replace`);
        process.exit(1);
      }
    }
  } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid));
  process.on('exit', releasePidFile);
}

async function watch() {
  acquireLock();
  try {
    fs.writeFileSync(LOG_FILE, '');
  } catch {}
  log(`[*] AGY Claude Style (agy-claude-style) 守护模式启动 (PID ${process.pid})，每 2 秒检查一次窗口`);

  const attached = new Map();
  let currentConfig = readConfig();
  let expr = buildInjectExpression(currentConfig);
  let shuttingDown = false;
  let tickTimer = null;
  let reloadTimer = null;
  let watcher = null;

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

  function shutdown(code = 0, reason = '') {
    if (shuttingDown) return;
    shuttingDown = true;
    if (reason) log(`[*] 守护进程退出: ${reason}`);
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
    if (watcher) {
      try {
        watcher.close();
      } catch {}
      watcher = null;
    }
    closeAllSessions();
    releasePidFile();
    process.exit(code);
  }

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

  async function apply(entry) {
    if (entry.scriptId) {
      await entry.session
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId })
        .catch(() => {});
    }
    const { identifier } = await entry.session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: expr,
    });
    entry.scriptId = identifier;
    return await entry.session.evaluate(expr);
  }

  async function attach(page) {
    attached.set(page.id, null);
    try {
      const session = await CdpSession.connect(page.webSocketDebuggerUrl);
      const entry = { session, scriptId: null };
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
          if (updateConfigSetting(key, value)) {
            currentConfig = readConfig();
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
  let relaunchedPidSig = '';
  let lastRelaunchAt = 0;

  async function tick() {
    if (busy || shuttingDown) return;
    if (PARENT_PID && !isAlive(PARENT_PID)) {
      shutdown(0, `父进程 ${PARENT_PID} 已退出`);
      return;
    }
    busy = true;
    let nextDelayMs = 2000;
    try {
      const port = readPort();
      let pages = null;
      if (port) {
        try {
          pages = await listPages(port);
        } catch {
          pages = null;
        }
      }

      if (port && pages !== null) {
        consecutivePortFailures = 0;
        noCdpRunningTicks = 0;
        warnedNoCdpSig = '';
        if (port !== lastPort) {
          closeAllSessions();
          log(`[+] 连接到调试端口 ${port}`);
          lastPort = port;
        }
        await Promise.all(pages.filter((p) => !attached.has(p.id)).map(attach));
      } else {
        consecutivePortFailures++;
        if (consecutivePortFailures >= 3 && (attached.size > 0 || lastPort !== null)) {
          closeAllSessions();
          lastPort = null;
        }

        const proc = process.env.AG_CDP_PORT ? { running: false, pids: [] } : detectAntigravityProcess();
        const shouldExitOnClose = EXIT_ON_HOST_CLOSE_FLAG || currentConfig.exitOnHostClose === true;
        if (shouldExitOnClose && hadAttachedWindow && attached.size === 0 && consecutivePortFailures >= 3 && !proc.running) {
          shutdown(0, 'Antigravity 宿主已关闭');
          return;
        }

        if (proc.running) {
          noCdpRunningTicks++;
          const pidSig = proc.pids.slice().sort((a, b) => a - b).join(',');
          if (noCdpRunningTicks >= 2 && warnedNoCdpSig !== pidSig) {
            warnedNoCdpSig = pidSig;
            log(`[!] ${formatCdpUnavailableMessage({ running: true, port })}`);
            if (!currentConfig.autoRelaunchWithCdp) {
              log('[*] 提示：可在 config.json 中设置 "autoRelaunchWithCdp": true 以启用自动温和重启接管');
            }
          }
          if (
            currentConfig.autoRelaunchWithCdp === true &&
            noCdpRunningTicks >= 2 &&
            relaunchedPidSig !== pidSig &&
            Date.now() - lastRelaunchAt >= 60000
          ) {
            relaunchedPidSig = pidSig;
            lastRelaunchAt = Date.now();
            log('[↻] autoRelaunchWithCdp 已启用：正在温和重启 Antigravity 并附加 --remote-debugging-port=0 ...');
            const res = await relaunchAntigravityWithCdp({ port: 0 });
            if (res.relaunched) {
              log('[✓] 已以 CDP 模式重启 Antigravity，等待窗口就绪...');
              noCdpRunningTicks = 0;
            } else {
              log(`[!] 自动重启未完成 (${res.reason})，请手动完全退出 Antigravity 后以 --remote-debugging-port=0 启动`);
            }
          }
        } else {
          noCdpRunningTicks = 0;
          warnedNoCdpSig = '';
          if (consecutivePortFailures >= 3) {
            nextDelayMs = 5000;
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

  watcher = fs.watch(__dirname, (_, filename) => {
    if (!filename || !/\.(css|js|json)$/i.test(filename) || filename.startsWith('.')) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      try {
        delete require.cache[require.resolve('./cdp')];
        const freshCdp = require('./cdp');
        currentConfig = freshCdp.readConfig();
        expr = freshCdp.buildInjectExpression(currentConfig);
      } catch (err) {
        log(`[!] 读取文件失败: ${err.message}`);
        return;
      }
      let n = 0;
      for (const entry of attached.values()) {
        if (!entry) continue;
        try {
          await apply(entry);
          n++;
        } catch {}
      }
      log(`[↻] ${filename} 已变更，已热更新 ${n} 个窗口`);
    }, 180);
  });

  if (WATCH) {
    process.on('uncaughtException', (err) => {
      log(`[!] 未捕获异常: ${err && err.stack ? err.stack : err}`);
    });
    process.on('unhandledRejection', (err) => {
      log(`[!] 未处理 Promise 拒绝: ${err && err.stack ? err.stack : err}`);
    });
  }

  await tick();
}

const mainPromise = LAUNCH ? launchWithCdp() : WATCH ? watch() : injectOnce();
mainPromise.catch((err) => {
  console.error(`[✗] ${err.message}`);
  process.exit(1);
});
