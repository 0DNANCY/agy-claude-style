import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { collectPluginPayloadFiles, getArtifactNames, normalizeVersion } from '../scripts/build-common.mjs';
import { buildPackage } from '../scripts/build-package.mjs';

const require = createRequire(import.meta.url);
const cdp = require('../cdp.js');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

test('package builder and payload collection align with cdp.js and exclude binary installers', () => {
  assert.equal(normalizeVersion('v4.0.0'), '4.0.0');
  assert.deepEqual(getArtifactNames('4.0.0'), {
    version: '4.0.0',
    pluginZip: 'agy-claude-style-v4.0.0.zip',
  });

  const payload = collectPluginPayloadFiles(ROOT_DIR);
  const names = new Set(payload.map((e) => e.name));
  for (const required of [
    'plugin.json',
    'mcp_config.json',
    'install.ps1',
    'install.sh',
    'cdp.js',
    'inject.js',
    'wallpaper-server.js',
    'features/theme-engine.js',
    'features/wallpaper.js',
    'scripts/cli.mjs',
    'sidecars/panel/main.mjs',
    'sidecars/panel/lib/wallpaper-store.mjs',
  ]) {
    assert.ok(names.has(required), `Missing required payload entry: ${required}`);
  }
  for (const name of names) {
    assert.equal(name.startsWith('installer/'), false, `Obsolete installer entry leaked into payload: ${name}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-pkg-'));
  try {
    const outZip = path.join(tmpDir, 'out.zip');
    const built = buildPackage({ rootDir: ROOT_DIR, outputPath: outZip, version: '4.0.0' });
    assert.ok(fs.existsSync(outZip));
    assert.ok(built.fileCount >= 30);
    assert.ok(built.sizeBytes > 1024);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scripts/cli.mjs executes sandboxed install, legacy migration, upgrade preserving wallpapers, status, and uninstall', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-cli-e2e-'));
  const env = {
    ...process.env,
    AGY_CS_TEST_SYSTEM_ROOT: tmpRoot,
  };
  const legacyDir = path.join(
    tmpRoot,
    process.platform === 'win32' ? 'LegacyLocalAppData' : 'LegacyAppSupport',
    'agy-claude-style'
  );
  const pluginDir = path.join(tmpRoot, '.gemini', 'config', 'plugins', 'agy-claude-style');
  const dataDir = path.join(tmpRoot, '.gemini', 'antigravity', 'plugin_data', 'agy-claude-style');
  const wallpapersDir = path.join(dataDir, 'wallpapers');
  const agCfgPath = path.join(tmpRoot, '.gemini', 'config', 'config.json');

  try {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'config.json'),
      JSON.stringify({ palette: 'nord', exitOnHostClose: true }, null, 2),
      'utf8'
    );

    const statusBefore = JSON.parse(
      execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'cli.mjs'), 'status', '--json'], { env, encoding: 'utf8' })
    );
    assert.equal(statusBefore.installed, false);

    const installRes = JSON.parse(
      execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'cli.mjs'), 'install', '--json'], { env, encoding: 'utf8' })
    );
    assert.equal(installRes.ok, true);
    assert.equal(installRes.migratedLegacyConfig, true);
    assert.equal(installRes.pluginEnabled, true);
    assert.ok(fs.existsSync(path.join(pluginDir, 'plugin.json')));
    assert.ok(fs.existsSync(path.join(pluginDir, 'features', 'theme-engine.js')));
    assert.ok(fs.existsSync(path.join(pluginDir, 'features', 'wallpaper.js')));

    const migratedCfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(migratedCfg.palette, 'nord');
    assert.equal('exitOnHostClose' in migratedCfg, false);

    const agCfg = JSON.parse(fs.readFileSync(agCfgPath, 'utf8'));
    assert.equal(agCfg.plugins['agy-claude-style'].enabled, true);

    // Add a user wallpaper and upgrade; verify both config.json and wallpapers/ survive
    fs.mkdirSync(wallpapersDir, { recursive: true });
    fs.writeFileSync(path.join(wallpapersDir, 'wp-user.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const upgradeRes = JSON.parse(
      execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'cli.mjs'), 'install', '--json'], { env, encoding: 'utf8' })
    );
    assert.equal(upgradeRes.preservedExistingConfig, true);
    assert.ok(fs.existsSync(path.join(wallpapersDir, 'wp-user.png')));

    const uninstallRes = JSON.parse(
      execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'cli.mjs'), 'uninstall', '--json'], { env, encoding: 'utf8' })
    );
    assert.equal(uninstallRes.ok, true);
    assert.equal(uninstallRes.pluginEnabled, false);
    assert.equal(fs.existsSync(pluginDir), false);
    assert.ok(fs.existsSync(path.join(dataDir, 'config.json')));
    assert.ok(fs.existsSync(path.join(wallpapersDir, 'wp-user.png')));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test(
  'install.ps1 installs from local zip archive, migrates legacy config, and uninstalls cleanly in sandbox',
  { skip: process.platform !== 'win32' ? 'Windows PowerShell test' : false },
  () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-ps1-e2e-'));
    const env = { ...process.env, AGY_CS_TEST_SYSTEM_ROOT: tmpRoot };
    const zipPath = path.join(tmpRoot, 'pkg.zip');
    const outInstall = path.join(tmpRoot, 'install-out.json');
    const outStatus = path.join(tmpRoot, 'status-out.json');
    const outUninstall = path.join(tmpRoot, 'uninstall-out.json');
    const pluginDir = path.join(tmpRoot, '.gemini', 'config', 'plugins', 'agy-claude-style');
    const dataDir = path.join(tmpRoot, '.gemini', 'antigravity', 'plugin_data', 'agy-claude-style');
    const legacyDir = path.join(tmpRoot, 'LegacyLocalAppData', 'agy-claude-style');

    try {
      buildPackage({ rootDir: ROOT_DIR, outputPath: zipPath, version: '4.0.0' });
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'config.json'), JSON.stringify({ palette: 'tokyo', exitOnHostClose: true }), 'utf8');

      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(ROOT_DIR, 'install.ps1'),
          '-ArchivePath',
          zipPath,
          '-OutFile',
          outInstall,
          '-Silent',
        ],
        { env, encoding: 'utf8', windowsHide: true }
      );
      const installRes = JSON.parse(fs.readFileSync(outInstall, 'utf8'));
      assert.equal(installRes.ok, true);
      assert.equal(installRes.migratedLegacyConfig, true);
      assert.equal(installRes.pluginEnabled, true);
      assert.ok(fs.existsSync(path.join(pluginDir, 'plugin.json')));

      const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
      assert.equal(cfg.palette, 'tokyo');
      assert.equal('exitOnHostClose' in cfg, false);

      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(ROOT_DIR, 'install.ps1'),
          '-Status',
          '-OutFile',
          outStatus,
          '-Silent',
        ],
        { env, encoding: 'utf8', windowsHide: true }
      );
      const statusRes = JSON.parse(fs.readFileSync(outStatus, 'utf8'));
      assert.equal(statusRes.installed, true);
      assert.equal(statusRes.installedVersion, cdp.PLUGIN_VERSION);

      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(ROOT_DIR, 'install.ps1'),
          '-Uninstall',
          '-OutFile',
          outUninstall,
          '-Silent',
        ],
        { env, encoding: 'utf8', windowsHide: true }
      );
      const unRes = JSON.parse(fs.readFileSync(outUninstall, 'utf8'));
      assert.equal(unRes.ok, true);
      assert.equal(unRes.pluginEnabled, false);
      assert.equal(fs.existsSync(pluginDir), false);
      assert.ok(fs.existsSync(path.join(dataDir, 'config.json')));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
);

test(
  'install.sh installs from local zip archive and uninstalls cleanly in sandbox',
  { skip: process.platform === 'win32' ? 'POSIX shell test runs on macOS/Linux' : false },
  () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-sh-e2e-'));
    const env = { ...process.env, AGY_CS_TEST_SYSTEM_ROOT: tmpRoot };
    const zipPath = path.join(tmpRoot, 'pkg.zip');
    const outInstall = path.join(tmpRoot, 'install.json');
    const outUninstall = path.join(tmpRoot, 'uninstall.json');
    const pluginDir = path.join(tmpRoot, '.gemini', 'config', 'plugins', 'agy-claude-style');
    const dataDir = path.join(tmpRoot, '.gemini', 'antigravity', 'plugin_data', 'agy-claude-style');

    try {
      buildPackage({ rootDir: ROOT_DIR, outputPath: zipPath, version: '4.0.0' });
      execFileSync(
        'bash',
        [path.join(ROOT_DIR, 'install.sh'), '--archive', zipPath, '--out', outInstall, '--silent'],
        { env, encoding: 'utf8' }
      );
      const ins = JSON.parse(fs.readFileSync(outInstall, 'utf8'));
      assert.equal(ins.ok, true);
      assert.equal(ins.pluginEnabled, true);
      assert.ok(fs.existsSync(path.join(pluginDir, 'plugin.json')));

      execFileSync(
        'bash',
        [path.join(ROOT_DIR, 'install.sh'), '--uninstall', '--out', outUninstall, '--silent'],
        { env, encoding: 'utf8' }
      );
      const un = JSON.parse(fs.readFileSync(outUninstall, 'utf8'));
      assert.equal(un.ok, true);
      assert.equal(un.pluginEnabled, false);
      assert.equal(fs.existsSync(pluginDir), false);
      assert.ok(fs.existsSync(path.join(dataDir, 'config.json')));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
);
