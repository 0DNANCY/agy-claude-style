#!/usr/bin/env node
// Cross-platform zero-dependency CLI for AGY Claude Style (install / uninstall / status).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ROOT_DIR, collectPluginPayloadFiles } from './build-common.mjs';
import {
  applyPluginUpdate,
  checkForUpdates,
  cleanupLegacyExternalArtifacts,
  isGitCheckoutDir,
  pruneStalePluginFiles,
  resolveInstalledVersion,
  terminateStaleOwnedMcpHosts,
} from '../sidecars/panel/lib/updater.mjs';

const require = createRequire(import.meta.url);
const cdpApi = require('../cdp.js');

const PLUGIN_NAME = 'agy-claude-style';
const SIDECAR_NAME = 'agy-claude-style/panel';
const LEGACY_LAUNCH_AGENT = 'io.github.0dnancy.agy-claude-style';

function getTestSystemRoot(env = process.env) {
  const raw = String(env.AGY_CS_TEST_SYSTEM_ROOT || '').trim();
  return raw ? path.resolve(raw) : null;
}

function isTestSandbox(env = process.env) {
  return Boolean(getTestSystemRoot(env));
}

function resolveGeminiDir(env = process.env) {
  const testRoot = getTestSystemRoot(env);
  if (testRoot) return path.join(testRoot, '.gemini');
  const envDir = String(env.ANTIGRAVITY_GEMINI_DIR || '').trim();
  if (envDir) return path.resolve(envDir);
  return path.join(os.homedir(), '.gemini');
}

function getDefaultInstallDir(env = process.env) {
  return path.join(resolveGeminiDir(env), 'config', 'plugins', PLUGIN_NAME);
}

function getPluginDataDir(env = process.env) {
  return path.join(resolveGeminiDir(env), 'antigravity', 'plugin_data', PLUGIN_NAME);
}

function getAntigravityConfigPath(env = process.env) {
  return path.join(resolveGeminiDir(env), 'config', 'config.json');
}

function getLegacyInstallDir(env = process.env, platform = process.platform) {
  const testRoot = getTestSystemRoot(env);
  if (testRoot) {
    return path.join(testRoot, platform === 'win32' ? 'LegacyLocalAppData' : 'LegacyAppSupport', PLUGIN_NAME);
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, PLUGIN_NAME);
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', PLUGIN_NAME);
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), PLUGIN_NAME);
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    fs.copyFileSync(tmp, filePath);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function stripDeprecatedAndCopyConfig(srcPath, destPath) {
  try {
    const raw = fs.readFileSync(srcPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    delete parsed.exitOnHostClose;
    writeFileAtomic(destPath, JSON.stringify(parsed, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function discoverRunningLanguageServers(env = process.env) {
  if (isTestSandbox(env)) return [];
  const daemonDir = path.join(resolveGeminiDir(env), 'antigravity', 'daemon');
  if (!fs.existsSync(daemonDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(daemonDir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(daemonDir, entry), 'utf8'));
      const pid = Number(doc?.pid);
      const httpPort = Number(doc?.httpPort);
      const csrfToken = String(doc?.csrfToken || '').trim();
      if (Number.isInteger(pid) && pid > 0 && Number.isInteger(httpPort) && httpPort > 0 && csrfToken && isPidAlive(pid)) {
        out.push({ pid, httpPort, csrfToken });
      }
    } catch {}
  }
  return out;
}

function callLsRpc(daemon, method, body, timeoutMs = 2500) {
  return new Promise((resolvePromise) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(daemon.httpPort),
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        agent: false,
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': daemon.csrfToken,
          'x-antigravity-csrf-token': daemon.csrfToken,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        try { res.resume(); } catch {}
        resolvePromise(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on('timeout', () => {
      try { req.destroy(); } catch {}
      resolvePromise(false);
    });
    req.on('error', () => resolvePromise(false));
    req.end(payload);
  });
}

async function setLsPluginState(daemons, enabled) {
  if (!daemons.length) return false;
  const body = {
    plugins: { [PLUGIN_NAME]: { enabled } },
    sidecars: { [SIDECAR_NAME]: { enabled } },
  };
  let any = false;
  for (const d of daemons) {
    if (await callLsRpc(d, 'JetboxWriteState', body)) any = true;
  }
  return any;
}

async function deleteLsPlugin(daemons) {
  if (!daemons.length) return false;
  let any = false;
  for (const d of daemons) {
    if (await callLsRpc(d, 'DeletePlugin', { pluginName: PLUGIN_NAME })) any = true;
  }
  return any;
}

function readPluginEnabledState(env = process.env) {
  const cfgPath = getAntigravityConfigPath(env);
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const doc = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const entry = doc?.plugins?.[PLUGIN_NAME];
    if (typeof entry === 'boolean') return entry;
    if (entry && typeof entry === 'object') {
      return entry.enabled === undefined ? true : Boolean(entry.enabled);
    }
  } catch {}
  return false;
}

function setPluginEnabledInConfigFile(enable, env = process.env) {
  const cfgPath = getAntigravityConfigPath(env);
  if (!enable && !fs.existsSync(cfgPath)) return;
  let doc = {};
  if (fs.existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed;
    } catch {}
  }
  if (!doc.plugins || typeof doc.plugins !== 'object' || Array.isArray(doc.plugins)) {
    doc.plugins = {};
  }
  if (enable) {
    const existing = doc.plugins[PLUGIN_NAME];
    const entry = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
    entry.enabled = true;
    doc.plugins[PLUGIN_NAME] = entry;
  } else {
    delete doc.plugins[PLUGIN_NAME];
  }
  writeFileAtomic(cfgPath, JSON.stringify(doc, null, 2) + '\n');
}

function cleanupLegacyArtifacts(installDir, env = process.env, platform = process.platform) {
  let cleaned = false;
  const testRoot = getTestSystemRoot(env);

  if (!isTestSandbox(env) && platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/IM', 'agy-claude-style-watcher.exe'], { stdio: 'ignore', windowsHide: true });
      cleaned = true;
    } catch {}
    try {
      execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AgyClaudeStyle', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      cleaned = true;
    } catch {}
  }

  if (platform === 'win32') {
    const shortcuts = testRoot
      ? [
          path.join(testRoot, 'Startup', 'AGY-Claude-Style.lnk'),
          path.join(testRoot, 'StartMenu', 'Antigravity (AGY Claude Style).lnk'),
          path.join(testRoot, 'Desktop', 'Antigravity (AGY Claude Style).lnk'),
        ]
      : [
          env.APPDATA ? path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'AGY-Claude-Style.lnk') : '',
          env.APPDATA ? path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Antigravity', 'Antigravity (AGY Claude Style).lnk') : '',
          env.USERPROFILE ? path.join(env.USERPROFILE, 'Desktop', 'Antigravity (AGY Claude Style).lnk') : '',
        ].filter(Boolean);
    for (const lnk of shortcuts) {
      if (fs.existsSync(lnk)) {
        try { fs.unlinkSync(lnk); cleaned = true; } catch {}
      }
    }
  } else if (platform === 'darwin') {
    const plist = testRoot
      ? path.join(testRoot, 'LaunchAgents', `${LEGACY_LAUNCH_AGENT}.plist`)
      : path.join(os.homedir(), 'Library', 'LaunchAgents', `${LEGACY_LAUNCH_AGENT}.plist`);
    if (fs.existsSync(plist)) {
      if (!isTestSandbox(env)) {
        try { execFileSync('launchctl', ['unload', '-w', plist], { stdio: 'ignore' }); } catch {}
      }
      try { fs.unlinkSync(plist); cleaned = true; } catch {}
    }
    const launcherApp = testRoot
      ? path.join(testRoot, 'Applications', 'Antigravity (AGY Claude Style).app')
      : path.join(os.homedir(), 'Applications', 'Antigravity (AGY Claude Style).app');
    if (fs.existsSync(launcherApp)) {
      try { fs.rmSync(launcherApp, { recursive: true, force: true }); cleaned = true; } catch {}
    }
  }

  const legacyDir = getLegacyInstallDir(env, platform);
  if (legacyDir && fs.existsSync(legacyDir) && path.resolve(legacyDir) !== path.resolve(installDir)) {
    try { fs.rmSync(legacyDir, { recursive: true, force: true }); cleaned = true; } catch {}
  }

  const pluginDataDir = getPluginDataDir(env);
  const oldUninstaller = path.join(pluginDataDir, 'agy-claude-style-uninstaller.exe');
  if (fs.existsSync(oldUninstaller)) {
    try { fs.unlinkSync(oldUninstaller); cleaned = true; } catch {}
  }

  for (const legacyFile of [
    'agy-claude-style-watcher.exe',
    'agy-claude-style-installer.exe',
    'manifest.json',
    '.install-mode',
    '.watch.pid',
    'Antigravity (AGY Claude Style).lnk',
  ]) {
    const f = path.join(installDir, legacyFile);
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); cleaned = true; } catch {}
    }
  }

  return cleaned;
}

function readInstalledVersion(installDir) {
  const pj = path.join(installDir, 'plugin.json');
  if (!fs.existsSync(pj)) return null;
  try {
    return JSON.parse(fs.readFileSync(pj, 'utf8'))?.version || null;
  } catch {
    return null;
  }
}

async function runInstall(opts = {}, env = process.env) {
  const sourceDir = path.resolve(opts.sourceDir || ROOT_DIR);
  const installDir = path.resolve(opts.installDir || getDefaultInstallDir(env));
  const pluginDataDir = getPluginDataDir(env);
  const legacyDir = getLegacyInstallDir(env);

  fs.mkdirSync(pluginDataDir, { recursive: true });
  const activeCfgPath = path.join(pluginDataDir, 'config.json');
  const legacyCfgPath = path.join(legacyDir, 'config.json');

  let preservedExistingConfig = false;
  let migratedLegacyConfig = false;
  if (fs.existsSync(activeCfgPath)) {
    preservedExistingConfig = stripDeprecatedAndCopyConfig(activeCfgPath, activeCfgPath) || true;
  } else if (fs.existsSync(legacyCfgPath)) {
    migratedLegacyConfig = stripDeprecatedAndCopyConfig(legacyCfgPath, activeCfgPath);
    if (migratedLegacyConfig) preservedExistingConfig = true;
  }

  const daemons = discoverRunningLanguageServers(env);
  if (await setLsPluginState(daemons, false)) {
    await new Promise((r) => setTimeout(r, 350));
  }

  const legacyCleaned =
    cleanupLegacyExternalArtifacts({ installDir, stateDir: pluginDataDir, env }).cleaned ||
    cleanupLegacyArtifacts(installDir, env);

  const payload = collectPluginPayloadFiles(sourceDir);
  const fullInstallRoot = path.resolve(installDir) + path.sep;
  const validRelPaths = new Set();
  for (const entry of payload) {
    const destPath = path.resolve(installDir, entry.name);
    if (!destPath.startsWith(fullInstallRoot)) {
      throw new Error(`Unsafe payload path: ${entry.name}`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, entry.data);
    validRelPaths.add(entry.name);
  }
  const pruneRes = pruneStalePluginFiles(installDir, validRelPaths);

  if (!fs.existsSync(activeCfgPath)) {
    const exampleCfg = path.join(installDir, 'config.example.json');
    if (fs.existsSync(exampleCfg)) {
      fs.copyFileSync(exampleCfg, activeCfgPath);
    }
  }

  terminateStaleOwnedMcpHosts({ installDir, stateDir: pluginDataDir, cdpModule: cdpApi });
  setPluginEnabledInConfigFile(true, env);
  const lsHotReloaded = await setLsPluginState(daemons, true);

  return {
    ok: true,
    mode: 'install',
    version: readInstalledVersion(installDir),
    installDir,
    pluginDataDir,
    configPath: activeCfgPath,
    preservedExistingConfig,
    migratedLegacyConfig,
    legacyCleaned,
    prunedCount: pruneRes.prunedCount,
    pluginEnabled: readPluginEnabledState(env),
    lsHotReloaded,
    fileCount: payload.length,
  };
}

async function runUninstall(opts = {}, env = process.env) {
  const installDir = path.resolve(opts.installDir || getDefaultInstallDir(env));
  const pluginDataDir = getPluginDataDir(env);

  const daemons = discoverRunningLanguageServers(env);
  let lsHotReloaded = await deleteLsPlugin(daemons);
  if (!lsHotReloaded) {
    lsHotReloaded = await setLsPluginState(daemons, false);
  }
  if (lsHotReloaded) {
    await new Promise((r) => setTimeout(r, 350));
  }

  setPluginEnabledInConfigFile(false, env);
  const legacyCleaned = cleanupLegacyArtifacts(installDir, env);

  if (fs.existsSync(installDir)) {
    fs.rmSync(installDir, { recursive: true, force: true });
  }

  return {
    ok: true,
    mode: 'uninstall',
    installDir,
    pluginDataDir,
    legacyCleaned,
    pluginEnabled: readPluginEnabledState(env),
    lsHotReloaded,
  };
}

function getStatus(opts = {}, env = process.env) {
  const installDir = path.resolve(opts.installDir || getDefaultInstallDir(env));
  const pluginDataDir = getPluginDataDir(env);
  const wallpapersDir = path.join(pluginDataDir, 'wallpapers');
  return {
    ok: true,
    mode: 'status',
    installed: fs.existsSync(path.join(installDir, 'plugin.json')),
    installedVersion: readInstalledVersion(installDir),
    pluginEnabled: readPluginEnabledState(env),
    installDir,
    pluginDataDir,
    hasConfig: fs.existsSync(path.join(pluginDataDir, 'config.json')),
    hasWallpapersDir: fs.existsSync(wallpapersDir),
  };
}

function readProxyConfigFromDataDir(pluginDataDir) {
  try {
    const cfgPath = path.join(pluginDataDir, 'config.json');
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    }
  } catch {}
  return null;
}

async function runCheckUpdate(opts = {}, env = process.env) {
  const installDir = path.resolve(opts.installDir || getDefaultInstallDir(env));
  const pluginDataDir = getPluginDataDir(env);
  const currentVersion =
    readInstalledVersion(installDir) || resolveInstalledVersion(ROOT_DIR, '4.0.0');
  const proxyConfig = readProxyConfigFromDataDir(pluginDataDir);
  const res = await checkForUpdates({
    currentVersion,
    installDir,
    stateDir: pluginDataDir,
    force: opts.force !== false,
    proxyConfig,
    ...(opts.apiUrl ? { apiUrl: opts.apiUrl, allowCustomUrlForTest: true } : {}),
  });
  return {
    ...res,
    mode: 'check-update',
    installed: fs.existsSync(path.join(installDir, 'plugin.json')),
    installDir,
    pluginDataDir,
  };
}

async function runUpdate(opts = {}, env = process.env) {
  const installDir = path.resolve(opts.installDir || getDefaultInstallDir(env));
  const pluginDataDir = getPluginDataDir(env);
  const proxyConfig = readProxyConfigFromDataDir(pluginDataDir);

  if (isGitCheckoutDir(installDir) && !opts.allowGitOverwrite) {
    return {
      ok: false,
      mode: 'update',
      isGitRepo: true,
      installDir,
      error: 'Installed directory is a Git checkout; please run git pull && npm run setup.',
    };
  }

  const checkRes = await runCheckUpdate({ ...opts, force: true }, env);
  if (!checkRes.ok) {
    return { ...checkRes, mode: 'update' };
  }
  if (!checkRes.hasUpdate && !opts.force) {
    return {
      ok: true,
      mode: 'update',
      alreadyLatest: true,
      previousVersion: checkRes.currentVersion,
      updatedVersion: checkRes.currentVersion,
      installDir,
      pluginDataDir,
      lsHotReloaded: false,
    };
  }

  const daemons = discoverRunningLanguageServers(env);
  if (await setLsPluginState(daemons, false)) {
    await new Promise((r) => setTimeout(r, 350));
  }

  const applyRes = await applyPluginUpdate({
    installDir,
    stateDir: pluginDataDir,
    downloadUrl: opts.downloadUrl || checkRes.downloadUrl,
    targetVersion: checkRes.latestVersion,
    allowGitOverwrite: Boolean(opts.allowGitOverwrite),
    proxyConfig,
    allowCustomUrlForTest: Boolean(opts.downloadUrl || opts.apiUrl),
    env,
  });
  if (!applyRes.ok) {
    await setLsPluginState(daemons, true);
    return { ...applyRes, mode: 'update' };
  }

  terminateStaleOwnedMcpHosts({ installDir, stateDir: pluginDataDir, cdpModule: cdpApi });
  setPluginEnabledInConfigFile(true, env);
  const lsHotReloaded = await setLsPluginState(daemons, true);
  return {
    ...applyRes,
    mode: 'update',
    pluginDataDir,
    pluginEnabled: readPluginEnabledState(env),
    lsHotReloaded,
  };
}

function parseCliArgs(argv) {
  const opts = { command: 'install', json: false, silent: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'install' || a === 'uninstall' || a === 'status' || a === 'check-update' || a === 'update') {
      opts.command = a;
    } else if (a === '--uninstall') {
      opts.command = 'uninstall';
    } else if (a === '--status') {
      opts.command = 'status';
    } else if (a === '--check-update') {
      opts.command = 'check-update';
    } else if (a === '--update') {
      opts.command = 'update';
    } else if (a === '--force') {
      opts.force = true;
    } else if (a === '--install-dir' && argv[i + 1]) {
      opts.installDir = argv[++i];
    } else if (a === '--source-dir' && argv[i + 1]) {
      opts.sourceDir = argv[++i];
    } else if (a === '--out' && argv[i + 1]) {
      opts.outFile = argv[++i];
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--silent' || a === '-s') {
      opts.silent = true;
    }
  }
  return opts;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  let res;
  if (opts.command === 'status') {
    res = getStatus(opts);
  } else if (opts.command === 'uninstall') {
    res = await runUninstall(opts);
  } else if (opts.command === 'check-update') {
    res = await runCheckUpdate(opts);
  } else if (opts.command === 'update') {
    res = await runUpdate(opts);
  } else {
    res = await runInstall(opts);
  }
  if (opts.outFile) {
    writeFileAtomic(path.resolve(opts.outFile), JSON.stringify(res, null, 2) + '\n');
  }
  if (!opts.silent) {
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (opts.command === 'status') {
      console.log(`AGY Claude Style: ${res.installed ? `v${res.installedVersion || '?'} (enabled=${res.pluginEnabled})` : 'not installed'}`);
      console.log(`  Plugin Dir: ${res.installDir}`);
      console.log(`  Data Dir:   ${res.pluginDataDir}`);
    } else if (opts.command === 'check-update') {
      if (!res.ok) {
        console.error(`[!] Update check failed: ${res.error || 'unknown error'}`);
        process.exitCode = 1;
      } else if (res.hasUpdate) {
        console.log(`[!] Update available: v${res.currentVersion} -> v${res.latestVersion}`);
        console.log(`    Release: ${res.releaseUrl}`);
        console.log(`    Upgrade: npm run update  (or ${res.installCommand})`);
      } else {
        console.log(`[✓] AGY Claude Style v${res.currentVersion} is up to date.`);
      }
    } else if (opts.command === 'update') {
      if (!res.ok) {
        console.error(`[!] Update failed: ${res.error || 'unknown error'}`);
        process.exitCode = 1;
      } else if (res.alreadyLatest) {
        console.log(`[✓] AGY Claude Style v${res.updatedVersion} is already up to date.`);
      } else {
        console.log(`[✓] Updated AGY Claude Style v${res.previousVersion} -> v${res.updatedVersion} (${res.fileCount} files)`);
        console.log(res.lsHotReloaded
          ? '    Hot-reloaded via running Antigravity Language Server.'
          : '    Updated on disk (takes effect on Antigravity launch).');
      }
    } else if (opts.command === 'uninstall') {
      console.log(`[✓] Uninstalled AGY Claude Style from ${res.installDir}`);
      console.log(`    User data preserved at ${res.pluginDataDir}`);
    } else {
      console.log(`[✓] Installed AGY Claude Style v${res.version || '?'} (${res.fileCount} files) -> ${res.installDir}`);
      console.log(res.lsHotReloaded
        ? '    Hot-enabled via running Antigravity Language Server.'
        : '    Enabled in Antigravity config.json (takes effect on Antigravity launch).');
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(`[!] ${err?.message || err}`);
    process.exit(1);
  });
}

export {
  PLUGIN_NAME,
  resolveGeminiDir,
  getDefaultInstallDir,
  getPluginDataDir,
  getAntigravityConfigPath,
  runInstall,
  runUninstall,
  getStatus,
  runCheckUpdate,
  runUpdate,
};
