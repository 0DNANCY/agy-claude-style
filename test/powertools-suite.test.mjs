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

  assert.equal(taskProgress.formatClock(0), '0s');
  assert.equal(taskProgress.formatClock(420), '0.4s');
  assert.equal(taskProgress.formatClock(14800), '14s');
  assert.equal(taskProgress.formatClock(75000), '1m 15s');
  assert.equal(taskProgress.formatClock(3720000), '1h 2m');
});

test('hide-on-close: classifies Cmd+W vs Cmd+Q/Reload and respects hidden state', () => {
  const hideOnClose = require('../features/hide-on-close.js');
  const cdp = require('../cdp.js');

  assert.equal(cdp.DEFAULT_CONFIG.hideOnClose, true);
  assert.ok(cdp.RUNTIME_PARTS.includes('features/hide-on-close.js'));
  assert.equal(typeof cdp.hideAntigravityWindow, 'function');

  assert.equal(hideOnClose.classifyShortcut({ metaKey: true, key: 'w' }, true), 'hide-window');
  assert.equal(hideOnClose.classifyShortcut({ metaKey: true, shiftKey: true, key: 'w' }, true), 'none');
  assert.equal(hideOnClose.classifyShortcut({ metaKey: true, key: 'q' }, true), 'allow-unload');
  assert.equal(hideOnClose.classifyShortcut({ metaKey: true, key: 'r' }, true), 'allow-unload');
  assert.equal(hideOnClose.classifyShortcut({ altKey: true, key: 'F4' }, false), 'allow-unload');

  assert.equal(hideOnClose.shouldInterceptBeforeUnload({ enabled: true, nowMs: 5000, allowRealUnloadUntil: 0, isHidden: false }), true);
  assert.equal(hideOnClose.shouldInterceptBeforeUnload({ enabled: false, nowMs: 5000, allowRealUnloadUntil: 0, isHidden: false }), false);
  assert.equal(hideOnClose.shouldInterceptBeforeUnload({ enabled: true, nowMs: 5000, allowRealUnloadUntil: 7000, isHidden: false }), false);
  assert.equal(hideOnClose.shouldInterceptBeforeUnload({ enabled: true, nowMs: 5000, allowRealUnloadUntil: 0, isHidden: true }), false);
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

test('quota-tracker: tracks daily weekly-quota burn, midnight carry-over, and mid-day resets', async () => {
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

  const day1Morning = new Date(2026, 10, 23, 22, 0, 0).getTime();
  let store = qt.createEmptyStore();
  ({ store } = qt.recordQuotaSample(store, pools1, day1Morning));

  // Next morning (same weekly reset cycle): Gemini dropped 80 -> 74 (6% burned), Claude stayed 65
  const day2Morning = new Date(2026, 10, 24, 9, 0, 0).getTime();
  const pools2 = [
    { name: 'Gemini Pro', remainingPct: 74, resetSec: pools1[0].resetSec },
    { name: 'Claude', remainingPct: 65, resetSec: pools1[1].resetSec },
  ];
  ({ store } = qt.recordQuotaSample(store, pools2, day2Morning));
  let sum = qt.summarizeWeeklyQuota(store, pools2, day2Morning);
  assert.equal(sum.pools.find((p) => p.name === 'Gemini Pro').consumedTodayPct, 6);
  assert.equal(sum.pools.find((p) => p.name === 'Gemini Pro').carriedFromPrior, true);

  // Mid-day additional usage: Gemini 74 -> 69 (+5% -> 11% total)
  const day2Noon = new Date(2026, 10, 24, 12, 0, 0).getTime();
  const pools3 = [
    { name: 'Gemini Pro', remainingPct: 69, resetSec: pools1[0].resetSec },
    { name: 'Claude', remainingPct: 60.5, resetSec: pools1[1].resetSec },
  ];
  ({ store } = qt.recordQuotaSample(store, pools3, day2Noon));
  sum = qt.summarizeWeeklyQuota(store, pools3, day2Noon);
  assert.equal(sum.pools.find((p) => p.name === 'Gemini Pro').consumedTodayPct, 11);
  assert.equal(sum.pools.find((p) => p.name === 'Claude').consumedTodayPct, 4.5);

  // Mid-day weekly reset on Gemini: resetSec advances and remaining jumps to 96% (4% burned post-reset -> 15% total)
  const day2Eve = new Date(2026, 10, 24, 18, 0, 0).getTime();
  const pools4 = [
    { name: 'Gemini Pro', remainingPct: 96, resetSec: pools1[0].resetSec + 7 * 86400 },
    { name: 'Claude', remainingPct: 60.5, resetSec: pools1[1].resetSec },
  ];
  ({ store } = qt.recordQuotaSample(store, pools4, day2Eve));
  sum = qt.summarizeWeeklyQuota(store, pools4, day2Eve);
  assert.equal(sum.pools.find((p) => p.name === 'Gemini Pro').consumedTodayPct, 15);
  assert.ok(sum.byDate['2026-11-24']);
  assert.equal(sum.byDate['2026-11-24'].maxConsumedPct, 15);
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
