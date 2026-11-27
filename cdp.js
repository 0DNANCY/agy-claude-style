// Chrome DevTools Protocol (CDP) helpers for AGY Claude Style (agy-claude-style).
// Node >= 22: uses built-in fetch and WebSocket (zero external dependencies).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const STYLE_ID = 'ag-claude-style-css';
const PLUGIN_VERSION = '3.1.0';
const SETTING_BINDING = '__agClaudeStyleSetting';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const APP_DATA = IS_MAC
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : IS_WIN
  ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');

function resolvePluginDataDir(env = process.env) {
  const explicitState = String(env?.AGY_CLAUDE_STYLE_STATE_DIR || '').trim();
  if (explicitState) return path.resolve(explicitState);
  const pluginData = String(env?.AGY_CLAUDE_STYLE_PLUGIN_DATA || '').trim();
  if (pluginData && !pluginData.includes('${')) {
    return path.resolve(pluginData);
  }
  const sidecarData = String(env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR || '').trim();
  const lsAddr = String(env?.ANTIGRAVITY_LS_ADDRESS || '').trim();
  if (sidecarData && lsAddr !== 'test.invalid') {
    const resolvedSidecar = path.resolve(sidecarData);
    let cur = resolvedSidecar;
    let prevChild = '';
    for (let depth = 0; depth < 8 && cur && path.dirname(cur) !== cur; depth += 1) {
      const base = path.basename(cur);
      const isSidecarData = process.platform === 'win32'
        ? base.toLowerCase() === 'sidecar_data'
        : base === 'sidecar_data';
      if (isSidecarData && prevChild) {
        return path.join(path.dirname(cur), 'plugin_data', prevChild);
      }
      prevChild = base;
      cur = path.dirname(cur);
    }
    return resolvedSidecar;
  }
  return null;
}

const PLUGIN_DATA_DIR = resolvePluginDataDir(process.env);
const STATE_DIR = PLUGIN_DATA_DIR || __dirname;
const PORT_FILE = path.join(APP_DATA, 'Antigravity', 'DevToolsActivePort');
const PID_FILE = path.join(STATE_DIR, '.watch.pid');
const CONFIG_FILE_ENV = String(process.env.AGY_CLAUDE_STYLE_CONFIG || '').trim();
const CONFIG_FILE = CONFIG_FILE_ENV
  ? path.resolve(CONFIG_FILE_ENV)
  : path.join(STATE_DIR, 'config.json');

const DEFAULT_CONFIG = {
  language: 'zh-CN',
  palette: 'obsidian',
  glassEffect: true,
  homeLayout: 'studio',
  homeRipple: true,
  composerRestyle: true,
  mascot: 'crab',
  logoInk: 'accent',
  inlineStats: true,
  ringMode: 'context',
  quotaCycleMode: 'auto',
  turnBadges: true,
  hudTopBar: false,
  hudBottomBar: false,
  hudRimProgress: false,
  hudRimSource: 'auto',
  hudFooterChip: false,
  hudCompact: false,
  effortSliderStyle: 'claude',
  effortAccent: true,
  performanceBackdrop: 'card',
  smoothCaret: true,
  sidebarRestyle: true,
  sidebarCompact: false,
  sidebarFoldEmpty: true,
  compactChatLayout: false,
  stageCollapse: true,
  stagePromptInjection: false,
  windowUnreadTitle: true,
  placeholderStyle: 'studio',
  rewindPanel: true,
  undoConfirmMode: 'picker',
  branchSession: true,
  messageEdit: true,
  fileContextMenu: true,
  taskProgressCard: true,
  headerExtensionsBar: true,
  sidebarExtensionsSection: true,
  pinnedHeaderExtensions: [],
  pinnedSidebarExtensions: [],
  sidebarExtensionsExpanded: false,
  hideOnClose: true,
  sshRemoteStats: false,
  sshHost: '',
  proxyEnabled: false,
  proxyUrl: '',
  proxyBypass: 'localhost,127.0.0.1,::1',
  proxyForceHttp1: true,
  proxyColdStartAlert: true,
  autoRelaunchWithCdp: true,
  pollIntervalMs: 2500,
};

// Shared declarative schema consumed by inject.js and sidecar config endpoints.
const CONFIG_VALIDATORS = {
  language: ['zh-CN', 'zh-TW', 'yue', 'en', 'ja'],
  palette: ['obsidian', 'claude', 'host'],
  glassEffect: 'boolean',
  homeLayout: ['studio', 'classic', 'off'],
  homeRipple: 'boolean',
  composerRestyle: 'boolean',
  mascot: ['crab', 'off'],
  logoInk: ['accent', 'foreground'],
  inlineStats: 'boolean',
  ringMode: ['context', 'quota', 'both'],
  quotaCycleMode: ['auto', 'weekly', '5h'],
  turnBadges: 'boolean',
  hudTopBar: 'boolean',
  hudBottomBar: 'boolean',
  hudRimProgress: 'boolean',
  hudRimSource: ['auto', 'context', 'quota'],
  hudFooterChip: 'boolean',
  hudCompact: 'boolean',
  effortSliderStyle: ['claude', 'chatgpt', 'liangwufeng'],
  effortAccent: 'boolean',
  performanceBackdrop: ['off', 'card', 'page'],
  smoothCaret: 'boolean',
  sidebarRestyle: 'boolean',
  sidebarCompact: 'boolean',
  sidebarFoldEmpty: 'boolean',
  compactChatLayout: 'boolean',
  stageCollapse: 'boolean',
  stagePromptInjection: 'boolean',
  windowUnreadTitle: 'boolean',
  placeholderStyle: ['studio', 'host'],
  rewindPanel: 'boolean',
  undoConfirmMode: ['picker', 'prompt', 'auto_both', 'auto_chat'],
  branchSession: 'boolean',
  messageEdit: 'boolean',
  fileContextMenu: 'boolean',
  taskProgressCard: 'boolean',
  headerExtensionsBar: 'boolean',
  sidebarExtensionsSection: 'boolean',
  pinnedHeaderExtensions: { type: 'string[]', maxItems: 32, minItemLength: 1, maxItemLength: 128 },
  pinnedSidebarExtensions: { type: 'string[]', maxItems: 32, minItemLength: 1, maxItemLength: 128 },
  sidebarExtensionsExpanded: 'boolean',
  hideOnClose: 'boolean',
  sshRemoteStats: 'boolean',
  sshHost: { type: 'string', maxLength: 512, kind: 'sshHost' },
  proxyEnabled: 'boolean',
  proxyUrl: { type: 'string', maxLength: 512, kind: 'proxyUrl' },
  proxyBypass: { type: 'string', maxLength: 512, kind: 'proxyBypass' },
  proxyForceHttp1: 'boolean',
  proxyColdStartAlert: 'boolean',
  autoRelaunchWithCdp: 'boolean',
  pollIntervalMs: { type: 'integer', min: 250, max: 60000 },
};

const SSH_HOST_VALID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function isValidProxyUrlSetting(raw) {
  const s = String(raw || '').trim();
  if (!s) return true;
  if (s.length > 256 || /[\x00-\x1f\x7f\s'"`\\;$|&<>]/.test(s)) return false;
  try {
    const parsed = new URL(s);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.hostname) return false;
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) return false;
    return true;
  } catch {
    return false;
  }
}

function redactProxyUrlString(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const parsed = new URL(s);
    if (!parsed.username && !parsed.password) return s;
    const host = parsed.hostname.includes(':') && !parsed.hostname.startsWith('[') ? `[${parsed.hostname}]` : parsed.hostname;
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//***@${host}${port}`;
  } catch {
    return s.replace(/:\/\/[^/@\s]+@/g, '://***@');
  }
}

function sanitizeConfigForPage(config) {
  if (!config || typeof config !== 'object') return config;
  const out = { ...config };
  if (typeof out.proxyUrl === 'string' && out.proxyUrl) {
    out.proxyUrl = redactProxyUrlString(out.proxyUrl);
  }
  return out;
}

function validateConfigSetting(key, value) {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_VALIDATORS, key)) return false;
  const rule = CONFIG_VALIDATORS[key];
  if (rule === 'boolean') return typeof value === 'boolean';
  if (Array.isArray(rule)) return typeof value === 'string' && rule.includes(value);
  if (rule && typeof rule === 'object') {
    if (rule.type === 'integer') {
      return Number.isInteger(value) && value >= rule.min && value <= rule.max;
    }
    if (rule.type === 'string') {
      if (typeof value !== 'string' || value.length > rule.maxLength || /[\x00-\x1f\x7f]/.test(value)) {
        return false;
      }
      const trimmed = value.trim();
      if (rule.kind === 'sshHost') {
        if (!trimmed) return true;
        return !trimmed.startsWith('-') && SSH_HOST_VALID_RE.test(trimmed);
      }
      if (rule.kind === 'proxyUrl') {
        return isValidProxyUrlSetting(trimmed);
      }
      if (rule.kind === 'proxyBypass') {
        return !/[\x00-\x1f\x7f'"`\\$|&<>%^!]/.test(value);
      }
      return true;
    }
    if (rule.type === 'string[]') {
      return (
        Array.isArray(value) &&
        value.length <= rule.maxItems &&
        value.every(
          (it) =>
            typeof it === 'string' &&
            it.length >= rule.minItemLength &&
            it.length <= rule.maxItemLength &&
            !/[\x00-\x1f\x7f]/.test(it)
        )
      );
    }
  }
  return false;
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    let lastRenameErr = null;
    const maxAttempts = IS_WIN ? 3 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        fs.renameSync(tmpPath, filePath);
        lastRenameErr = null;
        break;
      } catch (err) {
        lastRenameErr = err;
        const code = String(err?.code || '').toUpperCase();
        if (!IS_WIN || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
          throw err;
        }
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
        } catch {}
      }
    }
    if (lastRenameErr) {
      throw lastRenameErr;
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

function readConfig(configPath = CONFIG_FILE) {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function updateConfigSetting(key, value, configPath = CONFIG_FILE) {
  if (!validateConfigSetting(key, value)) return false;
  const next = { ...readConfig(configPath), [key]: value };
  writeFileAtomic(configPath, JSON.stringify(next, null, 2) + '\n');
  return true;
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

const SWARM_SIDECAR_URL_PREFIX = 'plugin://swarm--';

function isInjectableTarget(t) {
  if (!t || !t.webSocketDebuggerUrl) return false;
  const url = typeof t.url === 'string' ? t.url : '';
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.startsWith('devtools://') || lowerUrl.startsWith('data:')) return false;
  if (t.type === 'page') return true;
  if (t.type === 'iframe' && lowerUrl.startsWith(SWARM_SIDECAR_URL_PREFIX)) return true;
  return false;
}

async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  const targets = await res.json();
  return targets.filter(isInjectableTarget);
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

const RUNTIME_PARTS = ['i18n-locales.js', 'i18n-core.js', 'sidecar-core.js', 'usage-core.js', 'ripple-core.js', 'mascot-core.js', 'crab-assets.js', 'effort-core.js', 'perf-assets.js', 'ui-rewind.js', 'features/branch-edit.js', 'features/file-menu.js', 'features/task-progress.js', 'features/extensions-dock.js', 'features/hide-on-close.js', 'features/unread-title.js', 'features/stage-collapse.js', 'features/sidebar-polish.js', 'ui-runtime.js'];

function readRuntimeBundle() {
  return RUNTIME_PARTS.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
}

const LOGO_MIME_BY_EXT = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function readInstalledSidecarLogos(opts = {}) {
  const logos = {};
  const home = opts.homeDir || os.homedir();
  const roots = Array.isArray(opts.roots)
    ? opts.roots
    : [
        path.join(home, '.gemini', 'config', 'plugins'),
        path.join(home, '.gemini', 'antigravity', 'builtin', 'plugins'),
      ];
  const maxBytes = Number.isInteger(opts.maxBytes) ? opts.maxBytes : 65536;

  for (const rootDir of roots) {
    let entries;
    try {
      if (!fs.existsSync(rootDir)) continue;
      entries = fs.readdirSync(rootDir);
    } catch {
      continue;
    }
    for (const dirName of entries) {
      const pDir = path.join(rootDir, dirName);
      const pjPath = path.join(pDir, 'plugin.json');
      try {
        if (!fs.existsSync(pjPath)) continue;
        const meta = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
        const logoRel = typeof meta?.logo === 'string' ? meta.logo.trim() : '';
        if (!logoRel || /^https?:\/\//i.test(logoRel) || path.isAbsolute(logoRel)) continue;
        const ext = path.extname(logoRel).toLowerCase();
        const mime = LOGO_MIME_BY_EXT[ext];
        if (!mime) continue;
        const resolvedPluginDir = fs.realpathSync(pDir);
        const logoAbs = path.resolve(resolvedPluginDir, logoRel);
        if (!logoAbs.startsWith(resolvedPluginDir + path.sep)) continue;
        if (!fs.existsSync(logoAbs)) continue;
        const stat = fs.statSync(logoAbs);
        if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) continue;
        const dataUri = `data:${mime};base64,${fs.readFileSync(logoAbs).toString('base64')}`;

        const scDir = path.join(resolvedPluginDir, 'sidecars');
        const scNames = [];
        if (fs.existsSync(scDir)) {
          for (const sc of fs.readdirSync(scDir)) {
            if (fs.existsSync(path.join(scDir, sc, 'sidecar.json'))) scNames.push(sc);
          }
        }
        const pluginKeys = new Set([dirName, typeof meta?.name === 'string' ? meta.name.trim() : ''].filter(Boolean));
        for (const pk of pluginKeys) {
          for (const sc of scNames) {
            const key = `${pk}/${sc}`;
            if (!logos[key]) logos[key] = dataUri;
          }
        }
      } catch {}
    }
  }
  return logos;
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
  const sidecarLogos = readInstalledSidecarLogos();
  return `(() => {
    const css = ${JSON.stringify(css)};
    const applyStyle = () => {
      const targetParent = document.head || document.documentElement;
      if (!targetParent) return;
      const conflictingStudio = document.getElementById('ag-claude-studio-css');
      if (conflictingStudio) conflictingStudio.remove();
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
    globalThis.__agCsEnsureStyle = applyStyle;

    let status = 'ok';
    let mounted = false;
    const mount = () => {
      if (mounted || !document.documentElement) return;
      mounted = true;
      try {
        const isSidecar = typeof location !== 'undefined' && location.protocol === 'plugin:';
        if (!isSidecar) {
          if (document.head) applyStyle();
          else document.addEventListener('DOMContentLoaded', applyStyle, { once: true });
        }
        globalThis.__agCsSidecarLogos = ${JSON.stringify(sidecarLogos)};
        ${bundle}
        if (typeof globalThis.__agCsUiMain === 'function') {
          const baseCfg = ${JSON.stringify({ ...sanitizeConfigForPage(config), binding: SETTING_BINDING, codeHash })};
          const ov = globalThis.__agCsOverrideConfig;
          const nextCfg =
            ov && typeof ov === 'object' && ov.codeHash === baseCfg.codeHash
              ? { ...baseCfg, ...ov, binding: baseCfg.binding, codeHash: baseCfg.codeHash }
              : baseCfg;
          globalThis.__agCsUiMain(nextCfg);
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

function buildConfigScriptExpression(customConfig, expectedCodeHash) {
  const config = customConfig || readConfig();
  const expectedHash = expectedCodeHash || '';
  const payload = { ...sanitizeConfigForPage(config), binding: SETTING_BINDING, codeHash: expectedHash };
  return `(() => {
    const nextCfg = ${JSON.stringify(payload)};
    globalThis.__agCsOverrideConfig = nextCfg;
    if (
      window.__agClaudeStyle &&
      typeof window.__agClaudeStyle.refreshConfig === 'function' &&
      (!${JSON.stringify(expectedHash)} || window.__agClaudeStyle.codeHash === ${JSON.stringify(expectedHash)})
    ) {
      window.__agClaudeStyle.refreshConfig(nextCfg);
      return {
        version: ${JSON.stringify(PLUGIN_VERSION)},
        status: 'refreshed',
        state: window.__agClaudeStyle.getState ? window.__agClaudeStyle.getState() : null,
      };
    }
    return null;
  })()`;
}

function buildRefreshExpression(customConfig, expectedCodeHash) {
  return buildConfigScriptExpression(customConfig, expectedCodeHash);
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
  delete globalThis.__agCsOverrideConfig;
  delete globalThis.__agCsEnsureStyle;
  delete globalThis.__agCsSidecarLogos;
  delete window.__agCsFileActionReply;
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
  delete globalThis.__agCsSidecarCore;
  delete globalThis.__agCsLocales;
  delete globalThis.__agCsFeatures;
  const root = document.documentElement;
  if (root) {
    root.removeAttribute('data-ag-cs-glass');
    root.removeAttribute('data-ag-cs-effort-accent');
    root.removeAttribute('data-ag-cs-perf-backdrop');
    root.removeAttribute('data-ag-cs-lang');
    root.removeAttribute('data-ag-cs-cjk');
    root.removeAttribute('data-ag-cs-crab');
    root.removeAttribute('data-ag-cs-theme');
    root.removeAttribute('data-ag-cs-compact-chat');
    root.removeAttribute('data-ag-cs-sidebar');
    root.removeAttribute('data-ag-cs-sidebar-compact');
    root.removeAttribute('data-ag-cs-sidebar-fold-empty');
    if (root.getAttribute('data-ag-cjk') === '1') root.removeAttribute('data-ag-cjk');
  }
  document
    .querySelectorAll('[data-ag-cs-sb-group], [data-ag-cs-sb-header], [data-ag-cs-sb-children], [data-ag-cs-sb-empty], [data-ag-cs-sb-empty-row], [data-ag-cs-sb-empty-body], [data-ag-cs-sb-has-convos], [data-ag-cs-sb-has-active], [data-ag-cs-sb-active], [data-ag-cs-sb-peek], [data-ag-cs-sb-nav-active]')
    .forEach((el) => {
      for (const a of ['data-ag-cs-sb-group', 'data-ag-cs-sb-header', 'data-ag-cs-sb-children', 'data-ag-cs-sb-empty', 'data-ag-cs-sb-empty-row', 'data-ag-cs-sb-empty-body', 'data-ag-cs-sb-has-convos', 'data-ag-cs-sb-has-active', 'data-ag-cs-sb-active', 'data-ag-cs-sb-peek', 'data-ag-cs-sb-nav-active']) {
        el.removeAttribute(a);
      }
    });
  const nodes = document.querySelectorAll(
    'style#${STYLE_ID}, style#ag-token-hud-style, .ag-cs-home-panel-seat, .ag-cs-ripple-host, .ag-cs-ripple-canvas, .ag-cs-crab, .ag-cs-inline-stats, .ag-cs-quota-ring, .ag-cs-context-ring, .ag-cs-ctx-popover, .ag-cs-effort-popover, .ag-cs-perf-backdrop, .ag-cs-smooth-caret, .ag-cs-turn-bar, .ag-cs-hud-top-bar, .ag-cs-hud-bottom-bar, .ag-cs-hud-rim-progress, .ag-cs-hud-footer-chip, .ag-cs-rewind-bar, .ag-cs-rewind-notice, .ag-cs-rewind-backdrop, .ag-cs-branch-btn, .ag-cs-edit-btn, .ag-cs-inline-edit, .ag-cs-file-menu, .ag-cs-file-submenu, .ag-cs-progress-card, .ag-cs-action-toast, .ag-cs-ext-header-bar, .ag-cs-ext-menu-btn, .ag-cs-ext-sidebar-sec, .ag-cs-ext-popover, .ag-cs-native-pin-btn, .ag-cs-ext-tooltip, .ag-cs-stage-bar, .ag-cs-stage-badge, .ag-cs-stage-meta-inline, #ag-cs-settings-sec, .ag-th-top-bar, .ag-th-bottom-bar, .ag-th-rim-progress, .ag-th-footer-chip, .ag-th-popover, .ag-th-turn-bar, .ag-th-reopen-pill'
  );
  nodes.forEach((n) => n.remove());
  return { removed: nodes.length };
})()`;

function parseWin32AntigravityProcesses(rawInput) {
  let items = [];
  if (Array.isArray(rawInput)) {
    items = rawInput;
  } else if (rawInput && typeof rawInput === 'object') {
    items = [rawInput];
  } else if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      return { allPids: [], mainPids: [], exePath: null, hasCdpFlag: false, processes: [] };
    }
    try {
      const parsed = JSON.parse(trimmed);
      items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
    } catch {
      return { allPids: [], mainPids: [], exePath: null, hasCdpFlag: false, processes: [] };
    }
  }

  const allPids = [];
  const mainPids = [];
  const processes = [];
  let exePath = null;
  let mainHasCdpFlag = false;
  let anyNonSidecarHasCdpFlag = false;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const pid = Number(item.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const cmd = typeof item.CommandLine === 'string' ? item.CommandLine.trim() : '';
    const exe = typeof item.ExecutablePath === 'string' ? item.ExecutablePath.trim() : '';
    const isElectronChild = /(?:^|\s)--type=/i.test(cmd);
    const isRunAsNodeHelper =
      /(?:sidecar_sdk[\\\/]register_loader\.js|--import=[^\s]*sidecar_sdk|(?:^|\s)(?:-e|--eval)(?:\s|$))/i.test(cmd);
    const isMain = !isElectronChild && !isRunAsNodeHelper;
    const hasCdp = /--remote-debugging-port(?:=|\s|$)/i.test(cmd);

    allPids.push(pid);
    if (isMain) {
      mainPids.push(pid);
      if (hasCdp) mainHasCdpFlag = true;
    }
    if (!isRunAsNodeHelper && hasCdp) {
      anyNonSidecarHasCdpFlag = true;
    }
    if (!exePath && exe) {
      exePath = exe;
    }
    processes.push({ pid, cmd, exePath: exe || null, isMain, isElectronChild, isRunAsNodeHelper, hasCdp });
  }

  return {
    allPids,
    mainPids,
    exePath,
    hasCdpFlag: mainHasCdpFlag || anyNonSidecarHasCdpFlag,
    processes,
  };
}

function queryWin32AntigravityProcesses() {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$p = @(Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine); if ($p.Count -gt 0) { $p | ConvertTo-Json -Compress }",
    ],
    {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }
  );
  return parseWin32AntigravityProcesses(out);
}

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
      try {
        const winInfo = queryWin32AntigravityProcesses();
        return { running: winInfo.mainPids.length > 0, pids: winInfo.mainPids };
      } catch {}
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
      path.join(localAppData, 'Programs', 'Google', 'Antigravity', 'Antigravity.exe'),
      path.join(localAppData, 'Antigravity', 'Antigravity.exe'),
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
      const winInfo = queryWin32AntigravityProcesses();
      if (winInfo.exePath && fs.existsSync(winInfo.exePath)) return winInfo.exePath;
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
      const winInfo = queryWin32AntigravityProcesses();
      const pidSet = new Set(validPids);
      const matched = winInfo.processes.filter((p) => !p.isRunAsNodeHelper && pidSet.has(p.pid));
      if (matched.length > 0) {
        return matched.some((p) => p.hasCdp);
      }
      return winInfo.hasCdpFlag;
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

function checkPidAlive(pid, killFn = (p, sig) => process.kill(p, sig)) {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    killFn(pid, 0);
    return 'alive';
  } catch (err) {
    if (err && err.code === 'EPERM') return 'alive';
    return 'dead';
  }
}

function splitCommandArgs(cmdLine) {
  if (typeof cmdLine !== 'string' || !cmdLine.trim()) return [];
  const args = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmdLine.length; i++) {
    const ch = cmdLine[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < cmdLine.length && (cmdLine[i + 1] === '"' || cmdLine[i + 1] === '\\')) {
        cur += cmdLine[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur.length > 0) {
        args.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) args.push(cur);
  return args;
}

function inspectProcessInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (IS_MAC) {
      const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!cmd) return null;
      let exePath = null;
      try {
        exePath = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
          encoding: 'utf8',
          timeout: 1500,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null;
      } catch {}
      return { cmd, args: null, exePath, cwd: null };
    }
    if (IS_WIN) {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p | Select-Object ExecutablePath, CommandLine | ConvertTo-Json -Compress }`,
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      ).trim();
      if (!out) return null;
      const parsed = JSON.parse(out);
      const cmd = typeof parsed.CommandLine === 'string' ? parsed.CommandLine.trim() : '';
      const exePath = typeof parsed.ExecutablePath === 'string' ? parsed.ExecutablePath.trim() : null;
      if (!cmd) return null;
      return {
        cmd,
        args: splitCommandArgs(cmd),
        exePath: exePath || null,
        cwd: null,
      };
    }
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const args = raw.split('\0').filter((s) => s.length > 0);
    const cmd = args.join(' ').trim();
    if (!cmd) return null;
    let cwd = null;
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {}
    let exePath = null;
    try {
      exePath = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {}
    return { cmd, args, exePath, cwd };
  } catch {
    return null;
  }
}

function inspectProcessCommand(pid) {
  const info = inspectProcessInfo(pid);
  return info && typeof info.cmd === 'string' && info.cmd.length > 0 ? info.cmd : null;
}

function normalizePathForCompare(p, targetPlatform = process.platform) {
  if (!p || typeof p !== 'string') return '';
  const pathMod = targetPlatform === 'win32' ? path.win32 : path.posix;
  let cleaned = pathMod.normalize(p.replace(/[\\\/]+$/, '') || p);
  if (targetPlatform === 'darwin') {
    cleaned = cleaned.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, '');
  } else if (targetPlatform === 'win32') {
    cleaned = cleaned.toLowerCase();
  }
  return cleaned;
}

function resolveCandidatePath(candidate, cwd, targetPlatform = process.platform) {
  if (!candidate || typeof candidate !== 'string') return '';
  const pathMod = targetPlatform === 'win32' ? path.win32 : path.posix;
  if (pathMod.isAbsolute(candidate)) {
    return normalizePathForCompare(pathMod.resolve(candidate), targetPlatform);
  }
  if (cwd && pathMod.isAbsolute(cwd)) {
    return normalizePathForCompare(pathMod.resolve(cwd, candidate), targetPlatform);
  }
  return '';
}

function hasPathToken(haystack, targetPath, targetPlatform = process.platform) {
  if (!haystack || !targetPath) return false;
  const h = targetPlatform === 'win32' ? haystack.toLowerCase() : haystack;
  const t = normalizePathForCompare(targetPath, targetPlatform);
  let idx = 0;
  while ((idx = h.indexOf(t, idx)) !== -1) {
    const before = idx === 0 ? ' ' : h[idx - 1];
    const afterIdx = idx + t.length;
    const after = afterIdx >= h.length ? ' ' : h[afterIdx];
    const beforeOk = idx === 0 || /[\s"']/.test(before);
    const afterOk = afterIdx === h.length || /[\s"']/.test(after);
    if (beforeOk && afterOk) return true;
    idx += t.length;
  }
  return false;
}

const NODE_DISALLOWED_ENTRY_FLAGS = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-r',
  '--require',
  '-i',
  '--interactive',
  '-c',
  '--check',
  '-h',
  '--help',
  '-v',
  '--version',
]);

function isNodeBinaryName(binPathOrToken, targetPlatform = process.platform) {
  if (!binPathOrToken || typeof binPathOrToken !== 'string') return false;
  const pathMod = targetPlatform === 'win32' ? path.win32 : path.posix;
  const base = pathMod.basename(binPathOrToken).toLowerCase();
  return /^(?:node(?:\.exe)?|nodejs|electron(?:\.exe)?|electron helper.*|antigravity(?:\.exe)?|antigravity helper.*)$/.test(base);
}

function evaluateWatcherOwnership(rawInfo, targetDir = __dirname, targetPlatform = process.platform) {
  if (!rawInfo || !targetDir) return 'unknown';
  const info =
    typeof rawInfo === 'string'
      ? { cmd: rawInfo, args: null, exePath: null, cwd: null }
      : rawInfo;
  const cmd = typeof info.cmd === 'string' ? info.cmd.trim() : '';
  if (!cmd) return 'unknown';

  const args = Array.isArray(info.args) ? info.args : null;
  const pathMod = targetPlatform === 'win32' ? path.win32 : path.posix;
  const normTargetDir = normalizePathForCompare(pathMod.resolve(targetDir), targetPlatform);
  if (!normTargetDir) return 'unknown';

  const hasFlag = (flag) =>
    args
      ? args.includes(flag)
      : new RegExp(`(?:^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`).test(cmd);

  if (hasFlag('--once') || hasFlag('--remove')) {
    return 'foreign';
  }

  // Native plugin host check: recognizes both `plugin/mcp-host.js` and `sidecars/panel/main.mjs`.
  const expectedMcpScript = normalizePathForCompare(pathMod.join(normTargetDir, 'plugin', 'mcp-host.js'), targetPlatform);
  const expectedSidecarScript = normalizePathForCompare(
    pathMod.join(normTargetDir, 'sidecars', 'panel', 'main.mjs'),
    targetPlatform
  );
  const matchesTargetRealpath = (candidatePath, expectedPath) => {
    if (!candidatePath) return false;
    if (candidatePath === expectedPath) return true;
    if (targetPlatform === process.platform) {
      try {
        if (fs.existsSync(candidatePath) && fs.existsSync(expectedPath)) {
          return normalizePathForCompare(fs.realpathSync(candidatePath), targetPlatform) ===
            normalizePathForCompare(fs.realpathSync(expectedPath), targetPlatform);
        }
      } catch {}
    }
    return false;
  };
  const classifyEntryScript = (entryScript) => {
    if (!entryScript) return 'foreign';
    const baseEntry = pathMod.basename(entryScript).toLowerCase();
    if (baseEntry === 'mcp-host.js') {
      const resolved = resolveCandidatePath(entryScript, info.cwd, targetPlatform);
      if (resolved) {
        return matchesTargetRealpath(resolved, expectedMcpScript) ? 'owned' : 'foreign';
      }
      return 'unknown';
    }
    if (baseEntry === 'main.mjs') {
      const resolved = resolveCandidatePath(entryScript, info.cwd, targetPlatform);
      if (resolved) {
        return matchesTargetRealpath(resolved, expectedSidecarScript) ? 'owned' : 'foreign';
      }
      return 'unknown';
    }
    return 'foreign';
  };
  const scanLeadingFlag = (tok, hasNextToken) => {
    const lower = tok.toLowerCase();
    if (
      NODE_DISALLOWED_ENTRY_FLAGS.has(lower) ||
      lower.startsWith('--eval=') ||
      lower.startsWith('--require=') ||
      lower.startsWith('--print=')
    ) {
      return 'foreign';
    }
    if (/^--(?:import|max-old-space-size|loader|experimental-loader)$/i.test(lower)) {
      return hasNextToken ? 'skip2' : 'unknown';
    }
    if (lower.startsWith('--')) {
      return 'skip1';
    }
    return 'unknown';
  };

  if (args && args.length >= 2) {
    if (!isNodeBinaryName(info.exePath || args[0], targetPlatform)) return 'foreign';
    let i = 1;
    while (i < args.length) {
      const tok = args[i];
      if (!tok) {
        i++;
        continue;
      }
      if (tok === '--') {
        i++;
        break;
      }
      if (tok.startsWith('-')) {
        const action = scanLeadingFlag(tok, i + 1 < args.length);
        if (action === 'skip1') {
          i++;
          continue;
        }
        if (action === 'skip2') {
          i += 2;
          continue;
        }
        return action;
      }
      return classifyEntryScript(tok);
    }
    if (i < args.length) {
      return classifyEntryScript(args[i]);
    }
    return 'foreign';
  }

  // Space-joined cmd string (e.g. macOS ps): use info.exePath (from -o comm=) when available, else first token.
  let launcherTok = '';
  let rest = '';
  const exePrefix = cmd.split(/\s+--/)[0].trim().replace(/^["']|["']$/g, '');
  const leadingToken = exePrefix.split(/\s+/)[0] || '';
  if (info.exePath) {
    launcherTok = info.exePath;
    if (cmd.startsWith(info.exePath) && (cmd.length === info.exePath.length || /\s/.test(cmd[info.exePath.length]))) {
      rest = cmd.slice(info.exePath.length).trim();
    } else {
      const baseExe = pathMod.basename(info.exePath);
      if (cmd.startsWith(baseExe) && (cmd.length === baseExe.length || /\s/.test(cmd[baseExe.length]))) {
        rest = cmd.slice(baseExe.length).trim();
      } else {
        rest = cmd.slice(leadingToken.length).trim();
      }
    }
  } else {
    const tokens = splitCommandArgs(cmd);
    launcherTok = tokens[0] || leadingToken;
    const trimmed = cmd.trimStart();
    if (tokens[0] && (trimmed.startsWith(`"${tokens[0]}"`) || trimmed.startsWith(`'${tokens[0]}'`))) {
      rest = trimmed.slice(tokens[0].length + 2).trim();
    } else {
      rest = trimmed.slice(launcherTok.length).trim();
    }
  }

  if (!isNodeBinaryName(launcherTok, targetPlatform)) return 'foreign';
  if (!rest) return 'foreign';

  const restTokens = splitCommandArgs(rest);
  let tokIdx = 0;
  while (tokIdx < restTokens.length) {
    const tok = restTokens[tokIdx];
    if (!tok) {
      tokIdx++;
      continue;
    }
    if (tok === '--') {
      tokIdx++;
      break;
    }
    if (tok.startsWith('-')) {
      const action = scanLeadingFlag(tok, tokIdx + 1 < restTokens.length);
      if (action === 'skip1') {
        tokIdx++;
        continue;
      }
      if (action === 'skip2') {
        tokIdx += 2;
        continue;
      }
      return action;
    }
    break;
  }
  if (tokIdx >= restTokens.length) return 'foreign';

  if (tokIdx === 0) {
    const normRest = targetPlatform === 'win32' ? rest.toLowerCase().replace(/\//g, '\\') : rest;
    const rawUnquotedRest = normRest.replace(/^["']/, '');
    const unquotedRest =
      targetPlatform === 'darwin'
        ? rawUnquotedRest.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|\s|"|'|$))/, '')
        : rawUnquotedRest;
    for (const expectedScript of [expectedMcpScript, expectedSidecarScript]) {
      if (unquotedRest.startsWith(expectedScript)) {
        const nextChar = unquotedRest[expectedScript.length];
        if (!nextChar || /[\s"']/.test(nextChar)) {
          return 'owned';
        }
      }
    }
  }

  return classifyEntryScript(restTokens[tokIdx]);
}

function matchesWatcherForDir(rawInfo, targetDir = __dirname, targetPlatform = process.platform) {
  return evaluateWatcherOwnership(rawInfo, targetDir, targetPlatform) === 'owned';
}

function classifyWatcherPid(pid, targetDir = __dirname, opts = {}) {
  const killFn = typeof opts.killFn === 'function' ? opts.killFn : (p, sig) => process.kill(p, sig);
  const inspectFn = typeof opts.inspectFn === 'function' ? opts.inspectFn : inspectProcessInfo;
  const platform = opts.platform || process.platform;

  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: 'dead', pid, reason: 'invalid-pid' };
  }
  if (checkPidAlive(pid, killFn) === 'dead') {
    return { status: 'dead', pid, reason: 'esrch' };
  }

  let rawInfo = null;
  try {
    rawInfo = inspectFn(pid);
  } catch {
    rawInfo = null;
  }
  const info =
    typeof rawInfo === 'string'
      ? { cmd: rawInfo, args: null, exePath: null, cwd: null }
      : rawInfo;

  if (!info || typeof info.cmd !== 'string' || !info.cmd.trim()) {
    if (checkPidAlive(pid, killFn) === 'dead') {
      return { status: 'dead', pid, reason: 'exited-during-inspect' };
    }
    return { status: 'unknown', pid, reason: 'inspect-unavailable' };
  }

  const ownership = evaluateWatcherOwnership(info, targetDir, platform);
  if (ownership === 'owned') {
    return { status: 'owned', pid, info };
  }
  if (ownership === 'unknown') {
    return { status: 'unknown', pid, info, reason: 'relative-path-unverified' };
  }
  return { status: 'foreign', pid, info };
}

function isLikelyWatcherProcess(pid, targetDir = __dirname, opts = {}) {
  return classifyWatcherPid(pid, targetDir, opts).status === 'owned';
}

function resolveExistingWatchPidAction(pidFile = PID_FILE, targetDir = __dirname, opts = {}) {
  const selfPid = Number.isInteger(opts.selfPid) ? opts.selfPid : process.pid;
  let pid;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
  } catch {
    return { action: 'write', status: 'missing', pid: null };
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { action: 'clear', status: 'invalid', pid: null };
  }
  if (pid === selfPid) {
    return { action: 'write', status: 'self', pid };
  }
  const cls = classifyWatcherPid(pid, targetDir, opts);
  if (cls.status === 'dead') {
    return { action: 'clear', status: 'dead', pid };
  }
  if (cls.status === 'foreign') {
    return { action: 'clear', status: 'foreign', pid, info: cls.info };
  }
  if (cls.status === 'owned') {
    return { action: 'owned', status: 'owned', pid, info: cls.info };
  }
  return { action: 'refuse', status: 'unknown', pid, reason: cls.reason };
}

function removeStalePortFile() {
  try {
    if (fs.existsSync(PORT_FILE)) fs.unlinkSync(PORT_FILE);
  } catch {}
}

function runWin32WindowAction(action, opts = {}) {
  const spawnFn = typeof opts.spawn === 'function' ? opts.spawn : spawn;
  const script =
    action === 'minimize'
      ? "$t = Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -Name 'AgyWinMin' -Namespace 'AgyCs' -PassThru; $p = Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($p) { [void]$t::ShowWindow($p.MainWindowHandle, 6) }"
      : "$t = Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);' -Name 'AgyWinAct' -Namespace 'AgyCs' -PassThru; $p = Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($p) { if ($t::IsIconic($p.MainWindowHandle)) { [void]$t::ShowWindow($p.MainWindowHandle, 9) }; [void]$t::SetForegroundWindow($p.MainWindowHandle) }";
  try {
    const child = spawnFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
}

function activateAntigravityWindow(opts = {}) {
  if (IS_MAC) {
    try {
      const spawnFn = typeof opts.spawn === 'function' ? opts.spawn : spawn;
      const appTarget = opts.appPath || findAntigravityExecutable() || 'Antigravity';
      const child = spawnFn('/usr/bin/open', ['-a', appTarget], {
        detached: true,
        stdio: 'ignore',
      });
      if (child && typeof child.unref === 'function') child.unref();
      return true;
    } catch {
      return false;
    }
  }
  if (IS_WIN) {
    return runWin32WindowAction('activate', opts);
  }
  return false;
}

function hideAntigravityWindow(opts = {}) {
  if (IS_MAC) {
    try {
      const spawnFn = typeof opts.spawn === 'function' ? opts.spawn : spawn;
      const child = spawnFn(
        '/usr/bin/osascript',
        ['-e', 'tell application "System Events" to set visible of first application process whose name is "Antigravity" to false'],
        { detached: true, stdio: 'ignore' }
      );
      if (child && typeof child.unref === 'function') child.unref();
      return true;
    } catch {
      return false;
    }
  }
  if (IS_WIN) {
    // On Windows there is no Dock icon to restore SW_HIDE windows without a tray icon;
    // minimize cleanly to the taskbar instead so clicking the taskbar restores without reload.
    return runWin32WindowAction('minimize', opts);
  }
  return false;
}

const PROXY_URL_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const CUSTOM_LAUNCH_CMD_UNSAFE_RE = /[\x00-\x1f\x7f"'`$|&<>^%]/;

function hasProxyUrlEnv(envObj = process.env) {
  if (!envObj || typeof envObj !== 'object') return false;
  return PROXY_URL_ENV_KEYS.some((key) => String(envObj[key] || '').trim().length > 0);
}

function resolveCustomLaunchCommand({
  env = process.env,
  platform = process.platform,
  existsFn = fs.existsSync,
} = {}) {
  if (platform !== 'win32') return null;
  const raw = String(env?.AGY_CLAUDE_STYLE_LAUNCH_CMD || env?.AGY_CLAUDE_STUDIO_LAUNCH_CMD || '').trim();
  if (!raw) return null;
  const unquoted = raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    ? raw.slice(1, -1).trim()
    : raw;
  if (!unquoted || unquoted.length > 512 || CUSTOM_LAUNCH_CMD_UNSAFE_RE.test(unquoted)) return null;
  if (!/\.(?:exe|cmd|bat|ps1)$/i.test(unquoted)) return null;
  try {
    return existsFn(unquoted) ? unquoted : null;
  } catch {
    return null;
  }
}

function buildWinSpawnInvocation(targetPath, launchArgs = [], env = process.env) {
  const args = Array.isArray(launchArgs) ? launchArgs : [];
  const target = String(targetPath || '');
  if (/\.(?:cmd|bat)$/i.test(target)) {
    const comspec = String(env?.ComSpec || env?.COMSPEC || 'cmd.exe').trim() || 'cmd.exe';
    return {
      command: comspec,
      args: ['/d', '/c', target, ...args],
      isScript: true,
    };
  }
  if (/\.ps1$/i.test(target)) {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', target, ...args],
      isScript: true,
    };
  }
  return {
    command: target,
    args: [...args],
    isScript: false,
  };
}

function sanitizeAppLaunchEnv(baseEnv = process.env, extraEnv = {}) {
  const env = { ...(baseEnv || {}) };
  const stripExactUpper = new Set([
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ATTACH_CONSOLE',
    'NODE_OPTIONS',
    'NODE_PATH',
    'AGY_RELAUNCH_SPEC',
    'AGY_RELAUNCH_CODE',
    'AGY_RELAUNCH_STAGE2',
    'AG_CDP_PORT',
    'PLUGIN_DATA',
    'ANTIGRAVITY_SOURCE_METADATA',
    'ANTIGRAVITY_EXECUTABLE_DATA_DIR',
    'ANTIGRAVITY_NODE_PATH',
  ]);
  for (const k of Object.keys(env)) {
    const upper = k.toUpperCase();
    if (
      stripExactUpper.has(upper) ||
      upper.startsWith('ANTIGRAVITY_SIDECAR_') ||
      upper.startsWith('ANTIGRAVITY_LS_') ||
      upper.startsWith('ANTIGRAVITY_HOST_BRIDGE_')
    ) {
      delete env[k];
    }
  }
  if (extraEnv && typeof extraEnv === 'object') {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined || v === null) delete env[k];
      else env[k] = String(v);
    }
  }
  if (hasProxyUrlEnv(env) && !String(env.NODE_USE_ENV_PROXY || env.node_use_env_proxy || '').trim()) {
    env.NODE_USE_ENV_PROXY = '1';
  }
  return env;
}

function resolveMacAppBinary(appTarget) {
  if (!appTarget || typeof appTarget !== 'string') return null;
  if (appTarget.toLowerCase().endsWith('.app')) {
    const candidate = path.join(appTarget, 'Contents', 'MacOS', 'Antigravity');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function launchAntigravityWithCdp(opts = {}) {
  const cdpPort = Number.isInteger(opts.port) && opts.port >= 0 ? opts.port : 0;
  const flag = `--remote-debugging-port=${cdpPort}`;
  const detectFn = typeof opts.detectProcess === 'function' ? opts.detectProcess : detectAntigravityProcess;
  const removePortFileFn =
    typeof opts.removePortFile === 'function' ? opts.removePortFile : removeStalePortFile;
  const spawnFn = typeof opts.spawn === 'function' ? opts.spawn : spawn;
  const targetPlatform = opts.platform || process.platform;
  const baseEnv = opts.env || process.env;
  const existsFn = typeof opts.exists === 'function' ? opts.exists : fs.existsSync;
  if (!opts.skipPortCleanup && !detectFn().running) {
    removePortFileFn();
  }
  const extraArgs = Array.isArray(opts.extraArgs) ? opts.extraArgs.filter((a) => typeof a === 'string' && a) : [];
  const hasBindAddr = extraArgs.some((a) => /^--remote-debugging-address(?:=|$)/i.test(a));
  const cdpArgs = hasBindAddr ? [flag] : [flag, '--remote-debugging-address=127.0.0.1'];
  const hasExtraEnv = Boolean(opts.extraEnv && typeof opts.extraEnv === 'object' && Object.keys(opts.extraEnv).length > 0);
  const needsNodeProxy = hasProxyUrlEnv(baseEnv) && !String(baseEnv.NODE_USE_ENV_PROXY || baseEnv.node_use_env_proxy || '').trim();
  const spawnEnv = hasExtraEnv || baseEnv.ELECTRON_RUN_AS_NODE || needsNodeProxy ? sanitizeAppLaunchEnv(baseEnv, opts.extraEnv) : undefined;
  if (targetPlatform === 'darwin') {
    const appTarget = opts.appPath || findAntigravityExecutable() || 'Antigravity';
    const macBin = hasExtraEnv ? resolveMacAppBinary(appTarget) : null;
    // On macOS, `/usr/bin/open -a` delegates to LaunchServices and drops custom env vars
    // (HTTP_PROXY/HTTPS_PROXY/GODEBUG). Spawn the app binary directly when custom env is needed.
    const child = macBin
      ? spawnFn(macBin, [...cdpArgs, ...extraArgs], {
          detached: true,
          stdio: 'ignore',
          env: spawnEnv,
        })
      : spawnFn('/usr/bin/open', ['-a', appTarget, '--args', ...cdpArgs, ...extraArgs], {
          detached: true,
          stdio: 'ignore',
          ...(spawnEnv ? { env: spawnEnv } : {}),
        });
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  }
  const customLaunch = !opts.appPath
    ? resolveCustomLaunchCommand({ env: baseEnv, platform: targetPlatform, existsFn })
    : null;
  const exePath = opts.appPath || customLaunch || findAntigravityExecutable();
  if (!exePath) return false;
  if (targetPlatform === 'win32') {
    const inv = buildWinSpawnInvocation(exePath, [...cdpArgs, ...extraArgs], baseEnv);
    const child = spawnFn(inv.command, inv.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: inv.isScript,
      ...(spawnEnv ? { env: spawnEnv } : {}),
    });
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  }
  const child = spawnFn(exePath, [...cdpArgs, ...extraArgs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    ...(spawnEnv ? { env: spawnEnv } : {}),
  });
  if (child && typeof child.unref === 'function') child.unref();
  return true;
}

function scheduleDetachedRelaunch({
  pids = [],
  appPath,
  port = 0,
  waitMs = 8000,
  delayMs = 300,
  extraArgs = [],
  extraEnv = {},
  baseEnv = process.env,
  portFile = PORT_FILE,
  lockFile = '',
  spawnFn = spawn,
} = {}) {
  const cdpPort = Number.isInteger(port) && port >= 0 ? port : 0;
  const cleanExtra = Array.isArray(extraArgs) ? extraArgs.filter((a) => typeof a === 'string' && a) : [];
  const hasBindAddr = cleanExtra.some((a) => /^--remote-debugging-address(?:=|$)/i.test(a));
  const launchArgs = [
    `--remote-debugging-port=${cdpPort}`,
    ...(hasBindAddr ? [] : ['--remote-debugging-address=127.0.0.1']),
    ...cleanExtra,
  ];
  const singletonLockFile = IS_MAC
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'SingletonLock')
    : !IS_WIN
    ? path.join(os.homedir(), '.config', 'Antigravity', 'SingletonLock')
    : '';
  const payload = {
    pids: Array.isArray(pids) ? pids.filter((p) => Number.isInteger(p) && p > 0) : [],
    appPath: String(appPath || ''),
    macBinary: IS_MAC ? resolveMacAppBinary(String(appPath || '')) || '' : '',
    launchArgs,
    waitMs: Number.isInteger(waitMs) && waitMs > 0 ? waitMs : 8000,
    delayMs: Number.isInteger(delayMs) && delayMs >= 0 ? delayMs : 300,
    portFile: String(portFile || PORT_FILE),
    lockFile: String(lockFile || ''),
    singletonLockFile,
    logFile: path.join(STATE_DIR || __dirname, 'relaunch.log'),
    isMac: IS_MAC,
    isWin: IS_WIN,
    extraEnv: extraEnv && typeof extraEnv === 'object' ? extraEnv : {},
  };
  // Runs completely outside Antigravity's process tree so killing Antigravity
  // does not terminate the relauncher before it can spawn the new instance.
  // On Windows, stage 1 immediately spawns stage 2 and exits so stage 2's ParentProcessId
  // is orphaned and cannot be killed by `taskkill /T` walking Antigravity's process tree.
  // Crucially strips ELECTRON_RUN_AS_NODE & ANTIGRAVITY_SIDECAR_* before spawning Antigravity
  // (when invoked from an Electron Helper sidecar, process.env contains ELECTRON_RUN_AS_NODE=1!).
  const helperScript = `
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const cfg = JSON.parse(process.env.AGY_RELAUNCH_SPEC || '{}');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } };
const log = (m) => { try { if (cfg.logFile) { fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true }); fs.appendFileSync(cfg.logFile, '[' + new Date().toISOString() + '] ' + m + '\\n'); } } catch {} };
const claimLock = () => {
  if (!cfg.lockFile) return;
  try {
    fs.mkdirSync(path.dirname(cfg.lockFile), { recursive: true });
    fs.writeFileSync(cfg.lockFile, JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + '\\n', 'utf8');
  } catch {}
};
const releaseLock = () => {
  if (!cfg.lockFile) return;
  try {
    const raw = fs.readFileSync(cfg.lockFile, 'utf8');
    const cur = JSON.parse(raw);
    if (!cur || !cur.pid || cur.pid === process.pid) fs.unlinkSync(cfg.lockFile);
  } catch {
    try { if (fs.existsSync(cfg.lockFile)) fs.unlinkSync(cfg.lockFile); } catch {}
  }
};
if (cfg.isWin && !process.env.AGY_RELAUNCH_STAGE2 && process.env.AGY_RELAUNCH_CODE) {
  try {
    const stage2 = spawn(process.execPath, ['-e', process.env.AGY_RELAUNCH_CODE], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, AGY_RELAUNCH_STAGE2: '1' },
    });
    stage2.unref();
  } catch (e) {
    log('stage2 spawn error: ' + (e && e.message || e));
    releaseLock();
  }
  process.exit(0);
}
(async () => {
  claimLock();
  try {
    if (cfg.delayMs > 0) await sleep(cfg.delayMs);
    const pids = (Array.isArray(cfg.pids) ? cfg.pids : []).filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid);
    log('terminating pids=' + JSON.stringify(pids));
    const waitMs = cfg.waitMs || 8000;
    const deadline = Date.now() + waitMs;
    if (cfg.isWin) {
      for (const p of pids) {
        try { execFileSync('taskkill', ['/PID', String(p)], { timeout: 4000, windowsHide: true, stdio: 'ignore' }); } catch {}
      }
      const softDeadline = Date.now() + Math.min(2500, Math.floor(waitMs / 2));
      while (Date.now() < softDeadline && pids.some(alive)) {
        await sleep(80);
      }
      const stubborn = pids.filter(alive);
      if (stubborn.length > 0) {
        log('escalating force taskkill for pids=' + JSON.stringify(stubborn));
        for (const p of stubborn) {
          try { execFileSync('taskkill', ['/F', '/PID', String(p), '/T'], { timeout: 4000, windowsHide: true, stdio: 'ignore' }); } catch {}
        }
      }
      while (Date.now() < deadline && pids.some(alive)) {
        await sleep(80);
      }
    } else {
      for (const p of pids) {
        try { process.kill(p, 'SIGTERM'); } catch {}
      }
      const softDeadline = Date.now() + Math.min(3500, Math.floor(waitMs / 2));
      while (Date.now() < softDeadline && pids.some(alive)) {
        await sleep(80);
      }
      const stubborn = pids.filter(alive);
      if (stubborn.length > 0) {
        log('escalating SIGKILL for stubborn pids=' + JSON.stringify(stubborn));
        for (const p of stubborn) {
          try { process.kill(p, 'SIGKILL'); } catch {}
        }
      }
      while (Date.now() < deadline && pids.some(alive)) {
        await sleep(80);
      }
    }
    const remaining = pids.filter(alive);
    if (remaining.length > 0) {
      log('abort: target pids still alive=' + JSON.stringify(remaining));
      return;
    }
    try { if (cfg.portFile && fs.existsSync(cfg.portFile)) fs.unlinkSync(cfg.portFile); } catch {}
    if (cfg.singletonLockFile) {
      const lockWaitEnd = Date.now() + 600;
      while (Date.now() < lockWaitEnd) {
        let lockExists = false;
        try { fs.lstatSync(cfg.singletonLockFile); lockExists = true; } catch {}
        if (!lockExists) break;
        await sleep(40);
      }
      await sleep(80);
    } else {
      await sleep(200);
    }
    const extraEnv = cfg.extraEnv && typeof cfg.extraEnv === 'object' ? cfg.extraEnv : {};
    const env = { ...process.env };
    const stripExactUpper = new Set([
      'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS', 'NODE_PATH',
      'AGY_RELAUNCH_SPEC', 'AGY_RELAUNCH_CODE', 'AGY_RELAUNCH_STAGE2', 'AG_CDP_PORT', 'PLUGIN_DATA',
      'ANTIGRAVITY_SOURCE_METADATA', 'ANTIGRAVITY_EXECUTABLE_DATA_DIR', 'ANTIGRAVITY_NODE_PATH'
    ]);
    for (const k of Object.keys(env)) {
      const u = k.toUpperCase();
      if (stripExactUpper.has(u) || u.startsWith('ANTIGRAVITY_SIDECAR_') || u.startsWith('ANTIGRAVITY_LS_') || u.startsWith('ANTIGRAVITY_HOST_BRIDGE_')) {
        delete env[k];
      }
    }
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined || v === null) delete env[k];
      else env[k] = String(v);
    }
    if (
      ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some((k) => String(env[k] || '').trim()) &&
      !String(env.NODE_USE_ENV_PROXY || env.node_use_env_proxy || '').trim()
    ) {
      env.NODE_USE_ENV_PROXY = '1';
    }
  const maskArgs = (args) => (args || []).map((a) => String(a || '').replace(/^(--proxy-server=[^/]+\\/\\/)[^/@\\s]+@/i, '$1***@'));
  if (cfg.isMac) {
      const macBin = cfg.macBinary || (cfg.appPath && cfg.appPath.toLowerCase().endsWith('.app') ? path.join(cfg.appPath, 'Contents', 'MacOS', 'Antigravity') : '');
      if (macBin && fs.existsSync(macBin)) {
        const child = spawn(macBin, cfg.launchArgs || [], { detached: true, stdio: 'ignore', env });
        const childPid = child && child.pid ? child.pid : 0;
        child.unref();
        log('spawning macBin=' + macBin + ' spawnPid=' + childPid + ' args=' + JSON.stringify(maskArgs(cfg.launchArgs)) + ' proxy=' + Boolean(env.HTTPS_PROXY) + ' electronRunAsNode=' + String(env.ELECTRON_RUN_AS_NODE));
        const readyDeadline = Date.now() + 6000;
        let portReady = false;
        while (Date.now() < readyDeadline) {
          if (cfg.portFile && fs.existsSync(cfg.portFile)) {
            portReady = true;
            break;
          }
          if (childPid > 0 && !alive(childPid)) {
            break;
          }
          await sleep(100);
        }
        const childAlive = childPid > 0 ? alive(childPid) : false;
        log('cdpPortReady=' + portReady + ' childAlive=' + childAlive);
        // Bring Antigravity to foreground via /usr/bin/open only when the spawned instance is alive or CDP is ready,
        // so open -a can never accidentally launch a bare unproxied instance on collision.
        if ((portReady || childAlive) && cfg.appPath && fs.existsSync(cfg.appPath)) {
          try {
            const act = spawn('/usr/bin/open', ['-a', cfg.appPath], { detached: true, stdio: 'ignore' });
            act.unref();
          } catch {}
        }
      } else {
        log('fallback open -a ' + (cfg.appPath || 'Antigravity'));
        const child = spawn('/usr/bin/open', ['-a', cfg.appPath || 'Antigravity', '--args', ...(cfg.launchArgs || [])], {
          detached: true, stdio: 'ignore', env
        });
        child.unref();
      }
    } else if (cfg.appPath) {
      const winIsBatch = cfg.isWin && /\.(?:cmd|bat)$/i.test(cfg.appPath);
      const winIsPs1 = cfg.isWin && /\.ps1$/i.test(cfg.appPath);
      const safeLaunchArgs = (cfg.launchArgs || []).map((a) => String(a || ''));
      const needsWinVerbatim = winIsBatch && (/\s/.test(cfg.appPath) || safeLaunchArgs.some((a) => /[;\s"&|<>^%!]/.test(a)));
      const qWin = (s) => '"' + String(s || '').replace(/"/g, '') + '"';
      const spawnCmd = winIsBatch
        ? (env.ComSpec || env.COMSPEC || 'cmd.exe')
        : winIsPs1
        ? 'powershell.exe'
        : cfg.appPath;
      const spawnArgs = winIsBatch
        ? (needsWinVerbatim
          ? ['/d', '/s', '/c', '"' + [qWin(cfg.appPath), ...safeLaunchArgs.map(qWin)].join(' ') + '"']
          : ['/d', '/c', cfg.appPath, ...safeLaunchArgs])
        : winIsPs1
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cfg.appPath, ...safeLaunchArgs]
        : safeLaunchArgs;
      const child = spawn(spawnCmd, spawnArgs, {
        detached: true, stdio: 'ignore', windowsHide: winIsBatch || winIsPs1, ...(needsWinVerbatim ? { windowsVerbatimArguments: true } : {}), env
      });
      const childPid = child && child.pid ? child.pid : 0;
      child.unref();
      log('spawning appPath=' + cfg.appPath + ' spawnPid=' + childPid + ' args=' + JSON.stringify(maskArgs(cfg.launchArgs)) + ' proxy=' + Boolean(env.HTTPS_PROXY));
      const readyDeadline = Date.now() + 6000;
      let portReady = false;
      while (Date.now() < readyDeadline) {
        if (cfg.portFile && fs.existsSync(cfg.portFile)) {
          portReady = true;
          break;
        }
        if (childPid > 0 && !alive(childPid)) {
          break;
        }
        await sleep(100);
      }
      log('cdpPortReady=' + portReady + ' childAlive=' + (childPid > 0 ? alive(childPid) : false));
    }
  } finally {
    releaseLock();
  }
})().catch((e) => {
  log('error: ' + (e && e.message || e));
  releaseLock();
});
`.trim();

  const child = spawnFn(process.execPath, ['-e', helperScript], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...baseEnv,
      AGY_RELAUNCH_SPEC: JSON.stringify(payload),
      AGY_RELAUNCH_CODE: helperScript,
    },
  });
  if (child && typeof child.unref === 'function') child.unref();
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
      : (pids, { force = false } = {}) => {
          if (IS_WIN) {
            const validWinPids = Array.isArray(pids) ? pids.filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid) : [];
            if (validWinPids.length > 0) {
              for (const pid of validWinPids) {
                try {
                  const args = force ? ['/F', '/PID', String(pid), '/T'] : ['/PID', String(pid)];
                  execFileSync('taskkill', args, {
                    timeout: 4000,
                    windowsHide: true,
                    stdio: 'ignore',
                  });
                } catch {}
              }
            }
          } else {
            for (const pid of pids) {
              if (pid > 0 && pid !== process.pid) {
                try {
                  process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
                } catch {}
              }
            }
          }
        };

  const initialProc = detectFn();
  const initialPids = Array.isArray(initialProc?.pids) ? initialProc.pids : [];
  const existsFn = typeof opts.exists === 'function' ? opts.exists : fs.existsSync;
  const customLaunch = !opts.appPath
    ? resolveCustomLaunchCommand({
        env: opts.env || process.env,
        platform: opts.platform || process.platform,
        existsFn,
      })
    : null;
  const resolvedPath = opts.appPath || customLaunch || resolveRunningFn(initialPids) || findExeFn();
  const hasValidTarget = Boolean(
    resolvedPath && (typeof opts.launch === 'function' || existsFn(resolvedPath))
  );
  if (!hasValidTarget) {
    return { relaunched: false, reason: 'executable-not-found' };
  }

  if (opts.detached === true && typeof opts.launch !== 'function' && typeof opts.terminate !== 'function') {
    const useLock = opts.useLock !== false && (Boolean(opts.lockPath) || typeof opts.spawn !== 'function');
    const lockPath = opts.lockPath || RELAUNCH_LOCK_FILE;
    if (useLock) {
      const lockRes = tryAcquireRelaunchLock({ lockPath, nowMs: opts.nowMs, isAliveFn: opts.isAliveFn });
      if (!lockRes.acquired) {
        return {
          relaunched: false,
          skipped: true,
          reason: 'relaunch-in-progress',
          ownerPid: lockRes.ownerPid || null,
        };
      }
    }
    try {
      scheduleDetachedRelaunch({
        pids: initialPids,
        appPath: resolvedPath,
        port: opts.port ?? 0,
        waitMs,
        delayMs: opts.delayMs ?? 300,
        extraArgs: opts.extraArgs,
        extraEnv: opts.extraEnv,
        baseEnv: opts.env || process.env,
        lockFile: useLock ? lockPath : '',
        spawnFn: opts.spawn,
      });
    } catch (err) {
      if (useLock) releaseRelaunchLock(lockPath, { ownerPid: process.pid });
      throw err;
    }
    return { relaunched: true, scheduled: true, reason: 'detached' };
  }

  try {
    killFn(initialPids, { force: false });
  } catch {}

  const deadline = Date.now() + waitMs;
  const forceAfter = Date.now() + Math.min(2500, Math.floor(waitMs / 2));
  let escalated = false;
  while (Date.now() < deadline) {
    if (!detectFn().running) break;
    if (IS_WIN && !escalated && typeof opts.terminate !== 'function' && Date.now() >= forceAfter) {
      escalated = true;
      try {
        killFn(initialPids, { force: true });
      } catch {}
    }
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

const RELAUNCH_GUARD_FILE = path.join(STATE_DIR, 'relaunch-guard.json');
const RELAUNCH_LOCK_FILE = path.join(STATE_DIR, '.relaunch.lock');
const RELAUNCH_LOCK_STALE_MS = 15000;
const RELAUNCH_LOCK_HANDOFF_GRACE_MS = 3000;
const AUTO_RELAUNCH_COOLDOWN_MS = 120000;
const AUTO_RELAUNCH_MAX_FAILURES = 2;

function isPidAliveSimple(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

function readRelaunchLock(lockPath = RELAUNCH_LOCK_FILE) {
  try {
    if (!fs.existsSync(lockPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pid: Number(parsed.pid) || 0,
      createdAt: Number(parsed.createdAt) || 0,
    };
  } catch {
    return null;
  }
}

function isRelaunchLockStale(
  lock,
  {
    nowMs = Date.now(),
    staleMs = RELAUNCH_LOCK_STALE_MS,
    handoffGraceMs = RELAUNCH_LOCK_HANDOFF_GRACE_MS,
    isAliveFn = isPidAliveSimple,
  } = {}
) {
  if (!lock || typeof lock !== 'object') return true;
  const createdAt = Number(lock.createdAt) || 0;
  if (createdAt <= 0) return true;
  const age = nowMs - createdAt;
  if (age < 0 || age >= staleMs) return true;
  if (age >= handoffGraceMs && Number.isInteger(lock.pid) && lock.pid > 0 && !isAliveFn(lock.pid)) {
    return true;
  }
  return false;
}

function isRelaunchInProgress({
  lockPath = RELAUNCH_LOCK_FILE,
  nowMs = Date.now(),
  staleMs = RELAUNCH_LOCK_STALE_MS,
  handoffGraceMs = RELAUNCH_LOCK_HANDOFF_GRACE_MS,
  isAliveFn = isPidAliveSimple,
} = {}) {
  const lock = readRelaunchLock(lockPath);
  return Boolean(lock && !isRelaunchLockStale(lock, { nowMs, staleMs, handoffGraceMs, isAliveFn }));
}

function tryAcquireRelaunchLock({
  lockPath = RELAUNCH_LOCK_FILE,
  pid = process.pid,
  nowMs = Date.now(),
  staleMs = RELAUNCH_LOCK_STALE_MS,
  handoffGraceMs = RELAUNCH_LOCK_HANDOFF_GRACE_MS,
  isAliveFn = isPidAliveSimple,
} = {}) {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {}
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid, createdAt: nowMs }) + '\n', 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { acquired: true, lockPath, pid, createdAt: nowMs };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        return { acquired: false, reason: 'lock-error', error: err?.message || String(err), lockPath };
      }
      const existing = readRelaunchLock(lockPath);
      if (isRelaunchLockStale(existing, { nowMs, staleMs, handoffGraceMs, isAliveFn })) {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
        continue;
      }
      return {
        acquired: false,
        reason: 'relaunch-in-progress',
        ownerPid: existing?.pid || null,
        lockPath,
      };
    }
  }
  const existing = readRelaunchLock(lockPath);
  return {
    acquired: false,
    reason: 'relaunch-in-progress',
    ownerPid: existing?.pid || null,
    lockPath,
  };
}

function releaseRelaunchLock(lockPath = RELAUNCH_LOCK_FILE, { ownerPid } = {}) {
  try {
    if (!fs.existsSync(lockPath)) return false;
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      const existing = readRelaunchLock(lockPath);
      if (existing && existing.pid > 0 && existing.pid !== ownerPid) return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function defaultRelaunchGuard() {
  return {
    lastAttemptAt: 0,
    lastPidSig: '',
    consecutiveFailures: 0,
    tripped: false,
    trippedAt: 0,
    lastReason: '',
    lastSuccessAt: 0,
  };
}

function readRelaunchGuard(guardPath = RELAUNCH_GUARD_FILE) {
  try {
    if (!fs.existsSync(guardPath)) return defaultRelaunchGuard();
    const parsed = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return defaultRelaunchGuard();
    return {
      ...defaultRelaunchGuard(),
      lastAttemptAt: Number(parsed.lastAttemptAt) || 0,
      lastPidSig: String(parsed.lastPidSig || ''),
      consecutiveFailures: Math.max(0, Number(parsed.consecutiveFailures) || 0),
      tripped: Boolean(parsed.tripped),
      trippedAt: Number(parsed.trippedAt) || 0,
      lastReason: String(parsed.lastReason || ''),
      lastSuccessAt: Number(parsed.lastSuccessAt) || 0,
    };
  } catch {
    return defaultRelaunchGuard();
  }
}

function writeRelaunchGuard(state, guardPath = RELAUNCH_GUARD_FILE) {
  try {
    writeFileAtomic(guardPath, JSON.stringify({ ...defaultRelaunchGuard(), ...(state || {}) }, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

function evaluateAutoRelaunchGuard(
  guard,
  {
    pidSig = '',
    nowMs = Date.now(),
    cooldownMs = AUTO_RELAUNCH_COOLDOWN_MS,
    maxFailures = AUTO_RELAUNCH_MAX_FAILURES,
  } = {}
) {
  const g = { ...defaultRelaunchGuard(), ...(guard || {}) };
  if (g.tripped || g.consecutiveFailures >= maxFailures) {
    return { allowed: false, reason: 'circuit-breaker', consecutiveFailures: g.consecutiveFailures };
  }
  if (pidSig && g.lastPidSig === pidSig) {
    return { allowed: false, reason: 'same-pid', consecutiveFailures: g.consecutiveFailures };
  }
  if (g.lastAttemptAt > 0 && nowMs - g.lastAttemptAt < cooldownMs) {
    return {
      allowed: false,
      reason: 'cooldown',
      remainingCooldownMs: Math.max(0, cooldownMs - (nowMs - g.lastAttemptAt)),
      consecutiveFailures: g.consecutiveFailures,
    };
  }
  return { allowed: true, reason: 'ok', consecutiveFailures: g.consecutiveFailures };
}

function recordAutoRelaunchAttempt(
  { pidSig = '', nowMs = Date.now(), reason = 'cold-start-no-cdp', maxFailures = AUTO_RELAUNCH_MAX_FAILURES } = {},
  guardPath = RELAUNCH_GUARD_FILE
) {
  const prev = readRelaunchGuard(guardPath);
  const consecutiveFailures = prev.consecutiveFailures + 1;
  const tripped = consecutiveFailures >= maxFailures;
  const next = {
    ...prev,
    lastAttemptAt: nowMs,
    lastPidSig: String(pidSig || ''),
    consecutiveFailures,
    tripped,
    trippedAt: tripped ? nowMs : prev.trippedAt,
    lastReason: String(reason || ''),
  };
  writeRelaunchGuard(next, guardPath);
  return next;
}

function resetRelaunchGuard({ markSuccess = false, reason = '', nowMs = Date.now() } = {}, guardPath = RELAUNCH_GUARD_FILE) {
  const prev = readRelaunchGuard(guardPath);
  const dirty = prev.consecutiveFailures > 0 || prev.tripped || Boolean(prev.lastPidSig) || prev.lastAttemptAt > 0;
  if (!dirty && !markSuccess) return prev;
  const next = {
    ...defaultRelaunchGuard(),
    lastSuccessAt: markSuccess ? nowMs : prev.lastSuccessAt,
    lastReason: String(reason || (markSuccess ? 'cdp-connected' : '')),
  };
  if (dirty || (markSuccess && prev.lastSuccessAt === 0)) {
    writeRelaunchGuard(next, guardPath);
  }
  return next;
}

function buildProxyLaunchOptionsFromConfig(cfg = {}) {
  if (!cfg || cfg.proxyEnabled !== true) return { args: [], env: {} };
  const raw = typeof cfg.proxyUrl === 'string' ? cfg.proxyUrl.trim() : '';
  if (!raw || raw.length > 256 || /[\x00-\x1f\x7f\s'"`\\;$|&<>]/.test(raw)) return { args: [], env: {} };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { args: [], env: {} };
  }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol) || !parsed.hostname) {
    return { args: [], env: {} };
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    return { args: [], env: {} };
  }
  const auth = parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@` : '';
  const host = parsed.hostname.includes(':') && !parsed.hostname.startsWith('[') ? `[${parsed.hostname}]` : parsed.hostname;
  const port = parsed.port ? `:${parsed.port}` : '';
  const normalized = `${parsed.protocol}//${auth}${host}${port}`;

  const rawBypass = String(cfg.proxyBypass || 'localhost,127.0.0.1,::1').trim();
  const safeBypass = /[\x00-\x1f\x7f'"`\\$|&<>%^!]/.test(rawBypass) ? 'localhost,127.0.0.1,::1' : rawBypass;
  const parts = safeBypass.split(/[;,\s]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set(parts.map((p) => p.toLowerCase()));
  for (const req of ['localhost', '127.0.0.1', '::1']) {
    if (!seen.has(req)) {
      parts.unshift(req);
      seen.add(req);
    }
  }
  const bypass = parts.join(',');
  const chromiumBypass = parts.map((s) => (s === '::1' ? '[::1]' : s)).join(';');
  const noProxy = bypass.includes('[::1]') ? bypass : `${bypass},[::1]`;
  const args = [`--proxy-server=${normalized}`, `--proxy-bypass-list=${chromiumBypass}`];
  const env = {
    HTTP_PROXY: normalized,
    HTTPS_PROXY: normalized,
    ALL_PROXY: normalized,
    NO_PROXY: noProxy,
    http_proxy: normalized,
    https_proxy: normalized,
    all_proxy: normalized,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: '1',
  };
  if (cfg.proxyForceHttp1 !== false) env.GODEBUG = 'http2client=0';
  return { args, env };
}

function hasConfiguredProxyFlag(pids, cfg = {}, { inspectCmdFn = inspectProcessCommand } = {}) {
  const proxyOpts = buildProxyLaunchOptionsFromConfig(cfg);
  const expectedArg = proxyOpts.args.find((a) => a.startsWith('--proxy-server='));
  if (!expectedArg) {
    return { required: false, matched: true, inspected: false, expectedUrl: '' };
  }
  const expectedUrl = expectedArg.slice('--proxy-server='.length);
  const list = Array.isArray(pids) ? pids : [];
  let inspectedAny = false;
  for (const pid of list) {
    const cmd = inspectCmdFn(pid);
    if (!cmd) continue;
    inspectedAny = true;
    const m = String(cmd).match(/--proxy-server=(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const activeUrl = m ? String(m[1] || m[2] || m[3] || '').trim() : '';
    if (activeUrl === expectedUrl) {
      return { required: true, matched: true, inspected: true, expectedUrl };
    }
  }
  if (!inspectedAny) {
    return { required: true, matched: true, inspected: false, expectedUrl };
  }
  return { required: true, matched: false, inspected: true, expectedUrl };
}

function formatCdpUnavailableMessage({ running, port }) {
  const launchHint = IS_MAC
    ? '在右侧 Claude Style 控制室点击「立即重启启用」，或执行 open -a Antigravity --args --remote-debugging-port=0'
    : IS_WIN
    ? '在右侧 Claude Style 控制室点击「立即重启启用」，或带参数启动 Antigravity.exe --remote-debugging-port=0'
    : '在右侧 Claude Style 控制室点击「立即重启启用」，或带参数启动 antigravity --remote-debugging-port=0';
  if (running) {
    return (
      `检测到 Antigravity 正在运行，但未开启远程调试端口（Antigravity 2.33.0+ 默认关闭 CDP` +
      `${port ? `，端口 ${port} 无响应` : `，未生成 ${PORT_FILE}`}）。` +
      `请${launchHint}`
    );
  }
  if (port) {
    return `端口 ${port} 无响应：Antigravity 可能未运行。请${launchHint}`;
  }
  return `未找到调试端口文件，Antigravity 未运行: ${PORT_FILE}。如使用 Antigravity 2.33.0+，请${launchHint}`;
}

module.exports = {
  STYLE_ID,
  PLUGIN_VERSION,
  SETTING_BINDING,
  RUNTIME_PARTS,
  PORT_FILE,
  STATE_DIR,
  PID_FILE,
  CONFIG_FILE,
  resolvePluginDataDir,
  DEFAULT_CONFIG,
  CONFIG_VALIDATORS,
  validateConfigSetting,
  writeFileAtomic,
  readConfig,
  updateConfigSetting,
  readPort,
  SWARM_SIDECAR_URL_PREFIX,
  isInjectableTarget,
  listPages,
  detectAntigravityProcess,
  parseWin32AntigravityProcesses,
  findAntigravityExecutable,
  resolveRunningAntigravityPath,
  hasRemoteDebuggingFlag,
  splitCommandArgs,
  inspectProcessInfo,
  inspectProcessCommand,
  evaluateWatcherOwnership,
  matchesWatcherForDir,
  classifyWatcherPid,
  resolveExistingWatchPidAction,
  isLikelyWatcherProcess,
  removeStalePortFile,
  activateAntigravityWindow,
  hideAntigravityWindow,
  sanitizeAppLaunchEnv,
  hasProxyUrlEnv,
  resolveCustomLaunchCommand,
  buildWinSpawnInvocation,
  launchAntigravityWithCdp,
  scheduleDetachedRelaunch,
  relaunchAntigravityWithCdp,
  RELAUNCH_GUARD_FILE,
  RELAUNCH_LOCK_FILE,
  AUTO_RELAUNCH_COOLDOWN_MS,
  AUTO_RELAUNCH_MAX_FAILURES,
  readRelaunchLock,
  isRelaunchLockStale,
  isRelaunchInProgress,
  tryAcquireRelaunchLock,
  releaseRelaunchLock,
  readRelaunchGuard,
  writeRelaunchGuard,
  evaluateAutoRelaunchGuard,
  recordAutoRelaunchAttempt,
  resetRelaunchGuard,
  buildProxyLaunchOptionsFromConfig,
  hasConfiguredProxyFlag,
  formatCdpUnavailableMessage,
  CdpSession,
  readCss,
  readRuntimeBundle,
  readInstalledSidecarLogos,
  computeHash,
  buildInjectExpression,
  buildConfigScriptExpression,
  buildRefreshExpression,
  REMOVE_EXPRESSION,
};
