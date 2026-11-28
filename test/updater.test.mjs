import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildZip, collectPluginPayloadFiles } from '../scripts/build-common.mjs';

const require = createRequire(import.meta.url);
const cdp = require('../cdp.js');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { runCheckUpdate, runInstall, runUpdate } from '../scripts/cli.mjs';
import {
  applyPluginUpdate,
  checkForUpdates,
  compareSemver,
  createUpdateManager,
  extractZipBufferSafe,
} from '../sidecars/panel/lib/updater.mjs';

test('compareSemver compares major/minor/patch and prerelease versions accurately', () => {
  assert.equal(compareSemver('4.1.0', '4.0.0'), 1);
  assert.equal(compareSemver('v4.0.10', '4.0.2'), 1);
  assert.equal(compareSemver('4.0.0', '4.0.0-beta.1'), 1);
  assert.equal(compareSemver('4.0.0-rc.2', '4.0.0-rc.1'), 1);
  assert.equal(compareSemver('v4.0.0', '4.0.0'), 0);
  assert.equal(compareSemver('3.9.9', '4.0.0'), -1);
});

test('extractZipBufferSafe strips single root dir, validates manifest, and rejects Zip-Slip / CRC tampering', () => {
  const manifestBuf = Buffer.from(
    JSON.stringify({ name: 'agy-claude-style', version: '9.9.9' }, null, 2),
    'utf8'
  );
  const wrappedZip = buildZip([
    { name: 'agy-claude-style-main/plugin.json', data: manifestBuf },
    { name: 'agy-claude-style-main/cdp.js', data: Buffer.from('// ok\n', 'utf8') },
    { name: 'agy-claude-style-main/config.json', data: Buffer.from('{"palette":"evil"}', 'utf8') },
  ]);
  const extracted = extractZipBufferSafe(wrappedZip);
  assert.equal(extracted.manifest.version, '9.9.9');
  const names = extracted.files.map((f) => f.name);
  assert.ok(names.includes('plugin.json'));
  assert.ok(names.includes('cdp.js'));
  assert.equal(names.includes('config.json'), false);

  // Tamper CRC32 in central directory
  const tampered = Buffer.from(wrappedZip);
  const eocdOff = tampered.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cdOff = tampered.readUInt32LE(eocdOff + 16);
  tampered.writeUInt32LE(0xdeadbeef, cdOff + 16);
  assert.throws(() => extractZipBufferSafe(tampered), /CRC32 checksum mismatch/);

  // Zip-Slip path traversal
  const evilZip = buildZip([
    { name: 'plugin.json', data: manifestBuf },
    { name: '../evil.js', data: Buffer.from('bad', 'utf8') },
  ]);
  assert.throws(() => extractZipBufferSafe(evilZip), /Unsafe zip entry path/);

  // Wrong plugin manifest
  const wrongManifestZip = buildZip([
    { name: 'plugin.json', data: Buffer.from(JSON.stringify({ name: 'other', version: '1.0.0' })) },
  ]);
  assert.throws(() => extractZipBufferSafe(wrongManifestZip), /missing valid agy-claude-style plugin\.json/);
});

test('checkForUpdates handles GitHub API, 403 rate-limit 302 redirect fallback, and 6h cache', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-upd-chk-'));
  try {
    const cachePath = path.join(tmpDir, 'update-cache.json');
    let apiCalls = 0;

    // 1. Primary GitHub API success + cache reuse
    const res1 = await checkForUpdates({
      currentVersion: '4.0.0',
      cachePath,
      force: true,
      fetchFn: async () => {
        apiCalls += 1;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              tag_name: 'v4.2.0',
              html_url: 'https://github.com/0DNANCY/agy-claude-style/releases/tag/v4.2.0',
              body: 'Added auto update check',
              published_at: '2026-11-28T10:00:00Z',
              assets: [
                {
                  name: 'agy-claude-style-v4.2.0.zip',
                  browser_download_url: 'https://github.com/0DNANCY/agy-claude-style/releases/download/v4.2.0/agy-claude-style-v4.2.0.zip',
                },
              ],
            };
          },
        };
      },
    });
    assert.equal(res1.ok, true);
    assert.equal(res1.hasUpdate, true);
    assert.equal(res1.latestVersion, '4.2.0');
    assert.equal(res1.source, 'github-api');
    assert.equal(apiCalls, 1);

    const resCached = await checkForUpdates({
      currentVersion: '4.0.0',
      cachePath,
      force: false,
      fetchFn: async () => {
        apiCalls += 1;
        throw new Error('Should not hit network while cache is fresh');
      },
    });
    assert.equal(resCached.cached, true);
    assert.equal(resCached.latestVersion, '4.2.0');
    assert.equal(apiCalls, 1);

    // 2. GitHub API 403 fallback to 302 web redirect
    const resFallback = await checkForUpdates({
      currentVersion: '4.0.0',
      cachePath,
      force: true,
      fetchFn: async (url) => {
        if (String(url).includes('api.github.com')) {
          return { ok: false, status: 403 };
        }
        if (String(url).includes('/releases/latest')) {
          return {
            ok: false,
            status: 302,
            headers: {
              get: (k) => (k.toLowerCase() === 'location' ? 'https://github.com/0DNANCY/agy-claude-style/releases/tag/v4.3.1' : null),
            },
          };
        }
        return { ok: false, status: 404 };
      },
    });
    assert.equal(resFallback.ok, true);
    assert.equal(resFallback.source, 'github-redirect');
    assert.equal(resFallback.latestVersion, '4.3.1');
    assert.equal(
      resFallback.downloadUrl,
      'https://github.com/0DNANCY/agy-claude-style/releases/download/v4.3.1/agy-claude-style-v4.3.1.zip'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('applyPluginUpdate & CLI check-update/update upgrade sandboxed plugin while preserving config and wallpapers', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-upd-e2e-'));
  const env = { ...process.env, AGY_CS_TEST_SYSTEM_ROOT: tmpRoot };
  const pluginDir = path.join(tmpRoot, '.gemini', 'config', 'plugins', 'agy-claude-style');
  const dataDir = path.join(tmpRoot, '.gemini', 'antigravity', 'plugin_data', 'agy-claude-style');
  const wallpapersDir = path.join(dataDir, 'wallpapers');
  const cfgPath = path.join(dataDir, 'config.json');

  // Build synthetic v9.9.9 release archive from current payload with bumped version
  const payload = collectPluginPayloadFiles(path.resolve(__dirname, '..')).map((entry) => {
    if (entry.name === 'plugin.json') {
      const pj = JSON.parse(entry.data.toString('utf8'));
      pj.version = '9.9.9';
      return { name: entry.name, data: Buffer.from(JSON.stringify(pj, null, 2) + '\n', 'utf8') };
    }
    return entry;
  });
  const releaseZip = buildZip(payload);

  const server = http.createServer((req, res) => {
    if (req.url === '/releases/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tag_name: 'v9.9.9',
          html_url: 'https://github.com/0DNANCY/agy-claude-style/releases/tag/v9.9.9',
          body: 'Test v9.9.9 release',
          assets: [
            {
              name: 'agy-claude-style-v9.9.9.zip',
              browser_download_url: `http://127.0.0.1:${server.address().port}/agy-claude-style-v9.9.9.zip`,
            },
          ],
        })
      );
      return;
    }
    if (req.url === '/agy-claude-style-v9.9.9.zip') {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(releaseZip);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await runInstall({}, env);
    fs.writeFileSync(cfgPath, JSON.stringify({ palette: 'claude', autoCheckUpdate: true }, null, 2), 'utf8');
    fs.mkdirSync(wallpapersDir, { recursive: true });
    fs.writeFileSync(path.join(wallpapersDir, 'wp-keep.png'), Buffer.from([1, 2, 3, 4]));
    // Seed legacy external binaries, legacy dir, and stale plugin files
    fs.writeFileSync(path.join(dataDir, 'agy-claude-style-uninstaller.exe'), Buffer.from('old-exe'));
    fs.writeFileSync(path.join(pluginDir, 'obsolete-old.js'), '// stale');
    fs.writeFileSync(path.join(pluginDir, 'watch.bat'), '@echo off');
    const legacyDir = path.join(
      tmpRoot,
      process.platform === 'win32' ? 'LegacyLocalAppData' : 'LegacyAppSupport',
      'agy-claude-style'
    );
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'old-watcher.exe'), 'legacy');

    const chk = await runCheckUpdate({ apiUrl: `${baseUrl}/releases/latest` }, env);
    assert.equal(chk.ok, true);
    assert.equal(chk.hasUpdate, true);
    assert.equal(chk.latestVersion, '9.9.9');

    const upd = await runUpdate(
      {
        apiUrl: `${baseUrl}/releases/latest`,
        downloadUrl: `${baseUrl}/agy-claude-style-v9.9.9.zip`,
      },
      env
    );
    assert.equal(upd.ok, true);
    assert.equal(upd.previousVersion, cdp.PLUGIN_VERSION);
    assert.equal(upd.updatedVersion, '9.9.9');
    assert.ok(upd.prunedCount >= 1);
    assert.ok(upd.legacyCleanedCount >= 2);

    const installedManifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
    assert.equal(installedManifest.version, '9.9.9');
    const keptCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(keptCfg.palette, 'claude');
    assert.ok(fs.existsSync(path.join(wallpapersDir, 'wp-keep.png')));
    assert.equal(fs.existsSync(path.join(pluginDir, 'obsolete-old.js')), false);
    assert.equal(fs.existsSync(path.join(pluginDir, 'watch.bat')), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'agy-claude-style-uninstaller.exe')), false);
    assert.equal(fs.existsSync(legacyDir), false);

    // Verify .git directory protection
    fs.mkdirSync(path.join(pluginDir, '.git'), { recursive: true });
    const gitBlocked = await applyPluginUpdate({
      installDir: pluginDir,
      stateDir: dataDir,
      downloadUrl: `${baseUrl}/agy-claude-style-v9.9.9.zip`,
      allowCustomUrlForTest: true,
    });
    assert.equal(gitBlocked.ok, false);
    assert.equal(gitBlocked.isGitRepo, true);

    // Verify manager deduplicates & tracks updated version
    const mgr = createUpdateManager({
      getCurrentVersion: () => '4.0.0',
      installDir: tmpRoot,
      stateDir: dataDir,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { tag_name: 'v4.0.0', assets: [] };
        },
      }),
    });
    const mgrRes = await mgr.check({ force: true });
    assert.equal(mgrRes.hasUpdate, false);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('hedged checkForUpdates completes fast (<2.5s) when GitHub API stalls while mirror responds', async () => {
  const started = Date.now();
  const res = await checkForUpdates({
    currentVersion: '4.0.0',
    force: true,
    timeoutMs: 3200,
    fetchFn: async (url) => {
      if (String(url).includes('api.github.com')) {
        await new Promise((r) => setTimeout(r, 6000));
        return { ok: false, status: 504 };
      }
      if (String(url).includes('cdn.jsdelivr.net')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { name: 'agy-claude-style', version: '4.5.0' };
          },
        };
      }
      return { ok: false, status: 500 };
    },
  });
  const elapsed = Date.now() - started;
  assert.equal(res.ok, true);
  assert.equal(res.latestVersion, '4.5.0');
  assert.equal(res.hasUpdate, true);
  assert.equal(res.source, 'jsdelivr-mirror');
  assert.ok(elapsed < 2600, `Expected hedged check <2.6s, took ${elapsed}ms`);
});
