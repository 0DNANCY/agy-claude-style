// Chrome DevTools Protocol (CDP) helpers for AGY Claude Style (agy-claude-style).
// Node >= 22: uses built-in fetch and WebSocket (zero external dependencies).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const STYLE_ID = 'ag-claude-style-css';
const PLUGIN_VERSION = '1.3.0';
const SETTING_BINDING = '__agClaudeStyleSetting';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const APP_DATA = IS_MAC
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : IS_WIN
  ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');

const PORT_FILE = path.join(APP_DATA, 'Antigravity', 'DevToolsActivePort');
const PID_FILE = path.join(__dirname, '.watch.pid');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  language: 'zh-CN',
  palette: 'obsidian',
  homeLayout: 'studio',
  homeRipple: true,
  composerRestyle: true,
  mascot: 'crab',
  logoInk: 'accent',
  inlineStats: true,
  ringMode: 'context',
  turnBadges: true,
  hudTopBar: false,
  hudBottomBar: false,
  hudRimProgress: false,
  hudFooterChip: false,
  hudCompact: false,
  effortSliderStyle: 'claude',
  effortAccent: true,
  performanceBackdrop: 'card',
  smoothCaret: true,
  sidebarRestyle: true,
  sidebarCompact: false,
  placeholderStyle: 'studio',
  autoRelaunchWithCdp: true,
  exitOnHostClose: false,
  pollIntervalMs: 2500,
};

function readConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function readPort() {
  if (process.env.AG_CDP_PORT) return parseInt(process.env.AG_CDP_PORT, 10);
  try {
    const text = fs.readFileSync(PORT_FILE, 'utf8');
    const port = parseInt(text.split(/\r?\n/)[0].trim(), 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  const targets = await res.json();
  return targets.filter(
    (t) =>
      t.type === 'page' &&
      t.webSocketDebuggerUrl &&
      !t.url.startsWith('devtools://') &&
      !t.url.startsWith('data:')
  );
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.onClose = null;
    this.listeners = new Map();
    ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
        return;
      }
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
    const handleClosed = () => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
      if (this.onClose) this.onClose();
    };
    ws.addEventListener('close', handleClosed);
    ws.addEventListener('error', handleClosed);
  }

  static connect(wsUrl, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP connect timeout'));
      }, timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new CdpSession(ws));
        },
        { once: true }
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP connect failed'));
        },
        { once: true }
      );
    });
  }

  send(method, params = {}, timeoutMs = 5000) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, callback) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(callback);
  }

  async evaluate(expression, awaitPromise = false) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  }

  close() {
    if (!this.closed) this.ws.close();
  }
}

function readCss() {
  return fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
}

const RUNTIME_PARTS = ['i18n-locales.js', 'i18n-core.js', 'usage-core.js', 'ripple-core.js', 'mascot-core.js', 'crab-assets.js', 'effort-core.js', 'perf-assets.js', 'ui-runtime.js'];

function readRuntimeBundle() {
  return RUNTIME_PARTS.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
}

function computeHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function buildInjectExpression(customConfig) {
  const config = customConfig || readConfig();
  const css = readCss();
  const bundle = readRuntimeBundle();
  const codeHash = computeHash(bundle);
  return `(() => {
    const css = ${JSON.stringify(css)};
    const applyStyle = () => {
      const targetParent = document.head || document.documentElement;
      if (!targetParent) return;
      let style = document.getElementById(${JSON.stringify(STYLE_ID)});
      if (!style) {
        style = document.createElement('style');
        style.id = ${JSON.stringify(STYLE_ID)};
      }
      if (style.textContent !== css) style.textContent = css;
      if (style.parentNode !== targetParent || targetParent.lastElementChild !== style) {
        targetParent.appendChild(style);
      }
    };

    let status = 'ok';
    let mounted = false;
    const mount = () => {
      if (mounted || !document.documentElement) return;
      mounted = true;
      try {
        if (document.head) applyStyle();
        else document.addEventListener('DOMContentLoaded', applyStyle, { once: true });
        ${bundle}
        if (typeof globalThis.__agCsUiMain === 'function') {
          globalThis.__agCsUiMain(${JSON.stringify({ ...config, binding: SETTING_BINDING, codeHash })});
        }
      } catch (e) {
        status = 'error: ' + (e && e.message ? e.message : String(e));
        if (typeof console !== 'undefined' && console.error) {
          console.error('[agy-claude-style] init error:', e);
        }
      }
    };

    if (document.documentElement) {
      mount();
    } else {
      status = 'deferred';
      const onReady = () => {
        if (document.documentElement) {
          document.removeEventListener('readystatechange', onReady);
          document.removeEventListener('DOMContentLoaded', onReady);
          mount();
        }
      };
      document.addEventListener('readystatechange', onReady);
      document.addEventListener('DOMContentLoaded', onReady);
    }
    const st = window.__agClaudeStyle && window.__agClaudeStyle.getState ? window.__agClaudeStyle.getState() : null;
    return {
      version: ${JSON.stringify(PLUGIN_VERSION)},
      status,
      state: st,
    };
  })()`;
}

const REMOVE_EXPRESSION = `(() => {
  if (Array.isArray(globalThis.__agCsCleanups)) {
    while (globalThis.__agCsCleanups.length) {
      const fn = globalThis.__agCsCleanups.pop();
      try {
        if (typeof fn === 'function') fn();
      } catch (e) {}
    }
  }
  delete globalThis.__agCsCleanups;
  try {
    if (window.__agClaudeStyle && typeof window.__agClaudeStyle.destroy === 'function') {
      window.__agClaudeStyle.destroy();
    }
  } catch (e) {}
  if (window.__agCsI18n && typeof window.__agCsI18n.destroy === 'function') {
    window.__agCsI18n.destroy();
  }
  delete window.__agClaudeStyle;
  delete window.__agCsI18n;
  delete globalThis.__agCsUiMain;
  delete globalThis.__agCsCrabAssets;
  delete globalThis.__agCsMascotCore;
  delete globalThis.__agCsRippleCore;
  delete globalThis.__agCsUsageCore;
  delete globalThis.__agCsEffortCore;
  delete globalThis.__agCsPerfAssets;
  delete globalThis.__agCsI18nCore;
  delete globalThis.__agCsLocales;
  const root = document.documentElement;
  if (root) {
    root.removeAttribute('data-ag-cs-effort-accent');
    root.removeAttribute('data-ag-cs-perf-backdrop');
    root.removeAttribute('data-ag-cs-lang');
    root.removeAttribute('data-ag-cs-cjk');
    if (root.getAttribute('data-ag-cjk') === '1') root.removeAttribute('data-ag-cjk');
  }
  const nodes = document.querySelectorAll(
    'style#${STYLE_ID}, style#ag-token-hud-style, .ag-cs-home-panel-seat, .ag-cs-ripple-host, .ag-cs-ripple-canvas, .ag-cs-crab, .ag-cs-inline-stats, .ag-cs-context-ring, .ag-cs-ctx-popover, .ag-cs-effort-popover, .ag-cs-perf-backdrop, .ag-cs-smooth-caret, .ag-cs-turn-bar, .ag-cs-hud-top-bar, .ag-cs-hud-bottom-bar, .ag-cs-hud-rim-progress, .ag-cs-hud-footer-chip, #ag-cs-settings-sec, .ag-th-top-bar, .ag-th-bottom-bar, .ag-th-rim-progress, .ag-th-footer-chip, .ag-th-popover, .ag-th-turn-bar, .ag-th-reopen-pill'
  );
  nodes.forEach((n) => n.remove());
  return { removed: nodes.length };
})()`;

function detectAntigravityProcess() {
  try {
    if (IS_MAC) {
      const out = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,comm='], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pids = [];
      for (const rawLine of out.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const m = line.match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const comm = m[2].trim();
        const lower = comm.toLowerCase();
        if (
          lower.endsWith('/antigravity.app/contents/macos/antigravity') ||
          lower === 'antigravity'
        ) {
          pids.push(pid);
        }
      }
      return { running: pids.length > 0, pids };
    }
    if (IS_WIN) {
      const out = execFileSync(
        'tasklist',
        ['/FI', 'IMAGENAME eq Antigravity.exe', '/FO', 'CSV', '/NH'],
        {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      const pids = [];
      for (const rawLine of out.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('"')) continue;
        const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
        if (cols.length >= 2 && cols[0].toLowerCase() === 'antigravity.exe') {
          const pid = parseInt(cols[1], 10);
          if (Number.isInteger(pid) && pid > 0) pids.push(pid);
        }
      }
      return { running: pids.length > 0, pids };
    }
    const out = execFileSync('ps', ['-eo', 'pid=,comm='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = [];
    for (const rawLine of out.split(/\r?\n/)) {
      const line = rawLine.trim();
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      if (path.basename(m[2].trim()).toLowerCase() === 'antigravity') {
        pids.push(parseInt(m[1], 10));
      }
    }
    return { running: pids.length > 0, pids };
  } catch {
    return { running: false, pids: [] };
  }
}

function findAntigravityExecutable() {
  if (IS_MAC) {
    const candidates = [
      '/Applications/Antigravity.app',
      path.join(os.homedir(), 'Applications', 'Antigravity.app'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const candidates = [
      path.join(localAppData, 'Programs', 'antigravity', 'Antigravity.exe'),
      path.join(progFiles, 'Antigravity', 'Antigravity.exe'),
      path.join(progFilesX86, 'Antigravity', 'Antigravity.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }
  for (const c of ['/usr/bin/antigravity', '/usr/local/bin/antigravity', '/opt/Antigravity/antigravity']) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveRunningAntigravityPath(pids = []) {
  const validPids = Array.isArray(pids) ? pids.filter((p) => Number.isInteger(p) && p > 0) : [];
  try {
    if (IS_MAC) {
      const args = validPids.length > 0 ? ['-p', validPids.join(','), '-o', 'comm='] : ['-ax', '-o', 'comm='];
      const out = execFileSync('/bin/ps', args, {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const suffix = '/contents/macos/antigravity';
      for (const rawLine of out.split(/\r?\n/)) {
        const comm = rawLine.trim();
        const lower = comm.toLowerCase();
        if (lower.endsWith(`.app${suffix}`) && comm.length > suffix.length) {
          const appPath = comm.slice(0, comm.length - suffix.length);
          if (fs.existsSync(appPath)) return appPath;
        }
      }
      return null;
    }
    if (IS_WIN) {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" | Select-Object -ExpandProperty ExecutablePath",
        ],
        {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      for (const rawLine of out.split(/\r?\n/)) {
        const exePath = rawLine.trim();
        if (exePath && fs.existsSync(exePath)) return exePath;
      }
      return null;
    }
    for (const pid of validPids) {
      try {
        const target = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
        if (target && fs.existsSync(target)) return target;
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

function hasRemoteDebuggingFlag(pids = []) {
  const validPids = Array.isArray(pids) ? pids.filter((p) => Number.isInteger(p) && p > 0) : [];
  if (validPids.length === 0) return false;
  try {
    if (IS_MAC) {
      const out = execFileSync('/bin/ps', ['-p', validPids.join(','), '-o', 'args='], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /--remote-debugging-port(?:=|\s|$)/i.test(out);
    }
    if (IS_WIN) {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" | Select-Object -ExpandProperty CommandLine",
        ],
        {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      return /--remote-debugging-port(?:=|\s|$)/i.test(out);
    }
    for (const pid of validPids) {
      try {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        const args = raw.split('\0').filter(Boolean);
        if (args.some((arg) => /^--remote-debugging-port(?:=|$)/i.test(arg))) {
          return true;
        }
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

function removeStalePortFile() {
  try {
    if (fs.existsSync(PORT_FILE)) fs.unlinkSync(PORT_FILE);
  } catch {}
}

function launchAntigravityWithCdp(opts = {}) {
  const cdpPort = Number.isInteger(opts.port) && opts.port >= 0 ? opts.port : 0;
  const flag = `--remote-debugging-port=${cdpPort}`;
  if (IS_MAC) {
    const appTarget = opts.appPath || findAntigravityExecutable() || 'Antigravity';
    const child = spawn('/usr/bin/open', ['-a', appTarget, '--args', flag], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  }
  const exePath = opts.appPath || findAntigravityExecutable();
  if (!exePath) return false;
  const child = spawn(exePath, [flag], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return true;
}

async function relaunchAntigravityWithCdp(opts = {}) {
  const waitMs = Number.isInteger(opts.waitMs) && opts.waitMs > 0 ? opts.waitMs : 8000;
  const detectFn = typeof opts.detectProcess === 'function' ? opts.detectProcess : detectAntigravityProcess;
  const resolveRunningFn =
    typeof opts.resolveRunningPath === 'function' ? opts.resolveRunningPath : resolveRunningAntigravityPath;
  const findExeFn = typeof opts.findExecutable === 'function' ? opts.findExecutable : findAntigravityExecutable;
  const launchFn = typeof opts.launch === 'function' ? opts.launch : launchAntigravityWithCdp;
  const removePortFileFn =
    typeof opts.removePortFile === 'function' ? opts.removePortFile : removeStalePortFile;
  const killFn =
    typeof opts.terminate === 'function'
      ? opts.terminate
      : (pids) => {
          if (IS_WIN) {
            execFileSync('taskkill', ['/IM', 'Antigravity.exe'], {
              timeout: 4000,
              windowsHide: true,
              stdio: 'ignore',
            });
          } else {
            for (const pid of pids) {
              if (pid > 0 && pid !== process.pid) {
                try {
                  process.kill(pid, 'SIGTERM');
                } catch {}
              }
            }
          }
        };

  const initialProc = detectFn();
  const initialPids = Array.isArray(initialProc?.pids) ? initialProc.pids : [];
  const resolvedPath = opts.appPath || resolveRunningFn(initialPids) || findExeFn();
  const hasValidTarget = Boolean(
    resolvedPath && (typeof opts.launch === 'function' || fs.existsSync(resolvedPath))
  );
  if (!hasValidTarget) {
    return { relaunched: false, reason: 'executable-not-found' };
  }

  try {
    killFn(initialPids);
  } catch {}

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!detectFn().running) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (detectFn().running) {
    return { relaunched: false, reason: 'still-running' };
  }
  removePortFileFn();
  await new Promise((r) => setTimeout(r, 350));
  const launched = launchFn({ ...opts, appPath: resolvedPath });
  return { relaunched: launched, reason: launched ? 'ok' : 'executable-not-found' };
}

function formatCdpUnavailableMessage({ running, port }) {
  const launchHint = IS_MAC
    ? 'open -a Antigravity --args --remote-debugging-port=0（或运行 ./launch.sh）'
    : IS_WIN
    ? 'Antigravity.exe --remote-debugging-port=0（或双击 launch.bat）'
    : 'antigravity --remote-debugging-port=0（或运行 ./launch.sh）';
  if (running) {
    return (
      `检测到 Antigravity 正在运行，但未开启远程调试端口（Antigravity 2.33.0+ 默认关闭 CDP` +
      `${port ? `，端口 ${port} 无响应` : `，未生成 ${PORT_FILE}`}）。` +
      `请完全退出 Antigravity 后带参启动：${launchHint}`
    );
  }
  if (port) {
    return `端口 ${port} 无响应：Antigravity 可能未运行。请通过带参方式启动：${launchHint}`;
  }
  return `未找到调试端口文件，Antigravity 未运行: ${PORT_FILE}。如使用 Antigravity 2.33.0+，请使用 ${launchHint}`;
}

module.exports = {
  STYLE_ID,
  PLUGIN_VERSION,
  SETTING_BINDING,
  RUNTIME_PARTS,
  PORT_FILE,
  PID_FILE,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  readConfig,
  readPort,
  listPages,
  detectAntigravityProcess,
  findAntigravityExecutable,
  resolveRunningAntigravityPath,
  hasRemoteDebuggingFlag,
  removeStalePortFile,
  launchAntigravityWithCdp,
  relaunchAntigravityWithCdp,
  formatCdpUnavailableMessage,
  CdpSession,
  readCss,
  readRuntimeBundle,
  buildInjectExpression,
  REMOVE_EXPRESSION,
};
