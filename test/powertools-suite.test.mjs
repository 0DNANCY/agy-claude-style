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
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(baseMs).toISOString(), model: 'gemini-4-neon-high', input_tokens: 2000, cache_read_tokens: 18000, output_tokens: 400 }),
    // 30s later, cache hit drops from 90% -> 10% with similar input size => anomaly!
    JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(baseMs + 30_000).toISOString(), model: 'gemini-4-neon-high', input_tokens: 18900, cache_read_tokens: 2100, output_tokens: 300 }),
    // Recover cache to 85%
    JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(baseMs + 60_000).toISOString(), model: 'gemini-4-neon-high', input_tokens: 3300, cache_read_tokens: 18700, output_tokens: 200 }),
    // Checkpoint compaction => next call drops cache but MUST NOT be flagged as anomaly
    JSON.stringify({ step_index: 4, type: 'CHECKPOINT', status: 'DONE', created_at: new Date(baseMs + 70_000).toISOString() }),
    JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(baseMs + 90_000).toISOString(), model: 'gemini-4-neon-high', input_tokens: 7500, cache_read_tokens: 500, output_tokens: 250 }),
  ].join('\n');

  const rows = telemetry.parseTranscriptJsonl(jsonl, 'convo-1', 'local');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].inputTokens, 20000);
  assert.equal(Number(rows[0].cacheHitPct.toFixed(1)), 90);
  assert.equal(Number(rows[1].cacheHitPct.toFixed(1)), 10);
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
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(now - 60_000).toISOString(), model: 'claude-sonnet-4-5', input_tokens: 1000, cache_read_tokens: 9000, output_tokens: 500 }),
        JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(now - 20_000).toISOString(), model: 'claude-sonnet-4-5', input_tokens: 10000, cache_read_tokens: 1000, output_tokens: 500 }),
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

test('telemetry-db prefers real conversation titles from conversation_summaries.db and formats subagent titles', () => {
  const { DatabaseSync } = require('node:sqlite');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-titles-'));
  const tmpBrain = path.join(tmpRoot, 'brain');
  const summaryDbPath = path.join(tmpRoot, 'conversation_summaries.db');
  try {
    const db = new DatabaseSync(summaryDbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL DEFAULT '',
        parent_conversation_id TEXT NOT NULL DEFAULT ''
      );
    `);
    const ins = db.prepare(
      'INSERT INTO conversation_summaries (conversation_id, title, agent_name, parent_conversation_id) VALUES (?, ?, ?, ?)'
    );
    ins.run('c-main', 'Edgmr Robot Registry Installation', '', '');
    ins.run('c-sub', '', 'coder', 'c-main');
    db.close();

    const now = Date.now();
    const writeTranscript = (cid, firstUserText) => {
      const logDir = path.join(tmpBrain, cid, '.system_generated', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, 'transcript.jsonl'),
        [
          JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: `<USER_REQUEST>${firstUserText}</USER_REQUEST>` }),
          JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(now - 5_000).toISOString(), model: 'gemini-4-neon', input_tokens: 1000, cache_read_tokens: 800, output_tokens: 200 }),
        ].join('\n'),
        'utf8'
      );
    };
    writeTranscript('c-main', 'https://jihulab.com/ED/embodyde/raw-url');
    writeTranscript('c-sub', 'raw internal subagent prompt');
    writeTranscript('c-fallback', 'Fallback first prompt text');

    const res = telemetry.queryTelemetryDashboard({ brainDir: tmpBrain, range: '24h', nowMs: now });
    const byCid = new Map(res.requests.map((r) => [r.conversationId, r.conversationTitle]));
    assert.equal(byCid.get('c-main'), 'Edgmr Robot Registry Installation');
    assert.equal(byCid.get('c-sub'), 'Edgmr Robot Registry Installation · @coder');
    assert.equal(byCid.get('c-fallback'), 'Fallback first prompt text');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
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
  assert.equal(taskProgress.formatClock(65000), '1m 5s');
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

test('extensions-dock: discovery, sorting, scope/viewId helpers, and runtime registration', () => {
  const extDock = require('../features/extensions-dock.js');
  const cdp = require('../cdp.js');

  assert.equal(cdp.DEFAULT_CONFIG.headerExtensionsBar, true);
  assert.equal(cdp.DEFAULT_CONFIG.sidebarExtensionsSection, true);
  assert.deepEqual(cdp.DEFAULT_CONFIG.pinnedHeaderExtensions, []);
  assert.deepEqual(cdp.DEFAULT_CONFIG.pinnedSidebarExtensions, []);
  assert.equal(cdp.DEFAULT_CONFIG.sidebarExtensionsExpanded, false);
  assert.ok(cdp.RUNTIME_PARTS.includes('features/extensions-dock.js'));
  assert.equal(typeof cdp.readInstalledSidecarLogos, 'function');

  // Verify readInstalledSidecarLogos encodes local plugin logos safely as data URIs
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-logo-test-'));
  try {
    const pDir = path.join(tmpRoot, 'demo-plug');
    fs.mkdirSync(path.join(pDir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(pDir, 'sidecars', 'panel'), { recursive: true });
    fs.writeFileSync(path.join(pDir, 'plugin.json'), JSON.stringify({ name: 'demo-plug', logo: 'assets/logo.svg' }));
    fs.writeFileSync(path.join(pDir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    fs.writeFileSync(path.join(pDir, 'sidecars', 'panel', 'sidecar.json'), '{}');
    const logos = cdp.readInstalledSidecarLogos({ roots: [tmpRoot] });
    assert.ok(logos['demo-plug/panel']?.startsWith('data:image/svg+xml;base64,'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  assert.deepEqual(extDock.togglePinnedId([], 'agy-claude-style/panel'), ['agy-claude-style/panel']);
  assert.deepEqual(extDock.togglePinnedId(['agy-claude-style/panel'], 'agy-claude-style/panel'), []);
  assert.equal(cdp.validateConfigSetting('pinnedHeaderExtensions', ['agy-claude-style/panel']), true);
  assert.equal(cdp.validateConfigSetting('pinnedSidebarExtensions', ['agy-capsule/agy_capsule']), true);
  assert.equal(cdp.validateConfigSetting('sidebarExtensionsExpanded', true), true);
  assert.equal(cdp.validateConfigSetting('pinnedHeaderExtensions', 'not-an-array'), false);

  const fakeDoc = {
    querySelectorAll() {
      return [
        {
          getAttribute: (k) =>
            k === 'data-sidecar-id'
              ? 'swarm/swarm_board'
              : 'plugin://swarm--swarm_board-58214/?token=abc&conversationId=111',
          querySelector: () => ({ getAttribute: () => 'Swarm' }),
        },
        {
          getAttribute: (k) =>
            k === 'data-sidecar-id'
              ? 'agy-claude-style/panel'
              : 'plugin://agy-claude-style--panel-62632/?token=xyz&conversationId=111',
          querySelector: () => ({ getAttribute: () => 'Claude Style' }),
        },
        {
          getAttribute: (k) =>
            k === 'data-sidecar-id'
              ? 'agy-claude-style/panel'
              : 'plugin://agy-claude-style--panel-62632/?token=xyz&conversationId=222',
          querySelector: () => ({ getAttribute: () => 'Claude Style' }),
        },
      ];
    },
  };

  const list = extDock.discoverExtensionsFromDom(fakeDoc);
  assert.equal(list.length, 2);
  assert.equal(list[0].sidecarId, 'agy-claude-style/panel');
  assert.equal(list[0].title, 'Claude Style');
  assert.ok(!list[0].url.includes('conversationId='));
  assert.equal(list[1].sidecarId, 'swarm/swarm_board');

  assert.equal(extDock.buildViewId(list[0]), 'sidecar/agy-claude-style/panel:/');
  assert.equal(extDock.buildAuxTabId(list[0]), 'sidecar__agy-claude-style/panel__/');
  assert.deepEqual(extDock.parsePanelScopeFromUrl('/c/abc-123', '?project=p1'), { kind: 'cascadeId', cascadeId: 'abc-123' });
  assert.deepEqual(extDock.parsePanelScopeFromUrl('/', '?project=p1'), { kind: 'newConversation', projectId: 'p1' });
  assert.deepEqual(extDock.parseActiveMainViewSidecar('/view/sidecar%2Fagy-claude-style%2Fpanel%3A%2F'), {
    sidecarId: 'agy-claude-style/panel',
    path: '/',
  });
});

test('task-progress: summarizeSteps computes cumulative and live model wait time', () => {
  const t0 = 1_700_000_000_000;
  const tail = [
    {
      step: { case: 'plannerResponse', value: { thinking: 'plan' } },
      metadata: { createdAt: new Date(t0).toISOString(), completedAt: new Date(t0 + 2500).toISOString() },
      status: 3,
    },
    {
      step: { case: 'readFile', value: { path: 'a.js' } },
      metadata: { toolCall: { name: 'read_file' }, startedAt: new Date(t0 + 2600).toISOString(), completedAt: new Date(t0 + 2900).toISOString() },
      status: 3,
    },
    {
      step: { case: 'plannerResponse', value: { thinking: 'next' } },
      metadata: { createdAt: new Date(t0 + 3000).toISOString(), completedAt: new Date(t0 + 6200).toISOString() },
      status: 3,
    },
  ];
  const doneSum = taskProgress.summarizeSteps(tail, 0, 'complete', true);
  assert.equal(doneSum.modelWaitCount, 2);
  assert.equal(doneSum.modelWaitLastMs, 3200);
  assert.equal(doneSum.modelWaitTotalMs, 5700);
  assert.equal(doneSum.modelWaitSinceMs, null);

  const liveSum = taskProgress.summarizeSteps(
    [
      ...tail.slice(0, 2),
      { step: { case: 'plannerResponse', value: { thinking: 'live' } }, metadata: { createdAt: new Date(t0 + 3000).toISOString() }, status: 2 },
    ],
    0,
    'running',
    true
  );
  assert.equal(liveSum.modelWaitCount, 2);
  assert.equal(liveSum.modelWaitTotalMs, 2500);
  assert.equal(liveSum.modelWaitSinceMs, t0 + 3000);

  // Regression: Antigravity sets plannerResponse.metadata.startedAt === completedAt (finish time) while createdAt is request start.
  const sameStartEndSum = taskProgress.summarizeSteps(
    [
      {
        step: { case: 'plannerResponse', value: { thinking: 'real wait' } },
        metadata: {
          createdAt: new Date(t0).toISOString(),
          startedAt: new Date(t0 + 18502).toISOString(),
          completedAt: new Date(t0 + 18502).toISOString(),
        },
        status: 3,
      },
    ],
    0,
    'complete',
    true
  );
  assert.equal(sameStartEndSum.modelWaitLastMs, 18502);
  assert.equal(sameStartEndSum.modelWaitTotalMs, 18502);

  assert.equal(taskProgress.formatClock(0), '0s');
  assert.equal(taskProgress.formatClock(420), '0.4s');
  assert.equal(taskProgress.formatClock(14800), '14s');
  assert.equal(taskProgress.formatClock(75000), '1m 15s');
  assert.equal(taskProgress.formatClock(3720000), '1h 2m');

  // Regression: floating card can be dragged anywhere inside full viewport bounds (never locked to chat pane)
  const freeLeft = taskProgress.clampFloatPos(40, 20, null, { minX: 8, maxX: 1108, minY: 8, maxY: 700 });
  assert.deepEqual(freeLeft, { x: 40, y: 20 });
  const clampedEdge = taskProgress.clampFloatPos(-50, 9999, null, { minX: 8, maxX: 1108, minY: 8, maxY: 700 });
  assert.deepEqual(clampedEdge, { x: 8, y: 700 });
});

test('hide-on-close: never hijacks Cmd+W/Ctrl+W tab shortcuts, allows Quit/Reload, and intercepts beforeunload', () => {
  const hideOnClose = require('../features/hide-on-close.js');
  const cdp = require('../cdp.js');

  assert.equal(cdp.DEFAULT_CONFIG.hideOnClose, true);
  assert.ok(cdp.RUNTIME_PARTS.includes('features/hide-on-close.js'));
  assert.equal(typeof cdp.hideAntigravityWindow, 'function');

  // Cmd+W / Ctrl+W must pass through natively so extension/editor tabs close normally
  assert.equal(hideOnClose.classifyShortcut({ metaKey: true, key: 'w' }, true), 'none');
  assert.equal(hideOnClose.classifyShortcut({ metaKey: true, shiftKey: true, key: 'w' }, true), 'none');
  assert.equal(hideOnClose.classifyShortcut({ ctrlKey: true, key: 'w' }, false), 'none');
  assert.equal(hideOnClose.classifyShortcut({ ctrlKey: true, shiftKey: true, key: 'w' }, false), 'none');
  assert.equal(hideOnClose.classifyShortcut({ metaKey: true, key: 'q' }, true), 'allow-unload');
  assert.equal(hideOnClose.classifyShortcut({ metaKey: true, key: 'r' }, true), 'allow-unload');
  assert.equal(hideOnClose.classifyShortcut({ altKey: true, key: 'F4' }, false), 'allow-unload');

  assert.equal(hideOnClose.shouldInterceptBeforeUnload({ enabled: true, nowMs: 5000, allowRealUnloadUntil: 0, isHidden: false }), true);
  assert.equal(hideOnClose.shouldInterceptBeforeUnload({ enabled: false, nowMs: 5000, allowRealUnloadUntil: 0, isHidden: false }), false);
  assert.equal(hideOnClose.shouldInterceptBeforeUnload({ enabled: true, nowMs: 5000, allowRealUnloadUntil: 7000, isHidden: false }), false);
  assert.equal(hideOnClose.shouldInterceptBeforeUnload({ enabled: true, nowMs: 5000, allowRealUnloadUntil: 0, isHidden: true }), false);
});

test('cdp: persistent auto-relaunch guard enforces same-PID dedup, 120s cooldown, 2-fail breaker, proxy args, and legacy launcher cleanup', () => {
  const cdp = require('../cdp.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cs-guard-'));
  const guardPath = path.join(tmpDir, 'relaunch-guard.json');
  try {
    // 1. Fresh guard allows relaunch
    const g0 = cdp.readRelaunchGuard(guardPath);
    assert.deepEqual(cdp.evaluateAutoRelaunchGuard(g0, { pidSig: '101', nowMs: 1_000_000 }).allowed, true);

    // 2. First attempt -> blocks same-PID and 120s cooldown on new PID
    const g1 = cdp.recordAutoRelaunchAttempt({ pidSig: '101', nowMs: 1_000_000 }, guardPath);
    assert.equal(g1.consecutiveFailures, 1);
    assert.equal(g1.tripped, false);
    assert.equal(cdp.evaluateAutoRelaunchGuard(g1, { pidSig: '101', nowMs: 1_200_000 }).reason, 'same-pid');
    assert.equal(cdp.evaluateAutoRelaunchGuard(g1, { pidSig: '202', nowMs: 1_060_000 }).reason, 'cooldown');
    assert.equal(cdp.evaluateAutoRelaunchGuard(g1, { pidSig: '202', nowMs: 1_125_000 }).allowed, true);

    // 3. Second consecutive failure -> trips circuit breaker permanently until reset
    const g2 = cdp.recordAutoRelaunchAttempt({ pidSig: '202', nowMs: 1_125_000 }, guardPath);
    assert.equal(g2.consecutiveFailures, 2);
    assert.equal(g2.tripped, true);
    assert.equal(cdp.evaluateAutoRelaunchGuard(g2, { pidSig: '303', nowMs: 9_999_999 }).reason, 'circuit-breaker');

    // 4. Reset on CDP connect / manual relaunch restores clean state
    const gReset = cdp.resetRelaunchGuard({ markSuccess: true, nowMs: 1_200_000 }, guardPath);
    assert.equal(gReset.tripped, false);
    assert.equal(gReset.consecutiveFailures, 0);
    assert.equal(cdp.evaluateAutoRelaunchGuard(gReset, { pidSig: '303', nowMs: 1_200_001 }).allowed, true);

    // 5. Proxy launch options builder matches proxy config
    const pOff = cdp.buildProxyLaunchOptionsFromConfig({ proxyEnabled: false, proxyUrl: 'http://127.0.0.1:7897' });
    assert.deepEqual(pOff.args, []);
    const pOn = cdp.buildProxyLaunchOptionsFromConfig({
      proxyEnabled: true,
      proxyUrl: 'http://127.0.0.1:7897',
      proxyBypass: 'localhost,127.0.0.1,::1',
      proxyForceHttp1: true,
    });
    assert.ok(pOn.args.includes('--proxy-server=http://127.0.0.1:7897'));
    assert.equal(pOn.env.GODEBUG, 'http2client=0');

    // 6. Legacy macOS dual .app launcher cleanup
    const fakeHome = path.join(tmpDir, 'home');
    const legacyApp = path.join(fakeHome, 'Applications', 'Antigravity (AGY Claude Style).app');
    fs.mkdirSync(legacyApp, { recursive: true });
    assert.equal(cdp.cleanupLegacyMacLauncher({ homeDir: fakeHome, platform: 'win32' }).removed, false);
    assert.equal(cdp.cleanupLegacyMacLauncher({ homeDir: fakeHome, platform: 'darwin' }).removed, true);
    assert.equal(fs.existsSync(legacyApp), false);

    // 7. Detached relaunch uses /usr/bin/open (no /usr/bin/osascript invocation)
    assert.equal(/\/osascript\b|['"]osascript['"]/.test(cdp.scheduleDetachedRelaunch.toString()), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('branch-edit: builds Antigravity forkConversation payload with sourceCascadeId, forkAtStepIndex, and targetForkWorkspace', () => {
  const branchEdit = require('../features/branch-edit.js');
  assert.deepEqual(branchEdit.buildForkPayload('cid-123', 42, 1), {
    sourceCascadeId: 'cid-123',
    targetForkWorkspace: 1,
    forkAtStepIndex: 42,
  });
  assert.deepEqual(branchEdit.buildForkPayload('cid-123', -1), {
    sourceCascadeId: 'cid-123',
    targetForkWorkspace: 1,
  });
  assert.equal(
    branchEdit.isSubagentForkUnsupportedError(new Error('forking is not supported for conversations that have invoked subagents')),
    true
  );
  assert.equal(branchEdit.isSubagentForkUnsupportedError(new Error('network timeout')), false);
});

test('quota-tracker: tracks local-only weekly burn, ignores other-host/cross-day drops, handles 100% reset, and isolates accounts', async () => {
  const qt = await import('../sidecars/panel/lib/quota-tracker.mjs');
  const rawQuota = {
    groups: [
      {
        displayName: 'Gemini Pro',
        buckets: [
          { window: '5h', remainingFraction: 0.9, resetTime: '2026-11-24T15:00:00Z' },
          { window: 'weekly', remainingFraction: 0.8, resetTime: '2026-11-28T00:00:00Z' },
        ],
      },
      {
        displayName: 'Claude',
        buckets: [
          { window: 'weekly', remaining: { case: 'remainingFraction', value: 0.65 }, resetTime: '2026-11-28T00:00:00Z' },
        ],
      },
    ],
  };

  const pools1 = qt.extractWeeklyPools(rawQuota);
  assert.equal(pools1.length, 2);
  assert.equal(pools1[0].name, 'Gemini Pro');
  assert.equal(pools1[0].remainingPct, 80);
  assert.equal(pools1[1].name, 'Claude');
  assert.equal(pools1[1].remainingPct, 65);

  const acctA = { accountKey: 'acct_alpha', accountLabel: 'al***@gmail.com' };
  const acctB = { accountKey: 'acct_beta', accountLabel: 'be***@gmail.com' };

  const day1Night = new Date(2026, 10, 23, 22, 0, 0).getTime();
  let store = qt.createEmptyStore();
  ({ store } = qt.recordQuotaSample(store, pools1, day1Night, acctA));

  // Next morning: overnight drop 80 -> 74 (e.g. burned on another host) must NOT carry over into today
  const day2Morning = new Date(2026, 10, 24, 9, 0, 0).getTime();
  const pools2 = [
    { name: 'Gemini Pro', remainingPct: 74, resetSec: pools1[0].resetSec },
    { name: 'Claude', remainingPct: 65, resetSec: pools1[1].resetSec },
  ];
  ({ store } = qt.recordQuotaSample(store, pools2, day2Morning, acctA));
  let sum = qt.summarizeWeeklyQuota(store, pools2, day2Morning, acctA);
  assert.equal(sum.pools.find((p) => p.name === 'Gemini Pro').consumedTodayPct, 0);
  assert.equal(sum.pools.find((p) => p.name === 'Gemini Pro').carriedFromPrior, false);

  // Active local usage on this machine: Gemini 74 -> 69 (5%), Claude 65 -> 60.5 (4.5%)
  const day2Noon = new Date(2026, 10, 24, 12, 0, 0).getTime();
  const pools3 = [
    { name: 'Gemini Pro', remainingPct: 69, resetSec: pools1[0].resetSec },
    { name: 'Claude', remainingPct: 60.5, resetSec: pools1[1].resetSec },
  ];
  ({ store } = qt.recordQuotaSample(store, pools3, day2Noon, { ...acctA, hasLocalActivity: true }));
  sum = qt.summarizeWeeklyQuota(store, pools3, day2Noon, acctA);
  assert.equal(sum.pools.find((p) => p.name === 'Gemini Pro').consumedTodayPct, 5);
  assert.equal(sum.pools.find((p) => p.name === 'Claude').consumedTodayPct, 4.5);

  // Reservation dip + cache-hit refund bounce within same cycle must NOT double-count consumption:
  // Gemini 69 -> 66.2 -> 68.5 -> 65.0 must add exact net drop (69 -> 65.0 = 4% -> 9% total)
  const day2Bounce1 = new Date(2026, 10, 24, 13, 0, 0).getTime();
  ({ store } = qt.recordQuotaSample(
    store,
    [
      { name: 'Gemini Pro', remainingPct: 66.2, resetSec: pools1[0].resetSec },
      { name: 'Claude', remainingPct: 60.5, resetSec: pools1[1].resetSec },
    ],
    day2Bounce1,
    { ...acctA, hasLocalActivity: true }
  ));
  ({ store } = qt.recordQuotaSample(
    store,
    [
      { name: 'Gemini Pro', remainingPct: 68.5, resetSec: pools1[0].resetSec },
      { name: 'Claude', remainingPct: 60.5, resetSec: pools1[1].resetSec },
    ],
    day2Bounce1 + 60_000,
    { ...acctA, hasLocalActivity: true }
  ));
  ({ store } = qt.recordQuotaSample(
    store,
    [
      { name: 'Gemini Pro', remainingPct: 65.0, resetSec: pools1[0].resetSec },
      { name: 'Claude', remainingPct: 60.5, resetSec: pools1[1].resetSec },
    ],
    day2Bounce1 + 120_000,
    { ...acctA, hasLocalActivity: true }
  ));
  sum = qt.summarizeWeeklyQuota(store, pools3, day2Bounce1 + 120_000, acctA);
  assert.equal(sum.pools.find((p) => p.name === 'Gemini Pro').consumedTodayPct, 9);

  // Another host burns 65 -> 45 while this machine had NO local activity -> re-baseline only, consumed stays 9%
  const day2Afternoon = new Date(2026, 10, 24, 15, 0, 0).getTime();
  ({ store } = qt.recordQuotaSample(
    store,
    [
      { name: 'Gemini Pro', remainingPct: 45.0, resetSec: pools1[0].resetSec },
      { name: 'Claude', remainingPct: 60.5, resetSec: pools1[1].resetSec },
    ],
    day2Afternoon,
    { ...acctA, hasLocalActivity: false }
  ));
  sum = qt.summarizeWeeklyQuota(
    store,
    [
      { name: 'Gemini Pro', remainingPct: 45.0, resetSec: pools1[0].resetSec },
      { name: 'Claude', remainingPct: 60.5, resetSec: pools1[1].resetSec },
    ],
    day2Afternoon,
    acctA
  );
  assert.equal(sum.pools.find((p) => p.name === 'Gemini Pro').consumedTodayPct, 9);

  // Mid-day AGY reset back to 100% preserves today's 9% local burn, and subsequent local burn continues from 100%
  const day2Reset = new Date(2026, 10, 24, 18, 0, 0).getTime();
  const nextResetSec = pools1[0].resetSec + 7 * 86400;
  ({ store } = qt.recordQuotaSample(
    store,
    [
      { name: 'Gemini Pro', remainingPct: 100, resetSec: nextResetSec },
      { name: 'Claude', remainingPct: 60.5, resetSec: pools1[1].resetSec },
    ],
    day2Reset,
    { ...acctA, hasLocalActivity: false }
  ));
  ({ store } = qt.recordQuotaSample(
    store,
    [
      { name: 'Gemini Pro', remainingPct: 96, resetSec: nextResetSec },
      { name: 'Claude', remainingPct: 60.5, resetSec: pools1[1].resetSec },
    ],
    day2Reset + 60_000,
    { ...acctA, hasLocalActivity: true }
  ));
  sum = qt.summarizeWeeklyQuota(
    store,
    [
      { name: 'Gemini Pro', remainingPct: 96, resetSec: nextResetSec },
      { name: 'Claude', remainingPct: 60.5, resetSec: pools1[1].resetSec },
    ],
    day2Reset + 60_000,
    acctA
  );
  assert.equal(sum.pools.find((p) => p.name === 'Gemini Pro').consumedTodayPct, 13);
  assert.equal(sum.pools.find((p) => p.name === 'Gemini Pro').remainingPct, 96);
  assert.equal(sum.byDate['2026-11-24'].maxConsumedPct, 13);

  // Switching to Account B isolates its quota and never triggers fake reset or corrupts Account A
  ({ store } = qt.recordQuotaSample(
    store,
    [
      { name: 'Gemini Pro', remainingPct: 100, resetSec: pools1[0].resetSec + 3 * 86400 },
      { name: 'Claude', remainingPct: 100, resetSec: pools1[1].resetSec + 3 * 86400 },
    ],
    day2Reset + 120_000,
    { ...acctB, hasLocalActivity: false }
  ));
  const sumB = qt.summarizeWeeklyQuota(
    store,
    [{ name: 'Gemini Pro', remainingPct: 100, resetSec: pools1[0].resetSec + 3 * 86400 }],
    day2Reset + 120_000,
    acctB
  );
  assert.equal(sumB.pools.find((p) => p.name === 'Gemini Pro').consumedTodayPct, 0);
  const sumAAfter = qt.summarizeWeeklyQuota(store, [], day2Reset + 120_000, acctA);
  assert.equal(sumAAfter.pools.find((p) => p.name === 'Gemini Pro').consumedTodayPct, 13);

  // Fallback guard when accountKey is unknown ('default') and resetSec regresses across accounts
  let fallbackStore = qt.createEmptyStore();
  ({ store: fallbackStore } = qt.recordQuotaSample(fallbackStore, [{ name: 'Gemini Pro', remainingPct: 70, resetSec: 2_000_000_000 }], day2Reset));
  ({ store: fallbackStore } = qt.recordQuotaSample(
    fallbackStore,
    [{ name: 'Gemini Pro', remainingPct: 30, resetSec: 1_999_000_000 }],
    day2Reset + 60_000,
    { hasLocalActivity: true }
  ));
  const sumFallback = qt.summarizeWeeklyQuota(fallbackStore, [{ name: 'Gemini Pro', remainingPct: 30, resetSec: 1_999_000_000 }], day2Reset + 60_000);
  assert.equal(sumFallback.pools[0].consumedTodayPct, 0);

  // createQuotaTracker integration: startup session re-baselines, idle polls ignore remote host drops, active polls credit
  const tmpQuotaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cs-qt-'));
  try {
    const quotaFile = path.join(tmpQuotaDir, 'quota-daily.json');
    let liveRem = 80;
    let liveActivityMs = 0;
    const tracker = qt.createQuotaTracker({
      filePath: quotaFile,
      minIntervalMs: 0,
      getLocalActivityMsFn: () => liveActivityMs,
      fetchAccountFn: async () => qt.extractAccountInfo({ userStatus: { email: 'alice@example.com' } }),
      fetchQuotaFn: async () => ({
        groups: [{ displayName: 'Gemini Pro', buckets: [{ window: 'weekly', remainingFraction: liveRem / 100, resetTime: '2026-12-01T00:00:00Z' }] }],
      }),
    });
    const s1 = await tracker.sampleNow({ force: true });
    assert.equal(s1.pools[0].consumedTodayPct, 0);
    assert.equal(s1.accountLabel, 'al***@example.com');

    // Remote host burns 80 -> 60 while local machine has no recent activity
    liveRem = 60;
    const s2 = await tracker.sampleNow({ force: true });
    assert.equal(s2.pools[0].consumedTodayPct, 0);
    assert.equal(s2.pools[0].remainingPct, 60);

    // Local machine runs a turn (activity timestamp updates) and burns 60 -> 54
    liveActivityMs = Date.now() + 1000;
    liveRem = 54;
    const s3 = await tracker.sampleNow({ force: true });
    assert.equal(s3.pools[0].consumedTodayPct, 6);
  } finally {
    fs.rmSync(tmpQuotaDir, { recursive: true, force: true });
  }
});

test('telemetry-db extracts ground-truth TTFT (field 11) from gen_metadata protobuf and computes avgTtftMs', () => {
  // Encode Duration { seconds=4, nanos=250_000_000 } (4250ms) inside m1 field 11, with stepIndices [7, 8] in top field 2
  const encodeVarint = (n) => {
    const out = [];
    let v = BigInt(n);
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return Buffer.from(out);
  };
  const fieldLen = (f, buf) => Buffer.concat([encodeVarint((f << 3) | 2), encodeVarint(buf.length), buf]);
  const fieldVar = (f, val) => Buffer.concat([encodeVarint((f << 3) | 0), encodeVarint(val)]);

  const durBuf = Buffer.concat([fieldVar(1, 4), fieldVar(2, 250_000_000)]);
  const m1Buf = fieldLen(11, durBuf);
  const packedSteps = Buffer.concat([encodeVarint(7), encodeVarint(8)]);
  const topBuf = Buffer.concat([fieldLen(1, m1Buf), fieldLen(2, packedSteps)]);

  const parsed = telemetry.parseGenMetadataTtft(topBuf);
  assert.deepEqual(parsed, { stepIndices: [7, 8], ttftMs: 4250 });

  const rows = telemetry.parseTranscriptJsonl(
    JSON.stringify({
      step_index: 7,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      model: 'gemini-3-pro',
      input_tokens: 4000,
      cache_read_tokens: 3000,
      output_tokens: 200,
      ttft_ms: 4250,
    }),
    'c-ttft',
    'local'
  );
  assert.equal(rows[0].ttftMs, 4250);
  const dash = telemetry.queryTelemetryDashboard({
    brainDir: '/nonexistent-dir-for-test',
    extraRequests: rows,
    range: '7d',
  });
  assert.equal(dash.summary.avgTtftMs, 4250);
});

test('control-tab: every group key and dropdown option value matches cdp.js CONFIG_VALIDATORS', () => {
  const vm = require('node:vm');
  const cdp = require('../cdp.js');
  const src = fs.readFileSync(new URL('../sidecars/panel/ui/control-tab.js', import.meta.url), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  const { I18N, GROUPS, allKeysOfGroup } = sandbox.window.AGYPanelControlSchema;
  assert.deepEqual(
    Array.from(GROUPS, (g) => g.id),
    ['appearance', 'interaction', 'telemetry', 'powertools']
  );

  const seen = new Set();
  for (const g of GROUPS) {
    for (const key of allKeysOfGroup(g)) {
      assert.ok(!seen.has(key), `Duplicate key in control-tab GROUPS: ${key}`);
      seen.add(key);
      assert.ok(key in cdp.DEFAULT_CONFIG, `Unknown config key in control-tab: ${key}`);
      for (const locale of ['zh-CN', 'en']) {
        assert.ok(I18N[locale].labels[key], `Missing ${locale} label for ${key}`);
        const opts = I18N[locale].options[key];
        if (opts) {
          for (const [val] of opts) {
            assert.equal(
              cdp.validateConfigSetting(key, val),
              true,
              `Invalid option value "${val}" for "${key}" (${locale}) rejected by cdp.validateConfigSetting`
            );
          }
        }
      }
    }
  }
});

test('usage-core: quotaCycleMode selects auto (min), weekly, or 5h bucket accurately', () => {
  const usageCore = require('../usage-core.js');
  const quotaInfo = {
    effectiveRemainingPct: 40,
    b5h: { window: '5h', remainingPct: 40, disabled: false },
    bWeek: { window: 'weekly', remainingPct: 82 },
  };
  const activeInfo = { contextUsed: 50000, maxContextTokens: 200000 };

  const autoRing = usageCore.computeRingTelemetry({ activeInfo, quotaInfo, ringMode: 'quota', quotaCycleMode: 'auto' });
  assert.equal(autoRing.quotaRemainingPct, 40);
  assert.equal(autoRing.quotaCycleUsed, '5h');
  assert.equal(autoRing.pct, 40);

  const weekRing = usageCore.computeRingTelemetry({ activeInfo, quotaInfo, ringMode: 'quota', quotaCycleMode: 'weekly' });
  assert.equal(weekRing.quotaRemainingPct, 82);
  assert.equal(weekRing.quotaCycleUsed, 'weekly');
  assert.equal(weekRing.pct, 82);

  const h5Ring = usageCore.computeRingTelemetry({ activeInfo, quotaInfo, ringMode: 'quota', quotaCycleMode: '5h' });
  assert.equal(h5Ring.quotaRemainingPct, 40);
  assert.equal(h5Ring.quotaCycleUsed, '5h');

  // Fallback to weekly when 5h bucket is absent
  const weekOnly = { effectiveRemainingPct: 68, b5h: null, bWeek: { window: 'weekly', remainingPct: 68 } };
  const fallback5h = usageCore.computeRingTelemetry({ activeInfo, quotaInfo: weekOnly, ringMode: 'quota', quotaCycleMode: '5h' });
  assert.equal(fallback5h.quotaRemainingPct, 68);
  assert.equal(fallback5h.quotaCycleUsed, 'weekly');
});

test('unread-title: strips/formats badge prefixes and classifies trajectory states', () => {
  const unread = require('../features/unread-title.js');
  assert.equal(unread.stripTitleBadge('(3) My Project - Antigravity'), 'My Project - Antigravity');
  assert.equal(unread.stripTitleBadge('● (2) My Project - Antigravity'), 'My Project - Antigravity');
  assert.equal(unread.formatUnreadTitle('My Project', 0, 0), 'My Project');
  assert.equal(unread.formatUnreadTitle('My Project', 2, 0), '(2) My Project');
  assert.equal(unread.formatUnreadTitle('(1) My Project', 1, 2), '● (3) My Project');
  assert.equal(unread.classifyTrajectoryState({ status: 'CASCADE_RUN_STATUS_RUNNING' }), 'running');
  assert.equal(unread.classifyTrajectoryState({ status: 'WAITING_FOR_USER' }), 'waiting');
  assert.equal(unread.classifyTrajectoryState({ status: 'IDLE' }), 'idle');
});

test('stage-collapse: formats badges and detects approval prompts safely', () => {
  const stage = require('../features/stage-collapse.js');
  assert.equal(stage.formatStageBadge({ toolCount: 3, thinkCount: 2 }, true), '3 步工具 · 2 次思考');
  assert.equal(stage.formatStageBadge({ updateCount: 2, toolCount: 3, thinkCount: 1 }, true), '2 条进度 · 3 步工具 · 1 次思考');
  assert.equal(stage.formatStageBadge({ updateCount: 1, toolCount: 1, thinkCount: 1 }, false), '1 update · 1 tool · 1 thought');
  assert.equal(stage.formatStageBadge({ toolCount: 1, thinkCount: 1 }, false), '1 tool · 1 thought');
  assert.equal(stage.formatStageBadge({ toolCount: 0, thinkCount: 0 }, true), '');

  const fakeApprovalResp = {
    querySelector: (sel) => (sel.includes('approval') ? {} : null),
    querySelectorAll: () => [],
  };
  assert.equal(stage.hasApprovalPrompt(fakeApprovalResp), true);

  const fakeNormalResp = {
    querySelector: () => null,
    querySelectorAll: () => [{ closest: () => null, textContent: 'Copy' }],
  };
  assert.equal(stage.hasApprovalPrompt(fakeNormalResp), false);

  // Never collapse while running or when worked-for-collapsible is hidden (display:none)
  assert.equal(
    stage.shouldAutoCollapseTurn({
      turnIsRunning: true,
      workedVisible: true,
      expanded: true,
      userToggled: false,
      autoCollapsed: false,
      hasApproval: false,
      seenRunning: true,
      isLast: true,
      hasFinalAnswer: false,
    }),
    false
  );
  assert.equal(
    stage.shouldAutoCollapseTurn({
      turnIsRunning: false,
      workedVisible: false,
      expanded: true,
      userToggled: false,
      autoCollapsed: false,
      hasApproval: false,
      seenRunning: true,
      isLast: true,
      hasFinalAnswer: true,
    }),
    false
  );
  assert.equal(
    stage.shouldAutoCollapseTurn({
      turnIsRunning: false,
      workedVisible: true,
      expanded: true,
      userToggled: false,
      autoCollapsed: false,
      hasApproval: false,
      seenRunning: true,
      isLast: true,
      hasFinalAnswer: true,
    }),
    true
  );

  // Native prompt-driven stage updates config helper (agy-powertools style with protobuf-es v2 $typeName)
  const enabledCfg = stage.applyStageUpdateConfig(
    {
      $typeName: 'exa.cortex_pb.CascadeConfig',
      plannerConfig: {
        $typeName: 'exa.cortex_pb.CascadePlannerConfig',
        promptSectionCustomizationConfig: {
          $typeName: 'exa.cortex_pb.PromptSectionCustomizationConfig',
          removePromptSections: [],
          addPromptSections: [],
          replacePromptSections: [],
          templateOverrides: {},
          appendPromptSections: [{ $typeName: 'exa.cortex_pb.PromptSection', title: 'custom', content: 'keep' }],
        },
      },
    },
    true
  );
  assert.equal(enabledCfg.plannerConfig.noToolExplanation, false);
  assert.equal(enabledCfg.plannerConfig.noToolSummary, false);
  const pCfg = enabledCfg.plannerConfig.promptSectionCustomizationConfig;
  assert.equal(pCfg.$typeName, 'exa.cortex_pb.PromptSectionCustomizationConfig');
  assert.ok(Array.isArray(pCfg.removePromptSections));
  assert.equal(pCfg.appendPromptSections.length, 2);
  assert.equal(pCfg.appendPromptSections[1].$typeName, 'exa.cortex_pb.PromptSection');
  assert.equal(pCfg.appendPromptSections[1].title, stage.STAGE_PROMPT_TITLE);
  const disabledCfg = stage.applyStageUpdateConfig(enabledCfg, false);
  assert.equal(disabledCfg.plannerConfig.promptSectionCustomizationConfig.appendPromptSections.length, 1);
  assert.equal(disabledCfg.plannerConfig.promptSectionCustomizationConfig.appendPromptSections[0].title, 'custom');

  // Native segment render transform (agy-powertools style): inline while running, folded on completion
  const stageUpdateStep = {
    type: 'step',
    step: { step: { case: 'plannerResponse', value: { response: '正在检查配置文件…' } } },
  };
  const toolGroupStep = {
    type: 'toolGroupCollapsible',
    key: 'tools-10',
    debugMode: false,
    steps: [
      { id: 1, metadata: { sourceTrajectoryStepInfo: { stepIndex: 10 } } },
      { id: 2, metadata: { sourceTrajectoryStepInfo: { stepIndex: 11 } } },
    ],
  };
  const finalTailStep = {
    type: 'step',
    step: { step: { case: 'plannerResponse', value: { response: '已修复完成。' } } },
  };
  const runningResult = stage.transformStageSegmentResult(
    {
      leadingSteps: [stageUpdateStep],
      body: { type: 'collapsible', isActive: true, defaultExpanded: true, triggerVisible: false, content: { groups: [toolGroupStep] } },
      tailSteps: [],
    },
    { isRunning: true, isLastTurn: true, segment: { isLatest: true } }
  );
  assert.equal(runningResult.body.type, 'inline');
  assert.deepEqual(runningResult.leadingSteps, [stageUpdateStep]);

  const completedResult = stage.transformStageSegmentResult(
    {
      leadingSteps: [stageUpdateStep],
      body: { type: 'collapsible', isActive: false, defaultExpanded: true, triggerVisible: true, content: { groups: [toolGroupStep] } },
      tailSteps: [finalTailStep],
    },
    { isRunning: false, isLastTurn: true, segment: { isLatest: true } }
  );
  assert.equal(completedResult.body.type, 'collapsible');
  assert.equal(completedResult.body.defaultExpanded, false);
  assert.equal(completedResult.body.isActive, false);
  assert.equal(completedResult.body.triggerVisible, true);
  assert.deepEqual(completedResult.leadingSteps, []);
  // Nested toolGroupCollapsible ("Explored / 已探索") is flattened into direct steps for single-click expansion
  assert.equal(completedResult.body.content.groups.length, 3);
  assert.deepEqual(completedResult.body.content.groups[0], stageUpdateStep);
  assert.equal(completedResult.body.content.groups[1].type, 'step');
  assert.equal(completedResult.body.content.groups[1].key, 'step-10');
  assert.equal(completedResult.body.content.groups[2].type, 'step');
  assert.equal(completedResult.body.content.groups[2].key, 'step-11');
  assert.deepEqual(completedResult.tailSteps, [finalTailStep]);

  // Native protobuf bindings path
  const mockSchemas = {
    CascadeConfigSchema: 'CC',
    CascadePlannerConfigSchema: 'CPC',
    PromptSectionCustomizationConfigSchema: 'PSCC',
    PromptSectionSchema: 'PS',
  };
  const nativeBindings = {
    schemas: mockSchemas,
    cloneProto: (_schema, obj) => structuredClone(obj),
    createProto: (schema, init) => ({ $typeName: schema, ...init }),
  };
  const nativeCfg = stage.applyStageUpdateConfig({ $typeName: 'CC' }, true, nativeBindings);
  assert.equal(nativeCfg.plannerConfig.$typeName, 'CPC');
  assert.equal(nativeCfg.plannerConfig.noToolExplanation, false);
  assert.equal(nativeCfg.plannerConfig.promptSectionCustomizationConfig.$typeName, 'PSCC');
  assert.equal(nativeCfg.plannerConfig.promptSectionCustomizationConfig.appendPromptSections[0].$typeName, 'PS');
});

test('telemetry-db: buildModelHealth aggregates 12-slot timelines, error tags, and dynamic pricing', () => {
  const now = 1_760_000_000_000;
  const reqs = [
    {
      id: '1',
      model: 'claude-sonnet-4-6',
      status: 'done',
      timestampMs: now - 3600_000,
      inputTokens: 100_000,
      cacheReadTokens: 80_000,
      outputTokens: 5_000,
      ttftMs: 2200,
      errorText: '',
      anomaly: null,
    },
    {
      id: '2',
      model: 'claude-sonnet-4-6',
      status: 'error',
      timestampMs: now - 1800_000,
      inputTokens: 10_000,
      cacheReadTokens: 0,
      outputTokens: 0,
      ttftMs: null,
      errorText: 'unexpected EOF',
      anomaly: null,
    },
  ];
  const dash = telemetry.queryTelemetryDashboard({
    brainDir: '/nonexistent-dir-for-test',
    extraRequests: reqs,
    range: '24h',
    nowMs: now,
    priceLookup: () => ({ inputPerM: 10, cacheReadPerM: 1, outputPerM: 20 }),
  });
  assert.equal(dash.modelHealth.slotCount, 12);
  assert.equal(dash.modelHealth.models.length, 1);
  const m = dash.modelHealth.models[0];
  assert.equal(m.model, 'claude-sonnet-4-6');
  assert.equal(m.errorCount, 1);
  assert.equal(m.topError, 'EOF');
  assert.equal(m.overallStatus, 'err');
  assert.equal(m.slots.length, 12);
  assert.ok(m.slots.some((s) => s.status === 'err'));
  // Dynamic pricing applied: (20k*10 + 80k*1 + 5k*20)/1e6 + (10k*10)/1e6 = 0.38 + 0.10 = 0.48
  assert.ok(Math.abs(dash.summary.totalCostUsd - 0.48) < 0.001);
});

test('pricing: parses LiteLLM JSON, syncs to cache, and falls back gracefully on network failure', async () => {
  const pricing = await import('../sidecars/panel/lib/pricing.mjs');
  const parsed = pricing.parseLiteLlmPricingJson({
    'claude-sonnet-4-6': {
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_read_input_token_cost: 0.0000003,
    },
    'anthropic/claude-opus-4-6': {
      input_cost_per_token: 0.000015,
      output_cost_per_token: 0.000075,
      cache_read_input_token_cost: 0.0000015,
    },
    'unrelated-model': { input_cost_per_token: 1, output_cost_per_token: 1 },
  });
  assert.equal(parsed['claude-sonnet-4-6'].inputPerM, 3);
  assert.equal(parsed['claude-sonnet-4-6'].outputPerM, 15);
  assert.equal(parsed['claude-opus-4-6'].cacheReadPerM, 1.5);
  assert.equal(parsed['unrelated-model'], undefined);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cs-pricing-'));
  const cachePath = path.join(tmpDir, 'pricing-cache.json');
  try {
    const store = pricing.createPricingStore({
      cachePath,
      sources: [{ name: 'Mock', url: 'https://mock.local/prices.json' }],
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          'gemini-3-pro': {
            input_cost_per_token: 0.000002,
            output_cost_per_token: 0.000012,
            cache_read_input_token_cost: 0.0000005,
          },
        }),
      }),
    });
    const res = await store.refresh({ force: true });
    assert.equal(res.ok, true);
    assert.equal(res.source, 'online');
    assert.equal(res.modelCount, 1);
    assert.equal(store.lookupPrice('gemini-3-pro').inputPerM, 2);
    assert.ok(fs.existsSync(cachePath));

    // Re-load from disk cache with failing fetchFn -> stays online from cache
    const store2 = pricing.createPricingStore({
      cachePath,
      sources: [{ name: 'Fail', url: 'https://mock.local/fail.json' }],
      fetchFn: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(store2.getMeta().source, 'online');
    assert.equal(store2.lookupPrice('gemini-3-pro').outputPerM, 12);
    const failRes = await store2.refresh({ force: true });
    assert.equal(failRes.ok, false);
    assert.ok(failRes.error.includes('offline'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('proxy: detects cold-start proxy mismatch vs active proxy and GODEBUG HTTP/1.1', async () => {
  const proxyLib = await import('../sidecars/panel/lib/proxy.mjs');
  const parsed = proxyLib.parseHostProxyFromCommandLine(
    '/Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0 --proxy-server=http://127.0.0.1:7897 --proxy-bypass-list=localhost;127.0.0.1;[::1]'
  );
  assert.equal(parsed.activeProxyUrl, 'http://127.0.0.1:7897');

  const activeOk = proxyLib.detectHostProxyRuntime(
    { proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7897', proxyForceHttp1: false },
    {
      platform: 'darwin',
      env: {},
      execFileSyncFn: () =>
        '94473 1 /Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0 --proxy-server=http://127.0.0.1:7897\n',
    }
  );
  assert.equal(activeOk.inspected, true);
  assert.equal(activeOk.matchesConfig, true);
  assert.equal(activeOk.coldStartMismatch, false);

  const coldStart = proxyLib.detectHostProxyRuntime(
    { proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7897', proxyForceHttp1: false },
    {
      platform: 'darwin',
      env: {},
      execFileSyncFn: () => '94473 1 /Applications/Antigravity.app/Contents/MacOS/Antigravity\n',
    }
  );
  assert.equal(coldStart.inspected, true);
  assert.equal(coldStart.active, false);
  assert.equal(coldStart.coldStartMismatch, true);
  assert.ok(coldStart.reason.includes('冷启动'));

  const missingH1 = proxyLib.detectHostProxyRuntime(
    { proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7897', proxyForceHttp1: true },
    {
      platform: 'darwin',
      env: {},
      execFileSyncFn: (_cmd, args) =>
        args[0] === 'eww'
          ? '94473 /Applications/Antigravity.app/Contents/MacOS/Antigravity HOME=/Users/test\n'
          : '94473 1 /Applications/Antigravity.app/Contents/MacOS/Antigravity --proxy-server=http://127.0.0.1:7897\n',
    }
  );
  assert.equal(missingH1.coldStartMismatch, true);
  assert.ok(missingH1.reason.includes('HTTP/1.1'));

  // Windows: inspect Antigravity.exe main process via CIM JSON, skipping sidecars and --type= children
  const winCimActive = JSON.stringify([
    {
      ProcessId: 15680,
      CommandLine: '"C:\\Users\\dev\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --import=file:///C:/Users/dev/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js main.mjs',
    },
    {
      ProcessId: 26504,
      CommandLine: '"C:\\Users\\dev\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --type=renderer --remote-debugging-port=0',
    },
    {
      ProcessId: 18660,
      CommandLine: '"C:\\Users\\dev\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --remote-debugging-port=0 --proxy-server=http://127.0.0.1:7897 --proxy-bypass-list=localhost;127.0.0.1;[::1]',
    },
  ]);
  const winActive = proxyLib.detectHostProxyRuntime(
    { proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7897', proxyForceHttp1: false },
    { platform: 'win32', env: {}, execFileSyncFn: () => winCimActive }
  );
  assert.equal(winActive.inspected, true);
  assert.equal(winActive.hostPid, 18660);
  assert.equal(winActive.active, true);
  assert.equal(winActive.matchesConfig, true);
  assert.equal(winActive.coldStartMismatch, false);

  const winCold = proxyLib.detectHostProxyRuntime(
    { proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7897', proxyForceHttp1: false },
    {
      platform: 'win32',
      env: {},
      execFileSyncFn: () =>
        JSON.stringify({
          ProcessId: 18660,
          CommandLine: '"C:\\Users\\dev\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --remote-debugging-port=0',
        }),
    }
  );
  assert.equal(winCold.inspected, true);
  assert.equal(winCold.hostPid, 18660);
  assert.equal(winCold.active, false);
  assert.equal(winCold.coldStartMismatch, true);
});

test('windows compatibility: parseWin32AntigravityProcesses excludes sidecars/children and sanitizeAppLaunchEnv strips case-insensitively', () => {
  const cdp = require('../cdp.js');
  const parsed = cdp.parseWin32AntigravityProcesses(
    JSON.stringify([
      {
        ProcessId: 15680,
        ExecutablePath: 'C:\\Users\\dev\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
        CommandLine: '"C:\\Users\\dev\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --import=file:///C:/Users/dev/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js main.mjs',
      },
      {
        ProcessId: 18660,
        ExecutablePath: 'C:\\Users\\dev\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
        CommandLine: '"C:\\Users\\dev\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --remote-debugging-port=0',
      },
      {
        ProcessId: 26504,
        ExecutablePath: 'C:\\Users\\dev\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
        CommandLine: '"C:\\Users\\dev\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --type=gpu-process',
      },
      {
        ProcessId: 27612,
        ExecutablePath: 'C:\\Users\\dev\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
        CommandLine: '"C:\\Users\\dev\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" -e "console.log(1)"',
      },
    ])
  );
  assert.deepEqual(parsed.mainPids, [18660]);
  assert.equal(parsed.hasCdpFlag, true);
  assert.equal(parsed.exePath, 'C:\\Users\\dev\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe');

  // Forward-slash Windows mcp-host cmdline is recognized as owned
  assert.equal(
    cdp.evaluateWatcherOwnership(
      'node C:/Users/dev/.gemini/config/plugins/agy-claude-style/plugin/mcp-host.js',
      'C:\\Users\\dev\\.gemini\\config\\plugins\\agy-claude-style',
      'win32'
    ),
    'owned'
  );

  // Case-insensitive env stripping for Windows
  const cleanEnv = cdp.sanitizeAppLaunchEnv(
    {
      Path: 'C:\\Windows',
      electron_run_as_node: '1',
      antigravity_sidecar_ui_token: 'secret',
      AGY_RELAUNCH_CODE: 'x',
      AGY_RELAUNCH_STAGE2: '1',
    },
    { HTTPS_PROXY: 'http://127.0.0.1:7897' }
  );
  assert.equal(cleanEnv.electron_run_as_node, undefined);
  assert.equal(cleanEnv.antigravity_sidecar_ui_token, undefined);
  assert.equal(cleanEnv.AGY_RELAUNCH_CODE, undefined);
  assert.equal(cleanEnv.AGY_RELAUNCH_STAGE2, undefined);
  assert.equal(cleanEnv.HTTPS_PROXY, 'http://127.0.0.1:7897');
});

test('usage-core: computeStreamingSpeed excludes TTFT and falls back cleanly for buffered responses', () => {
  const usageCore = require('../usage-core.js');
  // Genuine streaming duration
  assert.deepEqual(
    usageCore.computeStreamingSpeed({ outputTokens: 200, streamSec: 2, ttftSec: 10, totalSec: 12 }),
    { speed: 100, effectiveSec: 2, mode: 'stream' }
  );
  // Host erroneously puts totalSec (incl. TTFT) into streamSec -> strip TTFT
  assert.deepEqual(
    usageCore.computeStreamingSpeed({ outputTokens: 200, streamSec: 12, ttftSec: 10, totalSec: 12 }),
    { speed: 100, effectiveSec: 2, mode: 'stream' }
  );
  // Missing streamSec, derive totalSec - ttftSec
  assert.deepEqual(
    usageCore.computeStreamingSpeed({ outputTokens: 300, streamSec: 0, ttftSec: 8, totalSec: 11 }),
    { speed: 100, effectiveSec: 3, mode: 'stream' }
  );
  // Buffered fallback when no TTFT split exists
  assert.deepEqual(
    usageCore.computeStreamingSpeed({ outputTokens: 100, streamSec: 0, ttftSec: 0, totalSec: 4 }),
    { speed: 25, effectiveSec: 4, mode: 'buffered' }
  );
});

test('file-actions: preserves # in paths, rejects non-local file:// hosts, and uses verbatim explorer.exe /select on Windows', async () => {
  const fa = await import('../sidecars/panel/lib/file-actions.mjs');
  // Preserve literal '#' inside directory/filename while stripping trailing #L12:C3 anchor
  assert.equal(fa.stripLineColAnchor('/Users/dev/C#/Program.cs#L42:C5'), '/Users/dev/C#/Program.cs');
  assert.equal(fa.stripLineColAnchor('/Users/dev/C#/Program.cs'), '/Users/dev/C#/Program.cs');
  assert.equal(fa.resolveLocalFilePath('file:///Users/dev/C#/app.cs#L10', { platform: 'darwin' }), '/Users/dev/C#/app.cs');
  // Reject non-local remote file:// host BEFORE fileURLToPath
  assert.throws(() => fa.resolveLocalFilePath('file://evil.example.com/share/a.txt', { platform: 'darwin' }), /Non-local/);

  // Windows reveal passes /select,"<path>" verbatim directly to explorer.exe
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cs file '));
  const f = path.join(tmpDir, 'hello world.txt');
  fs.writeFileSync(f, 'ok', 'utf8');
  try {
    let called = null;
    await fa.revealLocalFile(f, {
      platform: 'win32',
      execFn: async (cmd, args, opts) => {
        called = { cmd, args, opts };
      },
    });
    assert.equal(called.cmd, 'explorer.exe');
    assert.deepEqual(called.args, [`/select,"${f}"`]);
    assert.equal(called.opts.windowsVerbatimArguments, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('panel main: resolveCdpPollStatus tolerates transient poll timeouts before reporting needsCdpRestart', async () => {
  const panelMain = await import('../sidecars/panel/main.mjs');
  const tracker = { lastOkAt: 0, lastPort: null, lastPages: [], consecutiveMisses: 0 };

  const ok = panelMain.resolveCdpPollStatus({ port: 51234, pagesList: [{ id: '1' }], nowMs: 1000, tracker });
  assert.equal(ok.connected, true);
  assert.equal(ok.needsCdpRestart, false);

  // 1st and 2nd transient failures within 20s keep connected=true (reconnecting=true)
  const miss1 = panelMain.resolveCdpPollStatus({ port: 51234, pagesList: null, nowMs: 5000, tracker });
  assert.equal(miss1.connected, true);
  assert.equal(miss1.reconnecting, true);
  assert.equal(miss1.needsCdpRestart, false);

  const miss2 = panelMain.resolveCdpPollStatus({ port: 51234, pagesList: null, nowMs: 9000, tracker });
  assert.equal(miss2.connected, true);
  assert.equal(miss2.needsCdpRestart, false);

  // 3rd consecutive failure transitions cleanly to disconnected
  const miss3 = panelMain.resolveCdpPollStatus({ port: 51234, pagesList: null, nowMs: 13000, tracker });
  assert.equal(miss3.connected, false);
  assert.equal(miss3.needsCdpRestart, true);

  // Missing port file immediately disconnects
  const noPort = panelMain.resolveCdpPollStatus({ port: null, pagesList: null, nowMs: 14000, tracker });
  assert.equal(noPort.connected, false);
  assert.equal(noPort.needsCdpRestart, true);
});

test('usage-core: preserves post-/compact estimatedAfterCompaction even when checkpoint step follows lastStepIndex', () => {
  const usageCore = require('../usage-core.js');
  const baseSteps = [
    { step: { case: 'userInput', value: { userResponse: 'hello' } }, status: 3 },
    { step: { case: 'plannerResponse', value: { response: 'world' } }, status: 3 },
    { step: { case: 'userInput', value: { userResponse: '/compact ' } }, status: 3 },
    { step: { case: 'checkpoint', value: { checkpointIndex: 10 } }, status: 3 },
  ];
  const baseGm = [
    {
      stepIndices: [1],
      metadata: {
        value: {
          usage: { inputTokens: 2000, cacheReadTokens: 420000, outputTokens: 250, responseOutputTokens: 230 },
          chatStartMetadata: {
            checkpointIndex: 9,
            contextWindowMetadata: { estimatedTokensUsed: 405000, maxContextTokens: 512000 },
          },
        },
      },
    },
  ];

  // Immediately after manual /compact, cwUsage.lastStepIndex may still point to step 1 (before checkpoint @ 3).
  const postCompact = usageCore.analyzeActiveConversation(
    {
      trajectory: {
        cascadeId: 'compact-test',
        steps: baseSteps,
        generatorMetadata: baseGm,
        contextWindowUsage: {
          estimatedAfterCompaction: true,
          estimatedTokensUsed: 25000,
          maxContextTokens: 512000,
          generatorMetadataIndex: 0,
          lastStepIndex: 1,
        },
      },
    },
    { cascadeId: 'compact-test' }
  );
  assert.equal(postCompact.contextUsed, 25000);
  assert.equal(postCompact.maxContextTokens, 512000);
  assert.equal(postCompact.contextEstimatedAfterCompaction, true);
  assert.equal(postCompact.compactionGmIdx, 0);
  assert.equal(postCompact.checkpointIdx, 10);

  // Once the next real request (gmIdx 1 > 0) arrives, measured tokens replace the estimate.
  const nextTurn = usageCore.analyzeActiveConversation(
    {
      trajectory: {
        cascadeId: 'compact-test',
        steps: [
          ...baseSteps,
          { step: { case: 'userInput', value: { userResponse: 'next question' } }, status: 3 },
          { step: { case: 'plannerResponse', value: { response: 'next answer' } }, status: 3 },
        ],
        generatorMetadata: [
          ...baseGm,
          {
            stepIndices: [5],
            metadata: {
              value: {
                usage: { inputTokens: 4000, cacheReadTokens: 23000, outputTokens: 300, responseOutputTokens: 280 },
                chatStartMetadata: {
                  checkpointIndex: 10,
                  contextWindowMetadata: { estimatedTokensUsed: 27280, maxContextTokens: 512000 },
                },
              },
            },
          },
        ],
        contextWindowUsage: {
          estimatedAfterCompaction: true,
          estimatedTokensUsed: 25000,
          maxContextTokens: 512000,
          generatorMetadataIndex: 0,
          lastStepIndex: 3,
        },
      },
    },
    { cascadeId: 'compact-test' }
  );
  assert.equal(nextTurn.contextUsed, 27280);
  assert.equal(nextTurn.contextEstimatedAfterCompaction, false);
});

test('ui-runtime: rewind viewport recovery hooks into autoscroll-viewport and load-older-messages-button', () => {
  const src = fs.readFileSync(new URL('../ui-runtime.js', import.meta.url), 'utf8');
  assert.ok(src.includes('function syncRewindViewportRecovery()'));
  assert.ok(src.includes('function clearStalePostRewindMinHeight('));
  assert.ok(src.includes('function measureLastVisibleContentBottom('));
  assert.ok(src.includes('button[data-testid="load-older-messages-button"]'));
  assert.ok(src.includes('function nudgeAutoscrollViewport('));
  assert.ok(src.includes('cancelRewindRecoveryTimers()'));
  assert.ok(src.includes('stepCount > 0'));
});

test('cdp: hasConfiguredProxyFlag detects missing proxy on CDP-enabled host and passes when matched', () => {
  const cdp = require('../cdp.js');
  const cfg = { proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7897' };
  const missing = cdp.hasConfiguredProxyFlag([100], cfg, {
    inspectCmdFn: () => '/Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0',
  });
  assert.equal(missing.required, true);
  assert.equal(missing.inspected, true);
  assert.equal(missing.matched, false);

  const matched = cdp.hasConfiguredProxyFlag([100], cfg, {
    inspectCmdFn: () =>
      '/Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0 --proxy-server=http://127.0.0.1:7897',
  });
  assert.equal(matched.required, true);
  assert.equal(matched.inspected, true);
  assert.equal(matched.matched, true);

  const disabled = cdp.hasConfiguredProxyFlag([100], { proxyEnabled: false, proxyUrl: 'http://127.0.0.1:7897' });
  assert.equal(disabled.required, false);
  assert.equal(disabled.matched, true);
});

test('panel sidecar: maybeAutoRelaunchForProxyColdStart relaunches once when reachable and respects guard/unreachable', async () => {
  const cdp = require('../cdp.js');
  const panelMod = await import('../sidecars/panel/main.mjs');
  let relaunches = 0;
  let recordedGuard = { consecutiveFailures: 0, tripped: false, lastPidSig: '', lastAttemptAt: 0 };

  const unreachable = await panelMod.maybeAutoRelaunchForProxyColdStart({
    readConfigFn: () => ({ proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7897', proxyForceHttp1: true }),
    detectRuntimeFn: () => ({ inspected: true, hostPid: 7777, coldStartMismatch: true }),
    testConnectivityFn: async () => ({ ok: false, error: 'ECONNREFUSED' }),
    readGuardFn: () => recordedGuard,
    evalGuardFn: cdp.evaluateAutoRelaunchGuard,
    recordGuardFn: ({ pidSig, nowMs }) => {
      recordedGuard = { ...recordedGuard, lastPidSig: pidSig, lastAttemptAt: nowMs };
    },
    relaunchFn: async () => {
      relaunches++;
      return { relaunched: true };
    },
    nowMs: 100_000,
  });
  assert.equal(unreachable.triggered, false);
  assert.equal(unreachable.reason, 'proxy-unreachable');
  assert.equal(relaunches, 0);

  const ok = await panelMod.maybeAutoRelaunchForProxyColdStart({
    readConfigFn: () => ({ proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7897', proxyForceHttp1: true }),
    detectRuntimeFn: () => ({ inspected: true, hostPid: 7777, coldStartMismatch: true }),
    testConnectivityFn: async () => ({ ok: true }),
    readGuardFn: () => recordedGuard,
    evalGuardFn: cdp.evaluateAutoRelaunchGuard,
    recordGuardFn: ({ pidSig, nowMs }) => {
      recordedGuard = { ...recordedGuard, lastPidSig: pidSig, lastAttemptAt: nowMs };
    },
    relaunchFn: async () => {
      relaunches++;
      return { relaunched: true };
    },
    nowMs: 100_000,
  });
  assert.equal(ok.triggered, true);
  assert.equal(relaunches, 1);

  const blocked = await panelMod.maybeAutoRelaunchForProxyColdStart({
    readConfigFn: () => ({ proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7897', proxyForceHttp1: true }),
    detectRuntimeFn: () => ({ inspected: true, hostPid: 7777, coldStartMismatch: true }),
    testConnectivityFn: async () => ({ ok: true }),
    readGuardFn: () => recordedGuard,
    evalGuardFn: cdp.evaluateAutoRelaunchGuard,
    isRelaunchInProgressFn: () => false,
    relaunchFn: async () => {
      relaunches++;
      return { relaunched: true };
    },
    nowMs: 105_000,
  });
  assert.equal(blocked.triggered, false);
  assert.equal(relaunches, 1);

  // Concurrent relaunch in progress must skip without incrementing guard failures
  let concurrentRecords = 0;
  const skippedBusy = await panelMod.maybeAutoRelaunchForProxyColdStart({
    readConfigFn: () => ({ proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7897', proxyForceHttp1: true }),
    detectRuntimeFn: () => ({ inspected: true, hostPid: 8888, coldStartMismatch: true }),
    testConnectivityFn: async () => ({ ok: true }),
    readGuardFn: () => ({ consecutiveFailures: 0, tripped: false, lastPidSig: '', lastAttemptAt: 0 }),
    evalGuardFn: cdp.evaluateAutoRelaunchGuard,
    isRelaunchInProgressFn: () => false,
    recordGuardFn: () => {
      concurrentRecords++;
    },
    relaunchFn: async () => ({ relaunched: false, skipped: true, reason: 'relaunch-in-progress' }),
    nowMs: 200_000,
  });
  assert.equal(skippedBusy.triggered, false);
  assert.equal(skippedBusy.reason, 'relaunch-in-progress');
  assert.equal(concurrentRecords, 0);
});

test('cdp: cross-process relaunch lock blocks concurrent detached relaunches and reclaims stale locks', async () => {
  const cdp = require('../cdp.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cs-rlock-'));
  const lockPath = path.join(tmpDir, '.relaunch.lock');
  try {
    const t0 = 5_000_000;
    const first = cdp.tryAcquireRelaunchLock({ lockPath, pid: 40001, nowMs: t0, isAliveFn: () => true });
    assert.equal(first.acquired, true);
    assert.equal(cdp.isRelaunchInProgress({ lockPath, nowMs: t0 + 500, isAliveFn: () => true }), true);

    // Second concurrent attempt within handoff grace is blocked even if first PID already exited
    const duringHandoff = cdp.tryAcquireRelaunchLock({ lockPath, pid: 40002, nowMs: t0 + 500, isAliveFn: () => false });
    assert.equal(duringHandoff.acquired, false);
    assert.equal(duringHandoff.reason, 'relaunch-in-progress');

    // Detached relaunch respects lockPath and skips duplicate spawn
    let spawnCount = 0;
    const dupRes = await cdp.relaunchAntigravityWithCdp({
      detached: true,
      appPath: process.execPath,
      lockPath,
      nowMs: t0 + 500,
      isAliveFn: () => true,
      detectProcess: () => ({ running: true, pids: [55555] }),
      spawn: () => {
        spawnCount++;
        return { unref() {} };
      },
    });
    assert.equal(dupRes.relaunched, false);
    assert.equal(dupRes.skipped, true);
    assert.equal(dupRes.reason, 'relaunch-in-progress');
    assert.equal(spawnCount, 0);

    // Dead owner past handoff grace (3s) is automatically reclaimed
    const reclaimed = cdp.tryAcquireRelaunchLock({ lockPath, pid: 40003, nowMs: t0 + 4000, isAliveFn: () => false });
    assert.equal(reclaimed.acquired, true);
    assert.equal(cdp.releaseRelaunchLock(lockPath, { ownerPid: 99999 }), false);
    assert.equal(cdp.releaseRelaunchLock(lockPath, { ownerPid: 40003 }), true);
    assert.equal(cdp.isRelaunchInProgress({ lockPath, nowMs: t0 + 4001, isAliveFn: () => true }), false);

    // Verify detached helper includes SingletonLock wait and guards open -a behind portReady || childAlive
    const helperSrc = cdp.scheduleDetachedRelaunch.toString();
    assert.match(helperSrc, /singletonLockFile/);
    assert.match(helperSrc, /lstatSync/);
    assert.match(helperSrc, /\(portReady \|\| childAlive\)/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('windows non-TUN proxy compatibility: NODE_USE_ENV_PROXY, custom launcher validation, and relaunch env preservation', async () => {
  const cdp = require('../cdp.js');
  const proxyLib = await import('../sidecars/panel/lib/proxy.mjs');

  // 1. Built-in proxy builders include NODE_USE_ENV_PROXY=1
  const pOpts = proxyLib.buildProxyLaunchOptions({ proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7890' });
  assert.equal(pOpts.env.NODE_USE_ENV_PROXY, '1');
  const cdpOpts = cdp.buildProxyLaunchOptionsFromConfig({ proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7890' });
  assert.equal(cdpOpts.env.NODE_USE_ENV_PROXY, '1');

  // 2. sanitizeAppLaunchEnv injects NODE_USE_ENV_PROXY=1 only when proxy env exists and respects explicit 0
  const directEnv = cdp.sanitizeAppLaunchEnv({ PATH: 'C:\\Windows\\System32', ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(directEnv.NODE_USE_ENV_PROXY, undefined);
  assert.equal(directEnv.ELECTRON_RUN_AS_NODE, undefined);

  const procProxyEnv = cdp.sanitizeAppLaunchEnv({
    PATH: 'C:\\Windows\\System32',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    NO_PROXY: 'localhost,127.0.0.1,::1',
  });
  assert.equal(procProxyEnv.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(procProxyEnv.NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.equal(procProxyEnv.NODE_USE_ENV_PROXY, '1');

  const explicitOffEnv = cdp.sanitizeAppLaunchEnv({
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    NODE_USE_ENV_PROXY: '0',
  });
  assert.equal(explicitOffEnv.NODE_USE_ENV_PROXY, '0');

  // 3. detectHostProxyRuntime detects external env proxy when proxyEnabled=false without breaking coldStartMismatch
  const extRuntime = proxyLib.detectHostProxyRuntime(
    { proxyEnabled: false },
    {
      platform: 'win32',
      execFileSyncFn: () => JSON.stringify([{ ProcessId: 1001, CommandLine: '"C:\\Antigravity\\Antigravity.exe" --remote-debugging-port=9222' }]),
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
    }
  );
  assert.equal(extRuntime.active, true);
  assert.equal(extRuntime.coldStartMismatch, false);

  const cfgMismatch = proxyLib.detectHostProxyRuntime(
    { proxyEnabled: true, proxyUrl: 'http://127.0.0.1:7890', proxyForceHttp1: true },
    {
      platform: 'win32',
      execFileSyncFn: () => JSON.stringify([{ ProcessId: 1001, CommandLine: '"C:\\Antigravity\\Antigravity.exe" --remote-debugging-port=9222' }]),
      env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
    }
  );
  assert.equal(cfgMismatch.active, false);
  assert.equal(cfgMismatch.coldStartMismatch, true);

  // 4. resolveCustomLaunchCommand validates extension/unsafe chars and respects win32-only scope
  assert.equal(
    cdp.resolveCustomLaunchCommand({
      platform: 'darwin',
      env: { AGY_CLAUDE_STYLE_LAUNCH_CMD: '/tmp/Antigravity-Proxy.cmd' },
      existsFn: () => true,
    }),
    null
  );
  assert.equal(
    cdp.resolveCustomLaunchCommand({
      platform: 'win32',
      env: { AGY_CLAUDE_STYLE_LAUNCH_CMD: 'C:\\Tools\\Antigravity-Proxy.cmd&calc.exe' },
      existsFn: () => true,
    }),
    null
  );
  assert.equal(
    cdp.resolveCustomLaunchCommand({
      platform: 'win32',
      env: { AGY_CLAUDE_STYLE_LAUNCH_CMD: 'C:\\Tools\\readme.txt' },
      existsFn: () => true,
    }),
    null
  );
  assert.equal(
    cdp.resolveCustomLaunchCommand({
      platform: 'win32',
      env: { AGY_CLAUDE_STYLE_LAUNCH_CMD: '"C:\\Tools\\Antigravity-Proxy.cmd"' },
      existsFn: (p) => p === 'C:\\Tools\\Antigravity-Proxy.cmd',
    }),
    'C:\\Tools\\Antigravity-Proxy.cmd'
  );
  assert.equal(
    cdp.resolveCustomLaunchCommand({
      platform: 'win32',
      env: { AGY_CLAUDE_STUDIO_LAUNCH_CMD: 'C:\\Tools\\Antigravity-Proxy.bat' },
      existsFn: (p) => p === 'C:\\Tools\\Antigravity-Proxy.bat',
    }),
    'C:\\Tools\\Antigravity-Proxy.bat'
  );

  // 5. win32 launchAntigravityWithCdp & relaunchAntigravityWithCdp support .cmd/.ps1 and preserve proxy env
  let winLaunched = null;
  const launchedCmd = cdp.launchAntigravityWithCdp({
    platform: 'win32',
    env: {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      AGY_CLAUDE_STYLE_LAUNCH_CMD: 'C:\\Tools\\Antigravity-Proxy.cmd',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1',
    },
    exists: (p) => p === 'C:\\Tools\\Antigravity-Proxy.cmd',
    detectProcess: () => ({ running: true, pids: [] }),
    spawn: (cmd, args, opts) => {
      winLaunched = { cmd, args, opts };
      return { unref() {} };
    },
  });
  assert.equal(launchedCmd, true);
  assert.equal(winLaunched.cmd, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(winLaunched.args, ['/d', '/c', 'C:\\Tools\\Antigravity-Proxy.cmd', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']);
  assert.equal(winLaunched.opts.windowsHide, true);
  assert.equal(winLaunched.opts.env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(winLaunched.opts.env.NODE_USE_ENV_PROXY, '1');

  const psInv = cdp.buildWinSpawnInvocation('C:\\Tools\\Antigravity-Proxy.ps1', ['--remote-debugging-port=0']);
  assert.equal(psInv.command, 'powershell.exe');
  assert.deepEqual(psInv.args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Tools\\Antigravity-Proxy.ps1', '--remote-debugging-port=0']);

  // Direct/TUN user without proxy env or custom launcher keeps spawnEnv=undefined
  let directLaunch = null;
  cdp.launchAntigravityWithCdp({
    platform: 'win32',
    appPath: 'C:\\Program Files\\Antigravity\\Antigravity.exe',
    env: { PATH: 'C:\\Windows\\System32' },
    detectProcess: () => ({ running: true, pids: [] }),
    spawn: (cmd, args, opts) => {
      directLaunch = { cmd, args, opts };
      return { unref() {} };
    },
  });
  assert.equal(directLaunch.cmd, 'C:\\Program Files\\Antigravity\\Antigravity.exe');
  assert.equal(directLaunch.opts.env, undefined);

  // Detached relaunch passes baseEnv + custom launcher on win32 and helper sets NODE_USE_ENV_PROXY
  let detachedWin = null;
  const relaunchWinRes = await cdp.relaunchAntigravityWithCdp({
    detached: true,
    platform: 'win32',
    env: {
      AGY_CLAUDE_STYLE_LAUNCH_CMD: 'C:\\Tools\\Antigravity-Proxy.cmd',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    },
    exists: (p) => p === 'C:\\Tools\\Antigravity-Proxy.cmd',
    detectProcess: () => ({ running: true, pids: [4242] }),
    spawn: (cmd, args, opts) => {
      detachedWin = { cmd, args, opts };
      return { unref() {} };
    },
  });
  assert.equal(relaunchWinRes.relaunched, true);
  assert.equal(relaunchWinRes.reason, 'detached');
  const winSpec = JSON.parse(detachedWin.opts.env.AGY_RELAUNCH_SPEC);
  assert.equal(winSpec.appPath, 'C:\\Tools\\Antigravity-Proxy.cmd');
  assert.equal(detachedWin.opts.env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.match(cdp.scheduleDetachedRelaunch.toString(), /NODE_USE_ENV_PROXY/);

  // 6. C# CdpClient.cs includes custom launcher & NODE_USE_ENV_PROXY helpers
  const csSource = fs.readFileSync(require.resolve('../installer/common/CdpClient.cs'), 'utf8');
  assert.match(csSource, /ResolveCustomLaunchCommand/);
  assert.match(csSource, /EnsureNodeUseEnvProxyIfProxySet/);
  assert.match(csSource, /AGY_CLAUDE_STYLE_LAUNCH_CMD/);
});

test('v2.2.0 security & robustness: file-actions UNC block, wt.exe semicolon escape, main.mjs fail-closed host & removed route', async () => {
  const fa = await import('../sidecars/panel/lib/file-actions.mjs');
  const main = await import('../sidecars/panel/main.mjs');

  // UNC path blocked on file:// URI & win32 reveal
  await assert.rejects(
    () => fa.dispatchFileAction({ type: 'file.reveal', uri: 'file://fileserver/share/secret.txt' }, { platform: 'win32' }),
    /remote|unc|host|local/i
  );
  // 127.0.0.1 host normalized to local path
  const { pathToFileURL } = require('node:url');
  const tmpFile = path.join(os.tmpdir(), `agy-fa-127-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'hi');
  try {
    const loopbackUri = pathToFileURL(tmpFile);
    loopbackUri.hostname = '127.0.0.1';
    const resolved = fa.resolveLocalFilePath(loopbackUri.href);
    assert.equal(resolved, tmpFile);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  // wt.exe semicolon escaping
  let wtArgs = null;
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wt-'));
  const subDir = path.join(dirTmp, 'a;b');
  fs.mkdirSync(subDir, { recursive: true });
  try {
    const fakeLocalAppData = path.join(dirTmp, 'AppDataLocal');
    const fakeWtPath = path.join(fakeLocalAppData, 'Microsoft', 'WindowsApps', 'wt.exe');
    await fa.openFileWithApp(subDir, 'terminal', {
      platform: 'win32',
      env: { LOCALAPPDATA: fakeLocalAppData },
      exists: (p) => p === fakeWtPath || p === subDir,
      spawnProcess: (_cmd, args) => { wtArgs = args; return { on() {}, unref() {} }; },
    });
    assert.ok(wtArgs && wtArgs.some((a) => String(a).includes('a\\;b')), `Expected escaped semicolon in wt.exe args: ${JSON.stringify(wtArgs)}`);
  } finally {
    fs.rmSync(dirTmp, { recursive: true, force: true });
  }

  // main.mjs isLocalHostRequest fail-closed when missing Host or bad Host/Origin
  assert.equal(main.isLocalHostRequest({ headers: {} }), false);
  assert.equal(main.isLocalHostRequest({ headers: { host: 'evil.example:8123', 'sec-fetch-site': 'same-origin' } }), false);
  const mainSrc = fs.readFileSync(require.resolve('../sidecars/panel/main.mjs'), 'utf8');
  assert.equal(mainSrc.includes('/api/file/action'), false, 'Panel HTTP server must not expose unauthenticated /api/file/action');
});

test('v2.2.0 telemetry & quota fixes: UTF-8 split chunk, >maxBytes tail, DST heatmap, pricing o3/null, quota 10m cap & default account guard', async () => {
  const quotaTracker = await import('../sidecars/panel/lib/quota-tracker.mjs');
  const pricing = await import('../sidecars/panel/lib/pricing.mjs');

  // UTF-8 split multi-byte char + oversized file tail slice
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tel-utf8-'));
  try {
    const jsonlPath = path.join(tmpDir, 'conv.jsonl');
    const pad = JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'claude-sonnet-4-6', input_tokens: 1, output_tokens: 1, created_at: '2026-11-27T09:00:00Z' });
    const uLine = JSON.stringify({ type: 'USER_INPUT', content: '中文边界🧪测试', created_at: '2026-11-27T10:00:00Z' });
    const rLine = JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 50, created_at: '2026-11-27T10:00:02Z' });
    const tailBytes = Buffer.byteLength(`${uLine}\n${rLine}\n`);
    fs.writeFileSync(jsonlPath, `${pad}\n`.repeat(20) + `${uLine}\n${rLine}\n`, 'utf8');
    const rows = telemetry.parseTranscriptFileBounded(jsonlPath, 'c1', 'local', {
      maxBytes: tailBytes + 64,
    });
    assert.ok(rows.some((r) => r.conversationTitle === '中文边界🧪测试' && r.outputTokens === 50), 'Tail read must preserve valid UTF-8 CJK/emoji');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // DST-safe 53-week calendar heatmap (2026-11-27 is Friday -> 52w*7 + 6 = 370 calendar days, 1 today cell)
  const heat = telemetry.buildHeatmap53w([], Date.parse('2026-11-27T12:00:00Z'));
  assert.equal(heat.length, 370);
  assert.equal(heat.filter((c) => c.isToday).length, 1);
  assert.equal(heat[heat.length - 1].isToday, true);

  // pricing: null cache tokens don't become 0, dotted names normalize, o3 included
  const parsedPricing = pricing.parseLiteLlmPricingJson({
    o3: { input_cost_per_token: 2e-6, output_cost_per_token: 8e-6, cache_read_input_token_cost: null },
    'anthropic/claude-4.6-sonnet': { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5, cache_read_input_token_cost: 3e-7 },
  });
  assert.ok(parsedPricing.o3, 'o3 should be included by pricing parser');
  assert.equal(parsedPricing.o3.cacheReadPerM, 0.5, 'null cache_read_input_token_cost must fall back to 0.25x estimate instead of 0');
  const dottedResolved = pricing.resolveModelPrice('claude-4.6-sonnet', parsedPricing);
  assert.equal(dottedResolved.inputPerM, 3);

  // quota tracker: missing userStatus yields 'default' accountKey & cap >10min idle synthetic credit
  assert.deepEqual(quotaTracker.extractAccountInfo(null), { accountKey: 'default', accountLabel: '' });
  const store = quotaTracker.createEmptyStore();
  const t0 = Date.parse('2026-11-27T10:00:00Z');
  const pools = [{ name: 'Claude', remainingPct: 100, resetSec: Math.floor(t0 / 1000) + 18000 }];
  quotaTracker.recordQuotaSample(store, pools, t0, { latestActivityMs: t0 });
  const t2h = t0 + 2 * 3600 * 1000; // 2h gap with no activity (>10m cap)
  quotaTracker.recordQuotaSample(store, pools, t2h, { latestActivityMs: t0 });
  const summary = quotaTracker.summarizeWeeklyQuota(store, pools, t2h);
  assert.equal(summary.available, true);
  assert.equal(summary.pools[0].consumedTodayPct, 0);
});

test('v2.2.0 powertools fixes: cdp validator, extensions-dock XSS-free render, stagePromptInjection gating, unread numeric proto, branch-edit short query, task-progress checklist & macOS recursive payload', async () => {
  const cdp = require('../cdp.js');
  // cdp stagePromptInjection validator + default false
  assert.equal(cdp.DEFAULT_CONFIG.stagePromptInjection, false);
  assert.equal(cdp.validateConfigSetting('stagePromptInjection', 'yes'), false);
  assert.equal(cdp.validateConfigSetting('stagePromptInjection', true), true);

  // stage-collapse: applyStageUpdateConfig injects only when enabled=true, and ES module getter resolution works
  const stageCollapse = require('../features/stage-collapse.js');
  const baseCfg = { plannerConfig: { noToolExplanation: true, promptSectionCustomizationConfig: { appendPromptSections: [] } } };
  const injectedCfg = stageCollapse.applyStageUpdateConfig(baseCfg, true);
  assert.ok(injectedCfg.plannerConfig.promptSectionCustomizationConfig.appendPromptSections.some((s) => s.title === stageCollapse.STAGE_PROMPT_TITLE));
  const strippedCfg = stageCollapse.applyStageUpdateConfig(injectedCfg, false);
  assert.equal(strippedCfg.plannerConfig.promptSectionCustomizationConfig.appendPromptSections.length, 0);

  const getterMod = Object.defineProperty({}, 'segmentFn', {
    enumerable: true,
    get() { return function () { return 'collapsible mode tool-group render'; }; },
  });
  Object.defineProperty(getterMod, 'cascadeFn', {
    enumerable: true,
    get() { return function () { return 'CascadeConfigSchema promptSectionCustomizationConfig'; }; },
  });
  const fakeWin = { webpackChunk_N_E: [[[], { 1: (_m, exp) => Object.assign(exp, getterMod) }]] };
  assert.doesNotThrow(() => stageCollapse.discoverNativeStageBindings(fakeWin));

  // unread-title: numeric protobuf states + summary unwrap
  const unread = require('../features/unread-title.js');
  assert.equal(unread.classifyTrajectoryState({ summary: { status: 2 } }), 'running');
  assert.equal(unread.classifyTrajectoryState({ summary: { status: 9 } }), 'waiting');
  assert.equal(unread.classifyTrajectoryState({ summary: { status: 3 } }), 'idle');

  // extensions-dock: malicious XSS strings are escaped/stored via textContent rather than executed as innerHTML
  const extDock = require('../features/extensions-dock.js');
  const cleanEntry = extDock.normalizeSidecarEntry({ sidecarId: 'bad<script>1', title: '<img src=x onerror=alert(1)>' });
  assert.equal(cleanEntry.title, '<img src=x onerror=alert(1)>');
  const extSrc = fs.readFileSync(require.resolve('../features/extensions-dock.js'), 'utf8');
  assert.equal(/\.innerHTML\s*=[^;\n]*\$\{[^}]*(ext\.title|shortLabel|logoSrc)/.test(extSrc), false, 'extensions-dock.js must not interpolate ext.title or logoSrc into innerHTML');

  // branch-edit: short ambiguous query requires exact match, not substring
  const branchEdit = require('../features/branch-edit.js');
  const turns = [{ stepIndex: 1, text: 'hi there' }, { stepIndex: 3, text: 'hi' }];
  const picked = branchEdit.matchTurnIndex(turns, [{ textContent: 'hi' }], { textContent: 'hi' });
  assert.equal(picked?.stepIndex, 3);

  // task-progress: summarizeSteps counts checklist and prioritizes update_steps toolCalls
  const tpSummary = taskProgress.summarizeSteps([
    {
      status: 3,
      step: {
        case: 'plannerResponse',
        value: {
          toolCalls: [{ name: 'update_steps', argumentsJson: JSON.stringify({ steps: [{ title: 'A', status: 'done' }, { title: 'B', status: 'pending' }] }) }],
          response: '- [ ] ignored fallback',
        },
      },
    },
  ]);
  assert.equal(tpSummary.checklist.length, 2);
  assert.equal(tpSummary.checklist[0].status, 'done');

  // ssh-remote: spawn failure returns error result cleanly without TDZ & attaches stdin error handler
  const sshRes = await sshRemote.fetchSshRemoteRequests('devbox', {
    force: true,
    spawnFn: () => { throw new Error('ENOENT ssh'); },
  });
  assert.match(String(sshRes.error || ''), /ENOENT ssh/);

  // macOS installer & build script recursive features/ support
  const repoRoot = path.dirname(require.resolve('../cdp.js'));
  const buildMacosSrc = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-macos.mjs'), 'utf8');
  const swiftSetupSrc = fs.readFileSync(path.join(repoRoot, 'installer', 'macos', 'Setup', 'main.swift'), 'utf8');
  assert.match(buildMacosSrc, /mkdirSync\(path\.dirname\(destPath\), \{ recursive: true \}\)/);
  assert.match(swiftSetupSrc, /func copyPayloadDirectory\(/);
});

