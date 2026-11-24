import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as telemetry from '../sidecars/panel/lib/telemetry-db.mjs';
import * as sshRemote from '../sidecars/panel/lib/ssh-remote.mjs';
import * as proxy from '../sidecars/panel/lib/proxy.mjs';

const require = createRequire(import.meta.url);
const taskProgress = require('../features/task-progress.js');

test('telemetry-db detects short-interval cache drop anomalies and exempts post-compaction calls', () => {
  const baseMs = Date.parse('2026-11-24T04:00:00Z');
  const jsonl = [
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(baseMs).toISOString(), model: 'gemini-4-neon-high', input_tokens: 20000, cache_read_tokens: 18000, output_tokens: 400 }),
    // 30s later, cache hit drops from 90% -> 10% with similar input size => anomaly!
    JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(baseMs + 30_000).toISOString(), model: 'gemini-4-neon-high', input_tokens: 21000, cache_read_tokens: 2100, output_tokens: 300 }),
    // Recover cache to 85%
    JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(baseMs + 60_000).toISOString(), model: 'gemini-4-neon-high', input_tokens: 22000, cache_read_tokens: 18700, output_tokens: 200 }),
    // Checkpoint compaction => next call drops cache but MUST NOT be flagged as anomaly
    JSON.stringify({ step_index: 4, type: 'CHECKPOINT', status: 'DONE', created_at: new Date(baseMs + 70_000).toISOString() }),
    JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(baseMs + 90_000).toISOString(), model: 'gemini-4-neon-high', input_tokens: 8000, cache_read_tokens: 500, output_tokens: 250 }),
  ].join('\n');

  const rows = telemetry.parseTranscriptJsonl(jsonl, 'convo-1', 'local');
  assert.equal(rows.length, 4);
  const anomalies = telemetry.detectCacheDropAnomalies(rows);
  assert.equal(anomalies.size, 1);
  assert.ok(anomalies.has('local:convo-1:2'));
  assert.equal(anomalies.get('local:convo-1:2').gapSec, 30);
  assert.equal(anomalies.has('local:convo-1:5'), false);

  const heat = telemetry.buildHeatmap53w(rows, baseMs + 100_000);
  assert.ok(heat.length >= 365 && heat.length <= 372);
  assert.ok(heat.some((c) => c.count === 4 && c.level === 4));
});

test('telemetry-db queryTelemetryDashboard aggregates local brain dir and filters anomalies', () => {
  const tmpBrain = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-brain-'));
  try {
    const logDir = path.join(tmpBrain, 'c-abc', '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(
      path.join(logDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(now - 60_000).toISOString(), model: 'claude-sonnet-4-5', input_tokens: 10000, cache_read_tokens: 9000, output_tokens: 500 }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(now - 20_000).toISOString(), model: 'claude-sonnet-4-5', input_tokens: 11000, cache_read_tokens: 1000, output_tokens: 500 }),
      ].join('\n'),
      'utf8'
    );
    const res = telemetry.queryTelemetryDashboard({ brainDir: tmpBrain, range: '24h', status: 'anomaly', nowMs: now });
    assert.equal(res.summary.totalRequests, 2);
    assert.equal(res.summary.anomalyCount, 1);
    assert.ok(res.summary.totalCostUsd > 0);
    assert.equal(res.requests.length, 1);
    assert.equal(res.requests[0].anomaly.kind, 'cache-drop');
  } finally {
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('ui-task-progress parses leaf checklists, classifies retry reasons, and formats friendly tool labels', () => {
  const md = '- [x] Parent\n  - [x] Done leaf\n  - [/] Active leaf\n- [ ] Pending leaf';
  const items = taskProgress.parseChecklist(md);
  assert.deepEqual(items, [
    { title: 'Done leaf', status: 'done' },
    { title: 'Active leaf', status: 'in_progress' },
    { title: 'Pending leaf', status: 'pending' },
  ]);
  assert.equal(taskProgress.classifyRetryReason('unexpected EOF reading stream').code, 'eof');
  assert.equal(taskProgress.classifyRetryReason('HTTP 429 RESOURCE_EXHAUSTED').code, 'rate-limit');
  assert.equal(taskProgress.classifyRetryReason('503 Service Unavailable').code, 'unavailable');
  assert.equal(taskProgress.friendlyToolLabel('mcp_agy-dart_fast_run_checks', true), '执行命令');
  assert.equal(taskProgress.friendlyToolLabel('read_file', false), 'Read file');
  assert.equal(taskProgress.formatClock(65000), '1:05');
  assert.equal(taskProgress.formatStepDur(1500), '1.5s');
});

test('telemetry-db returns todaySummary and supports exact YYYY-MM-DD date filtering', () => {
  const tmpBrain = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-day-'));
  try {
    const logDir = path.join(tmpBrain, 'c-day', '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const now = Date.now();
    const yesterday = now - 86400000;
    const fmt = (ms) => {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    fs.writeFileSync(
      path.join(logDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date(yesterday - 1000).toISOString(), content: '<USER_REQUEST>\n检查响应时间与会话标题\n</USER_REQUEST>' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(yesterday).toISOString(), model: 'claude-sonnet-4-5', input_tokens: 5000, cache_read_tokens: 4000, output_tokens: 200 }),
        JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', created_at: new Date(yesterday + 3200).toISOString(), content: 'tool result' }),
        JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(now).toISOString(), model: 'claude-sonnet-4-5', input_tokens: 8000, cache_read_tokens: 7200, output_tokens: 300, duration_ms: 1800 }),
      ].join('\n'),
      'utf8'
    );
    const todayKey = fmt(now);
    const yestKey = fmt(yesterday);
    const resToday = telemetry.queryTelemetryDashboard({ brainDir: tmpBrain, range: '7d', date: todayKey, nowMs: now });
    assert.equal(resToday.todaySummary.date, todayKey);
    assert.equal(resToday.todaySummary.count, 1);
    assert.equal(resToday.todaySummary.isToday, true);
    assert.equal(resToday.requests.length, 1);
    assert.equal(resToday.requests[0].stepIndex, 3);
    assert.equal(resToday.requests[0].responseMs, 1800);
    assert.equal(resToday.requests[0].conversationTitle, '检查响应时间与会话标题');
    assert.equal(resToday.pagination.totalFiltered, 1);
    assert.equal(resToday.pagination.hasMore, false);

    const resYest = telemetry.queryTelemetryDashboard({ brainDir: tmpBrain, range: '7d', date: yestKey, nowMs: now });
    assert.equal(resYest.requests.length, 1);
    assert.equal(resYest.requests[0].stepIndex, 1);
    assert.equal(resYest.requests[0].responseMs, 3200);
    assert.equal(resYest.summary.avgResponseMs, 3200);
  } finally {
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('cdp.relaunchAntigravityWithCdp detached mode schedules independent helper with loopback address', async () => {
  const cdp = require('../cdp.js');
  let spawned = null;
  const res = await cdp.relaunchAntigravityWithCdp({
    detached: true,
    appPath: process.execPath,
    extraArgs: ['--proxy-server=http://127.0.0.1:7897'],
    extraEnv: { GODEBUG: 'http2client=0' },
    detectProcess: () => ({ running: true, pids: [12345] }),
    spawn: (cmd, args, opts) => {
      spawned = { cmd, args, opts };
      return { unref() {} };
    },
  });
  assert.equal(res.relaunched, true);
  assert.equal(res.scheduled, true);
  assert.equal(res.reason, 'detached');
  assert.equal(spawned.opts.detached, true);
  const spec = JSON.parse(spawned.opts.env.AGY_RELAUNCH_SPEC);
  assert.deepEqual(spec.pids, [12345]);
  assert.ok(spec.launchArgs.includes('--remote-debugging-port=0'));
  assert.ok(spec.launchArgs.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(spec.launchArgs.includes('--proxy-server=http://127.0.0.1:7897'));
  assert.equal(spec.extraEnv.GODEBUG, 'http2client=0');
  if (process.platform === 'darwin' && fs.existsSync('/Applications/Antigravity.app/Contents/MacOS/Antigravity')) {
    const prevRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const prevSidecar = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '55555';
    try {
      let macSpawned = null;
      cdp.launchAntigravityWithCdp({
        appPath: '/Applications/Antigravity.app',
        extraArgs: ['--proxy-server=http://127.0.0.1:7897'],
        extraEnv: { HTTPS_PROXY: 'http://127.0.0.1:7897' },
        detectProcess: () => ({ running: true, pids: [] }),
        spawn: (cmd, args, opts) => {
          macSpawned = { cmd, args, opts };
          return { unref() {} };
        },
      });
      assert.equal(macSpawned.cmd, '/Applications/Antigravity.app/Contents/MacOS/Antigravity');
      assert.equal(macSpawned.opts.env.HTTPS_PROXY, 'http://127.0.0.1:7897');
      assert.equal(macSpawned.opts.env.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(macSpawned.opts.env.ANTIGRAVITY_SIDECAR_WEB_PORT, undefined);
    } finally {
      if (prevRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = prevRunAsNode;
      if (prevSidecar === undefined) delete process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
      else process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = prevSidecar;
    }
  }
  // Verify sanitizeAppLaunchEnv strips Electron/sidecar vars while keeping proxy vars
  const cleanEnv = cdp.sanitizeAppLaunchEnv(
    { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', ANTIGRAVITY_SIDECAR_UI_TOKEN: 'sec', PLUGIN_DATA: '/tmp' },
    { HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897' }
  );
  assert.equal(cleanEnv.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(cleanEnv.NODE_OPTIONS, undefined);
  assert.equal(cleanEnv.ANTIGRAVITY_SIDECAR_UI_TOKEN, undefined);
  assert.equal(cleanEnv.PLUGIN_DATA, undefined);
  assert.equal(cleanEnv.HTTPS_PROXY, 'http://127.0.0.1:7897');
});

test('ssh-remote validates hostnames and parses ~/.ssh/config safely', () => {
  assert.equal(sshRemote.validateSshHost('dev-box'), 'dev-box');
  assert.throws(() => sshRemote.validateSshHost('-oProxyCommand=bad'));
  assert.throws(() => sshRemote.validateSshHost('host;rm -rf /'));

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-ssh-'));
  try {
    fs.mkdirSync(path.join(tmpHome, '.ssh'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.ssh', 'config'),
      'Host *\n  ServerAliveInterval 60\nHost prod-a prod-b\n  HostName 10.0.0.1\n',
      'utf8'
    );
    assert.deepEqual(sshRemote.listConfiguredSshHosts(tmpHome), ['prod-a', 'prod-b']);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('proxy validates URLs, preserves loopback bypass, builds launch args, and tests local TCP connectivity', async () => {
  assert.equal(proxy.normalizeProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(proxy.normalizeProxyUrl('socks5://user:pass@127.0.0.1:7891'), 'socks5://user:pass@127.0.0.1:7891');
  assert.equal(proxy.maskProxyUrl('socks5://user:pass@127.0.0.1:7891'), 'socks5://***@127.0.0.1:7891');
  assert.equal(proxy.normalizeProxyUrl('ftp://bad:21'), null);
  assert.equal(proxy.normalizeProxyUrl('http://127.0.0.1:7890;evil'), null);

  const bypass = proxy.normalizeBypassList('*.internal.corp');
  assert.ok(bypass.includes('localhost') && bypass.includes('127.0.0.1') && bypass.includes('::1') && bypass.includes('*.internal.corp'));

  const offOpts = proxy.buildProxyLaunchOptions({ proxyEnabled: false, proxyUrl: 'http://127.0.0.1:7890' });
  assert.deepEqual(offOpts, { args: [], env: {} });

  const onOpts = proxy.buildProxyLaunchOptions({ proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7890', proxyForceHttp1: true });
  assert.ok(onOpts.args.includes('--proxy-server=http://127.0.0.1:7890'));
  assert.equal(onOpts.env.GODEBUG, 'http2client=0');

  const srv = net.createServer((s) => s.end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const okRes = await proxy.testProxyConnectivity(`http://127.0.0.1:${port}`, { timeoutMs: 2000 });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.port, port);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
