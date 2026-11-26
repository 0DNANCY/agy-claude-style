import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cdp = require('../cdp.js');
const mcpHost = require('../plugin/mcp-host.js');
const lifecycle = require('../plugin/host-lifecycle.js');

test('zero-tool MCP host returns empty tools/resources/prompts and supports initialize/ping', () => {
  const init = mcpHost.handleMcpJsonRpcMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    '2.1.0'
  );
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.equal(init.result.serverInfo.name, 'agy-claude-style-host');

  assert.deepEqual(
    mcpHost.handleMcpJsonRpcMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result,
    { tools: [] }
  );
  assert.deepEqual(
    mcpHost.handleMcpJsonRpcMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' }).result,
    { resources: [] }
  );
  assert.deepEqual(
    mcpHost.handleMcpJsonRpcMessage({ jsonrpc: '2.0', id: 4, method: 'prompts/list' }).result,
    { prompts: [] }
  );
  assert.deepEqual(
    mcpHost.handleMcpJsonRpcMessage({ jsonrpc: '2.0', id: 5, method: 'ping' }).result,
    {}
  );
  const unknown = mcpHost.handleMcpJsonRpcMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call' });
  assert.equal(unknown.error.code, -32601);
});

test('resolvePluginDataDir aligns MCP PLUGIN_DATA and sidecar ANTIGRAVITY_EXECUTABLE_DATA_DIR', () => {
  const base = path.join(os.tmpdir(), 'agy-cs-test-root');
  const fromPlugin = cdp.resolvePluginDataDir({
    AGY_CLAUDE_STYLE_PLUGIN_DATA: path.join(base, 'plugin_data', 'agy-claude-style'),
  });
  const fromSidecar = cdp.resolvePluginDataDir({
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: path.join(base, 'sidecar_data', 'agy-claude-style', 'panel'),
    ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:43210',
  });
  assert.equal(fromSidecar, fromPlugin);
  assert.equal(
    cdp.resolvePluginDataDir({
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: path.join(base, 'sidecar_data', 'agy-claude-style', 'panel'),
      ANTIGRAVITY_LS_ADDRESS: 'test.invalid',
    }),
    null
  );
});

test('evaluateWatcherOwnership recognizes plugin/mcp-host.js as owned and rejects foreign scripts', () => {
  const targetDir = path.resolve(__dirname, '..');
  const mcpScript = path.join(targetDir, 'plugin', 'mcp-host.js');
  assert.equal(
    cdp.evaluateWatcherOwnership({ cmd: `node ${mcpScript}`, args: ['node', mcpScript] }, targetDir),
    'owned'
  );
  assert.equal(
    cdp.evaluateWatcherOwnership({ cmd: `node ${mcpScript}` }, targetDir),
    'owned'
  );
  assert.equal(
    cdp.evaluateWatcherOwnership({ cmd: 'node /tmp/other/plugin/mcp-host.js' }, targetDir),
    'foreign'
  );
});

test('shouldRemoveUiOnShutdown removes UI on plugin disable and preserves on host exit or active peer', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-mcp-'));
  try {
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ plugins: { 'agy-claude-style': { enabled: false } } }),
      'utf8'
    );
    assert.equal(
      await mcpHost.shouldRemoveUiOnShutdown({
        reason: 'stdin-end',
        stateDir: tmpDir,
        antigravityConfigPath: cfgPath,
        pluginName: 'agy-claude-style',
        isLeader: true,
        settleDelayMs: 0,
      }),
      true
    );

    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ plugins: { 'agy-claude-style': { enabled: true } } }),
      'utf8'
    );
    assert.equal(
      await mcpHost.shouldRemoveUiOnShutdown({
        reason: 'ls-dead',
        stateDir: tmpDir,
        antigravityConfigPath: cfgPath,
        pluginName: 'agy-claude-style',
        isLeader: true,
        settleDelayMs: 0,
      }),
      false
    );

    // Register current process as an alive peer with different excludePid
    const lease = lifecycle.registerMcpHost({ stateDir: tmpDir, pid: process.pid });
    try {
      assert.equal(
        await mcpHost.shouldRemoveUiOnShutdown({
          reason: 'stdin-end',
          stateDir: tmpDir,
          antigravityConfigPath: null,
          pluginName: 'agy-claude-style',
          isLeader: true,
          excludePid: process.pid + 99999,
          settleDelayMs: 0,
        }),
        false
      );
    } finally {
      lease.unregister();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('detectNonDesktopHost isolates agy CLI and IDE hosts so they never hijack Desktop CDP config', () => {
  assert.deepEqual(
    mcpHost.detectNonDesktopHost({
      env: {
        AGY_CLAUDE_STYLE_PLUGIN_DATA: '/Users/demo/.gemini/antigravity-cli/plugin_data/agy-claude-style',
      },
      ppid: 0,
    }),
    { nonDesktop: true, kind: 'antigravity-cli', reason: 'env-data-dir' }
  );
  assert.deepEqual(
    mcpHost.detectNonDesktopHost({
      env: {
        PLUGIN_DATA: 'C:\\Users\\demo\\.gemini\\antigravity-ide\\plugin_data\\agy-claude-style',
      },
      ppid: 0,
    }),
    { nonDesktop: true, kind: 'antigravity-ide', reason: 'env-data-dir' }
  );
  assert.deepEqual(
    mcpHost.detectNonDesktopHost({
      env: { JETSKI_APP_DATA_DIR: 'antigravity-cli' },
      ppid: 0,
    }),
    { nonDesktop: true, kind: 'antigravity-cli', reason: 'env-data-dir' }
  );
  assert.deepEqual(
    mcpHost.detectNonDesktopHost({
      env: {},
      ppid: 69319,
      inspectCmdFn: () => '/Users/demo/.local/bin/agy',
    }),
    { nonDesktop: true, kind: 'antigravity-cli', reason: 'parent-process' }
  );
  assert.deepEqual(
    mcpHost.detectNonDesktopHost({
      env: {
        AGY_CLAUDE_STYLE_PLUGIN_DATA: '/Users/demo/.gemini/antigravity/plugin_data/agy-claude-style',
      },
      ppid: 31563,
      inspectCmdFn: () => '/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone',
    }),
    { nonDesktop: false, kind: 'desktop', reason: 'default' }
  );
});

test('Aux Pane sidecar guards origins and validates config updates', async () => {
  const panel = await import('../sidecars/panel/main.mjs');
  assert.equal(panel.isLocalHostRequest({ headers: { host: '127.0.0.1:8123', origin: 'plugin://agy-claude-style--panel' } }), true);
  assert.equal(panel.isLocalHostRequest({ headers: { host: 'localhost:8123', origin: 'http://localhost:8123' } }), true);
  assert.equal(panel.isLocalHostRequest({ headers: { host: '127.0.0.1:8123', origin: 'https://evil.example' } }), false);
  assert.equal(panel.isLocalHostRequest({ headers: { host: '127.0.0.1:8123', 'sec-fetch-site': 'cross-site' } }), false);

  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../plugin.json'), 'utf8'));
  const sidecar = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../sidecars/panel/sidecar.json'), 'utf8'));
  assert.equal(manifest.name, 'agy-claude-style');
  assert.equal(sidecar.has_web_ui, true);
  assert.equal(sidecar.ui_config.views[0].entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');
});
