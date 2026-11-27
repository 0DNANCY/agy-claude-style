import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { collectPluginPayloadFiles, getArtifactNames, normalizeVersion } from '../scripts/build-common.mjs';
import { VALIDATORS, buildInstaller } from '../scripts/build-installer.mjs';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const cdp = require(path.join(ROOT_DIR, 'cdp.js'));

function runExe(exePath, args, timeoutMs = 20000, extraEnv = null) {
  return new Promise((resolve, reject) => {
    const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
    const child = spawn(exePath, args, { stdio: 'ignore', windowsHide: true, env });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`Timeout running ${path.basename(exePath)} ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(exePath)} exited with code ${code}`));
    });
  });
}

function listCsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listCsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.cs')) {
      out.push(full);
    }
  }
  return out.sort();
}

test('installer validators and native plugin payload collection stay aligned with cdp.js', () => {
  const manifestKeys = Object.keys(VALIDATORS).sort();
  assert.deepEqual(manifestKeys, Object.keys(cdp.CONFIG_VALIDATORS).sort());
  for (const k of manifestKeys) {
    assert.ok(k in cdp.DEFAULT_CONFIG, `DEFAULT_CONFIG includes ${k}`);
    const rule = cdp.CONFIG_VALIDATORS[k];
    if (rule === 'boolean') {
      assert.equal(cdp.validateConfigSetting(k, true), true);
      assert.equal(cdp.validateConfigSetting(k, 'invalid'), false);
    } else if (Array.isArray(rule)) {
      assert.equal(cdp.validateConfigSetting(k, rule[0]), true);
      assert.equal(cdp.validateConfigSetting(k, '__invalid_opt__'), false);
    }
  }
  assert.equal(cdp.validateConfigSetting('pollIntervalMs', 3000), true);
  assert.equal(cdp.validateConfigSetting('pollIntervalMs', 50), false);
  assert.equal(cdp.validateConfigSetting('__unknown_key__', true), false);
  assert.equal('exitOnHostClose' in cdp.DEFAULT_CONFIG, false);
  assert.equal('exitOnHostClose' in cdp.CONFIG_VALIDATORS, false);

  const payload = collectPluginPayloadFiles(ROOT_DIR);
  const names = new Set(payload.map((p) => p.name));
  for (const requiredFile of [
    'plugin.json',
    'mcp_config.json',
    'package.json',
    'config.example.json',
    'cdp.js',
    'inject.js',
    'style.css',
    'sidecar-core.js',
    'plugin/mcp-host.js',
    'plugin/host-lifecycle.js',
    'sidecars/panel/sidecar.json',
    'sidecars/panel/main.mjs',
    'sidecars/panel/index.html',
    'sidecars/panel/ui/control-tab.js',
    'features/branch-edit.js',
    'assets/logo.svg',
  ]) {
    assert.ok(names.has(requiredFile), `Plugin payload includes ${requiredFile}`);
  }
  assert.equal(names.has('agy-claude-style-watcher.exe'), false);
  assert.equal(names.has('remove.js'), false);
  assert.equal(names.has('config.json'), false);
});

test('unified artifact naming and version parity stay consistent across package, plugin, and runtime', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'plugin.json'), 'utf8'));

  assert.equal(cdp.PLUGIN_VERSION, pkg.version);
  assert.equal(pluginManifest.version, pkg.version);
  assert.equal(normalizeVersion('v2.2.0'), '2.2.0');
  assert.equal(normalizeVersion('2.2.0'), '2.2.0');

  assert.deepEqual(getArtifactNames('v2.2.0'), {
    version: '2.2.0',
    windowsInstaller: 'AGY-Claude-Style-v2.2.0-Windows-x64.exe',
    macosDmg: 'AGY-Claude-Style-v2.2.0-macOS-universal.dmg',
    macosApp: 'AGY Claude Style.app',
  });
});

test('Windows C# sources act purely as native plugin installer and stay strictly C# 5 compatible', () => {
  const csFiles = listCsFiles(path.join(ROOT_DIR, 'installer'));
  assert.equal(csFiles.length, 2, 'Only MiniJson.cs and setup/Program.cs should exist under installer/');

  const csSetup = fs.readFileSync(path.join(ROOT_DIR, 'installer', 'setup', 'Program.cs'), 'utf8');
  assert.ok(csSetup.includes('AGY_CS_TEST_SYSTEM_ROOT'));
  assert.ok(csSetup.includes('plugin_data'));
  assert.ok(csSetup.includes('JetboxWriteState'));
  assert.ok(csSetup.includes('DeletePlugin'));
  assert.ok(csSetup.includes('AGY_PAYLOAD.zip'));
  assert.equal(csSetup.includes('System.Net.WebSockets'), false, 'Setup installer must not contain CDP WebSocket client');
  assert.equal(csSetup.includes('--launch --relaunch'), false, 'Setup installer must not emit external launcher commands');

  for (const file of csFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT_DIR, file);
    assert.equal(src.includes('$"'), false, `${rel} must not use C# 6 interpolated strings ($")`);
    assert.equal(src.includes('?.'), false, `${rel} must not use C# 6 null-conditional (?.)`);
    assert.equal(src.includes('?['), false, `${rel} must not use C# 6 null-conditional (?[)`);
    assert.equal(/\bnameof\s*\(/.test(src), false, `${rel} must not use C# 6 nameof(...)`);
    assert.equal(/\busing\s+var\b/.test(src), false, `${rel} must not use C# 8 using var`);
  }
});

test(
  'installer.exe builds cleanly and executes native plugin install, legacy migration & cleanup, upgrade, and uninstall E2E',
  { skip: process.platform !== 'win32' ? 'Windows-only installer.exe E2E test' : false },
  async () => {
    const workDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-plugin-e2e-')));
    const testSysRoot = path.join(workDir, 'sysroot');
    const installerExe = path.join(workDir, 'installer.exe');
    const expectedPluginDir = path.join(testSysRoot, '.gemini', 'config', 'plugins', 'agy-claude-style');
    const expectedDataDir = path.join(testSysRoot, '.gemini', 'antigravity', 'plugin_data', 'agy-claude-style');
    const antigravityCfgPath = path.join(testSysRoot, '.gemini', 'config', 'config.json');

    const legacyDir = path.join(testSysRoot, 'LegacyLocalAppData', 'agy-claude-style');
    const legacyStartup = path.join(testSysRoot, 'Startup', 'AGY-Claude-Style.lnk');
    const legacyDesktop = path.join(testSysRoot, 'Desktop', 'Antigravity (AGY Claude Style).lnk');
    const legacyStartMenu = path.join(testSysRoot, 'StartMenu', 'Antigravity (AGY Claude Style).lnk');

    const outStatusBefore = path.join(workDir, 'status-before.json');
    const outInstall = path.join(workDir, 'install.json');
    const outStatusAfter = path.join(workDir, 'status-after.json');
    const outUpgrade = path.join(workDir, 'upgrade.json');
    const outUninstall = path.join(workDir, 'uninstall.json');

    const testEnv = {
      AGY_CS_TEST_SYSTEM_ROOT: testSysRoot,
    };

    try {
      const buildRes = buildInstaller({ outputPath: installerExe });
      assert.ok(fs.existsSync(installerExe));
      assert.ok(buildRes.sizeBytes > 200 * 1024);

      // Seed legacy install + config.json (with deprecated exitOnHostClose) + legacy shortcuts
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyDir, 'config.json'),
        JSON.stringify({ palette: 'claude', exitOnHostClose: true }, null, 2),
        'utf8'
      );
      for (const lnk of [legacyStartup, legacyDesktop, legacyStartMenu]) {
        fs.mkdirSync(path.dirname(lnk), { recursive: true });
        fs.writeFileSync(lnk, 'legacy-lnk', 'utf8');
      }

      // 1) --status before install
      await runExe(installerExe, ['--status', '--out', outStatusBefore], 15000, testEnv);
      const stBefore = JSON.parse(fs.readFileSync(outStatusBefore, 'utf8'));
      assert.equal(stBefore.installed, false);
      assert.equal(stBefore.installDir, expectedPluginDir);
      assert.equal(stBefore.pluginDataDir, expectedDataDir);
      assert.equal(stBefore.hasLegacyInstall, true);

      // 2) --silent install into native plugin dir, migrating legacy config & cleaning legacy artifacts
      await runExe(installerExe, ['--silent', '--out', outInstall], 25000, testEnv);
      const resInstall = JSON.parse(fs.readFileSync(outInstall, 'utf8'));
      assert.equal(resInstall.ok, true);
      assert.equal(resInstall.mode, 'install');
      assert.equal(resInstall.installDir, expectedPluginDir);
      assert.equal(resInstall.migratedLegacyConfig, true);
      assert.equal(resInstall.preservedExistingConfig, true);
      assert.equal(resInstall.legacyCleaned, true);
      assert.equal(resInstall.pluginEnabled, true);
      assert.ok(resInstall.fileCount >= 30);

      // Verify complete native plugin tree and absence of external watcher
      for (const rel of [
        'plugin.json',
        'mcp_config.json',
        'cdp.js',
        'inject.js',
        'style.css',
        'sidecar-core.js',
        path.join('plugin', 'mcp-host.js'),
        path.join('plugin', 'host-lifecycle.js'),
        path.join('sidecars', 'panel', 'sidecar.json'),
        path.join('sidecars', 'panel', 'main.mjs'),
        path.join('features', 'branch-edit.js'),
      ]) {
        assert.ok(fs.existsSync(path.join(expectedPluginDir, rel)), `Installed plugin has ${rel}`);
      }
      assert.equal(fs.existsSync(path.join(expectedPluginDir, 'agy-claude-style-watcher.exe')), false);
      assert.equal(fs.existsSync(path.join(expectedPluginDir, '.watch.pid')), false);

      // Verify legacy cleaned up & config migrated cleanly without exitOnHostClose
      assert.equal(fs.existsSync(legacyDir), false);
      assert.equal(fs.existsSync(legacyStartup), false);
      assert.equal(fs.existsSync(legacyDesktop), false);
      assert.equal(fs.existsSync(legacyStartMenu), false);

      const migratedCfg = JSON.parse(fs.readFileSync(path.join(expectedDataDir, 'config.json'), 'utf8'));
      assert.equal(migratedCfg.palette, 'claude');
      assert.equal('exitOnHostClose' in migratedCfg, false);

      const agCfg = JSON.parse(fs.readFileSync(antigravityCfgPath, 'utf8'));
      assert.equal(agCfg.plugins['agy-claude-style'].enabled, true);

      // 3) --status after install
      await runExe(installerExe, ['--status', '--out', outStatusAfter], 15000, testEnv);
      const stAfter = JSON.parse(fs.readFileSync(outStatusAfter, 'utf8'));
      assert.equal(stAfter.installed, true);
      assert.equal(stAfter.pluginEnabled, true);
      assert.equal(stAfter.hasConfig, true);
      assert.equal(stAfter.hasLegacyInstall, false);

      // 4) Upgrade preserves existing plugin_data config.json
      await runExe(installerExe, ['--silent', '--out', outUpgrade], 25000, testEnv);
      const resUpgrade = JSON.parse(fs.readFileSync(outUpgrade, 'utf8'));
      assert.equal(resUpgrade.ok, true);
      assert.equal(resUpgrade.preservedExistingConfig, true);
      assert.equal(resUpgrade.migratedLegacyConfig, false);
      const cfgAfterUpgrade = JSON.parse(fs.readFileSync(path.join(expectedDataDir, 'config.json'), 'utf8'));
      assert.equal(cfgAfterUpgrade.palette, 'claude');

      // 5) --uninstall removes plugin dir, disables plugin entry, and preserves user config.json
      await runExe(installerExe, ['--uninstall', '--silent', '--out', outUninstall], 20000, testEnv);
      const resUninstall = JSON.parse(fs.readFileSync(outUninstall, 'utf8'));
      assert.equal(resUninstall.ok, true);
      assert.equal(resUninstall.mode, 'uninstall');
      assert.equal(resUninstall.pluginEnabled, false);
      assert.equal(fs.existsSync(expectedPluginDir), false);
      assert.ok(fs.existsSync(path.join(expectedDataDir, 'config.json')));
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {}
    }
  }
);
