import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildIcns } from '../scripts/build-common.mjs';
import { buildMacosApp, generateInfoPlist } from '../scripts/build-macos.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function runBin(binPath, args, timeoutMs = 20000, extraEnv = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, {
      stdio: 'ignore',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`Timeout running ${path.basename(binPath)} ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(binPath)} exited with code ${code}`));
    });
  });
}

function collectSwiftFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSwiftFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.swift')) {
      results.push(full);
    }
  }
  return results.sort();
}

function verifySwiftDelimiters(src, fileLabel) {
  const stack = [];
  const openers = { '{': '}', '(': ')', '[': ']' };
  const closers = { '}': '{', ')': '(', ']': '[' };
  const modeStack = [{ kind: 'code', parenDepth: 0 }];
  let i = 0;
  while (i < src.length) {
    const cur = modeStack[modeStack.length - 1];
    const ch = src[i];
    const next = src[i + 1];

    if (cur.kind === 'code') {
      if (ch === '/' && next === '/') {
        i += 2;
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        let depth = 1;
        i += 2;
        while (i < src.length && depth > 0) {
          if (src[i] === '/' && src[i + 1] === '*') {
            depth++;
            i += 2;
          } else if (src[i] === '*' && src[i + 1] === '/') {
            depth--;
            i += 2;
          } else {
            i++;
          }
        }
        assert.equal(depth, 0, `${fileLabel}: unterminated block comment`);
        continue;
      }
      if (ch === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
        modeStack.push({ kind: 'mstr' });
        i += 3;
        continue;
      }
      if (ch === '"') {
        modeStack.push({ kind: 'str' });
        i += 1;
        continue;
      }
      if (openers[ch]) {
        stack.push({ ch, idx: i });
        if (ch === '(') cur.parenDepth++;
      } else if (closers[ch]) {
        const top = stack.pop();
        assert.ok(top && top.ch === closers[ch], `${fileLabel}: unmatched '${ch}' at offset ${i}`);
        if (ch === ')') {
          if (cur.parenDepth > 0) {
            cur.parenDepth--;
          } else if (modeStack.length > 1) {
            modeStack.pop();
          }
        }
      }
      i += 1;
      continue;
    }

    if (cur.kind === 'str') {
      if (ch === '\\') {
        if (next === '(') {
          stack.push({ ch: '(', idx: i + 1 });
          modeStack.push({ kind: 'code', parenDepth: 0 });
          i += 2;
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === '"') {
        modeStack.pop();
        i += 1;
        continue;
      }
      assert.notEqual(ch, '\n', `${fileLabel}: unterminated string literal before newline at offset ${i}`);
      i += 1;
      continue;
    }

    if (cur.kind === 'mstr') {
      if (ch === '\\') {
        if (next === '(') {
          stack.push({ ch: '(', idx: i + 1 });
          modeStack.push({ kind: 'code', parenDepth: 0 });
          i += 2;
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
        modeStack.pop();
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
  }
  assert.equal(modeStack.length, 1, `${fileLabel}: unterminated string literal at EOF`);
  assert.equal(stack.length, 0, `${fileLabel}: unclosed delimiters remaining: ${JSON.stringify(stack)}`);
}

test('buildIcns generates a valid Apple ICNS container with PNG icon chunks', () => {
  const icns = buildIcns();
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);

  let offset = 8;
  const types = [];
  const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  while (offset < icns.length) {
    const chunkType = icns.subarray(offset, offset + 4).toString('ascii');
    const chunkLen = icns.readUInt32BE(offset + 4);
    assert.ok(chunkLen > 16, `Chunk ${chunkType} has payload`);
    assert.deepEqual(icns.subarray(offset + 8, offset + 16), pngMagic, `Chunk ${chunkType} is valid PNG`);
    types.push(chunkType);
    offset += chunkLen;
  }
  assert.equal(offset, icns.length);
  assert.ok(types.includes('icp4'));
  assert.ok(types.includes('ic08'));
  assert.ok(types.includes('ic10'));
});

test('generateInfoPlist generates valid bundle metadata and escapes special XML characters', () => {
  const plist = generateInfoPlist('1.2.3-beta&1<test>');
  assert.ok(plist.includes('<key>CFBundleExecutable</key>'));
  assert.ok(plist.includes('<string>AGY Claude Style</string>'));
  assert.ok(plist.includes('<string>io.github.0dnancy.agy-claude-style</string>'));
  assert.ok(plist.includes('<key>NSAllowsLocalNetworking</key>'));
  assert.ok(plist.includes('<string>1.2.3-beta&amp;1&lt;test&gt;</string>'));
});

test('Setup/main.swift deploys native plugin, cleans legacy LaunchAgents/launchers, and has balanced delimiters', () => {
  const swiftFiles = collectSwiftFiles(path.join(ROOT_DIR, 'installer', 'macos'));
  assert.equal(swiftFiles.length, 2, 'Only MiniJson.swift and Setup/main.swift should exist under installer/macos');
  for (const file of swiftFiles) {
    const rel = path.relative(ROOT_DIR, file);
    const src = fs.readFileSync(file, 'utf8');
    verifySwiftDelimiters(src, rel);
  }

  const setupSwift = fs.readFileSync(path.join(ROOT_DIR, 'installer', 'macos', 'Setup', 'main.swift'), 'utf8');
  assert.ok(setupSwift.includes('AGY_CS_TEST_SYSTEM_ROOT'));
  assert.ok(setupSwift.includes('plugin_data'));
  assert.ok(setupSwift.includes('JetboxWriteState'));
  assert.ok(setupSwift.includes('DeletePlugin'));
  assert.ok(setupSwift.includes('LaunchAgents'));
  assert.ok(setupSwift.includes('Antigravity (AGY Claude Style).app'));
  assert.equal(setupSwift.includes('WebSocket'), false, 'Setup/main.swift must not contain external CDP WebSocket logic');
  assert.equal(setupSwift.includes('--launch --relaunch'), false);
});

test(
  'macOS .app builds cleanly as universal binary and executes native plugin install, legacy cleanup, upgrade, and uninstall lifecycle',
  { skip: process.platform !== 'darwin' ? 'macOS-only .app E2E test' : false },
  async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-macos-plugin-e2e-'));
    const testRoot = path.join(workDir, 'test-sys-root');
    const appPath = path.join(workDir, 'AGY Claude Style.app');
    const expectedPluginDir = path.join(testRoot, '.gemini', 'config', 'plugins', 'agy-claude-style');
    const expectedDataDir = path.join(testRoot, '.gemini', 'antigravity', 'plugin_data', 'agy-claude-style');
    const legacyDir = path.join(testRoot, 'LegacyAppSupport', 'agy-claude-style');
    const plistPath = path.join(testRoot, 'LaunchAgents', 'io.github.0dnancy.agy-claude-style.plist');
    const appLauncherPath = path.join(testRoot, 'Applications', 'Antigravity (AGY Claude Style).app');

    const outStatus = path.join(workDir, 'status.json');
    const outInstall = path.join(workDir, 'install.json');
    const outUpgrade = path.join(workDir, 'upgrade.json');
    const outUninstall = path.join(workDir, 'uninstall.json');
    const testEnv = { AGY_CS_TEST_SYSTEM_ROOT: testRoot };

    try {
      const buildRes = buildMacosApp({ appOut: appPath, createDmg: false });
      assert.ok(fs.existsSync(appPath));
      assert.ok(buildRes.appSizeBytes > 50 * 1024);

      const installerBin = path.join(appPath, 'Contents', 'MacOS', 'AGY Claude Style');
      assert.ok(fs.existsSync(installerBin));
      assert.equal(fs.existsSync(path.join(appPath, 'Contents', 'MacOS', 'agy-claude-style-watcher')), false);

      const archs = execFileSync('lipo', ['-archs', installerBin], { encoding: 'utf8' }).trim().split(/\s+/);
      assert.ok(archs.includes('arm64'));
      assert.ok(archs.includes('x86_64'));
      execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });

      // Seed legacy config + LaunchAgent + legacy launcher .app
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyDir, 'config.json'),
        JSON.stringify({ palette: 'claude', exitOnHostClose: true }, null, 2),
        'utf8'
      );
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, 'legacy-plist', 'utf8');
      fs.mkdirSync(appLauncherPath, { recursive: true });

      await runBin(installerBin, ['--status', '--out', outStatus], 10000, testEnv);
      const stBefore = JSON.parse(fs.readFileSync(outStatus, 'utf8'));
      assert.equal(stBefore.installed, false);
      assert.equal(stBefore.hasLegacyInstall, true);

      await runBin(installerBin, ['--silent', '--out', outInstall], 20000, testEnv);
      const resInstall = JSON.parse(fs.readFileSync(outInstall, 'utf8'));
      assert.equal(resInstall.ok, true);
      assert.equal(resInstall.migratedLegacyConfig, true);
      assert.equal(resInstall.legacyCleaned, true);
      assert.equal(resInstall.pluginEnabled, true);
      assert.ok(fs.existsSync(path.join(expectedPluginDir, 'plugin.json')));
      assert.ok(fs.existsSync(path.join(expectedPluginDir, 'sidecars', 'panel', 'main.mjs')));
      assert.equal(fs.existsSync(plistPath), false);
      assert.equal(fs.existsSync(appLauncherPath), false);
      assert.equal(fs.existsSync(legacyDir), false);

      await runBin(installerBin, ['--silent', '--out', outUpgrade], 20000, testEnv);
      const resUpgrade = JSON.parse(fs.readFileSync(outUpgrade, 'utf8'));
      assert.equal(resUpgrade.ok, true);
      assert.equal(resUpgrade.preservedExistingConfig, true);
      assert.equal(resUpgrade.migratedLegacyConfig, false);
      const migratedCfg = JSON.parse(fs.readFileSync(path.join(expectedDataDir, 'config.json'), 'utf8'));
      assert.equal(migratedCfg.palette, 'claude');

      await runBin(installerBin, ['--uninstall', '--silent', '--out', outUninstall], 20000, testEnv);
      const resUninstall = JSON.parse(fs.readFileSync(outUninstall, 'utf8'));
      assert.equal(resUninstall.ok, true);
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
