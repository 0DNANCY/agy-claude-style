import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const usageCore = require('../usage-core.js');
const telemetry = await import('../sidecars/panel/lib/telemetry-db.mjs');
const qt = await import('../sidecars/panel/lib/quota-tracker.mjs');
const lsDisc = await import('../sidecars/panel/lib/ls-discovery.mjs');
const { SidecarOwner, atomicWriteFileSync } = await import('../sidecars/panel/lib/sidecar-owner.mjs');

function mkTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('usage-core rate quality: quarantines short/burst/MAD-outlier while preserving sustained high speed, E2E, and TTFT P50', () => {
  const mkGm = (out, streamSec, ttftSec, stepIdx, model = 'Gemini 4 Argon') => ({
    stepIndices: [stepIdx],
    metadata: {
      value: {
        modelDisplayName: model,
        usage: { inputTokens: '1000', cacheReadTokens: '4000', outputTokens: String(out) },
        streamingDuration: `${streamSec}s`,
        timeToFirstToken: `${ttftSec}s`,
      },
    },
  });

  const traj = {
    steps: [
      { status: 3, step: { case: 'plannerResponse', value: { response: 'ok 1' } } },
      { status: 3, step: { case: 'plannerResponse', value: { response: 'ok 2' } } },
      { status: 3, step: { case: 'plannerResponse', value: { response: 'ok 3' } } },
      { status: 3, step: { case: 'plannerResponse', value: { response: 'ok 4' } } },
      { status: 3, step: { case: 'plannerResponse', value: { response: 'ok 5' } } },
      { status: 3, step: { case: 'plannerResponse', value: { response: 'sustained fast' } } },
      { status: 3, step: { case: 'plannerResponse', value: { response: '', toolCalls: [{ name: 'run' }] } } },
      { status: 3, step: { case: 'plannerResponse', value: { response: 'buffered burst' } } },
    ],
    generatorMetadata: [
      mkGm(100, 2.0, 0.4, 0), // 50 tok/s
      mkGm(104, 2.0, 0.5, 1), // 52 tok/s
      mkGm(96, 2.0, 0.6, 2),  // 48 tok/s
      mkGm(102, 2.0, 5.0, 3), // 51 tok/s (TTFT spike)
      mkGm(98, 2.0, 0.5, 4),  // 49 tok/s
      mkGm(1200, 1.5, 0.5, 5), // 800 tok/s sustained >= 1s -> MUST stay ok!
      mkGm(40, 0.1, 3.0, 6),  // tool-only short window (ttft/dur=30) -> buffered
      mkGm(80, 0.15, 4.0, 7), // non-tool short burst (ttft/dur=26.7) -> buffered
    ],
  };

  const info = usageCore.analyzeActiveConversation(traj);
  assert.equal(info.qualifiedSpeedCalls, 6);
  assert.equal(info.quarantinedSpeedCalls, 2);
  assert.equal(info.callList[5].rateStatus, 'ok');
  assert.equal(info.callList[5].rateOutlier, true);
  assert.equal(info.callList[6].rateStatus, 'buffered');
  assert.ok(info.callList[6].rateReasons.includes('short-tool-window'));
  assert.equal(info.callList[7].rateStatus, 'buffered');
  assert.ok(info.callList[7].rateReasons.includes('short-burst'));
  // Last call was buffered: lastSpeed masked to 0 while displaySpeed falls back to latest qualified (800)
  assert.equal(info.lastRateStatus, 'buffered');
  assert.equal(info.lastSpeed, 0);
  assert.equal(info.displaySpeed, 800);
  assert.ok(info.e2eSpeed > 0 && info.e2eSpeed < info.avgSpeed);
  // TTFT P50 resists the 5s / 4s / 3s spikes (median of [0.4, 0.5, 0.5, 0.5, 0.6, 3.0, 4.0, 5.0] = 0.55)
  assert.ok(Math.abs(info.ttftMedian - 0.55) < 1e-6);
});

test('usage-core & quota-tracker: handles flat/nested remainingFraction, true 0 vs null, and isolated Argon weekly bucket', () => {
  const nestedQuota = {
    response: {
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            { bucketId: 'gemini-5h', remaining: { remainingFraction: 0.72 } },
            { bucketId: 'gemini-weekly', remainingFraction: 0 }, // true 0 must stay 0%, not null
          ],
        },
        {
          displayName: 'Gemini 4 Argon',
          buckets: [{ bucketId: 'gemini-argon-wtu-weekly', remaining: { remainingFraction: 0.35 } }],
        },
        {
          displayName: 'UnknownEmpty',
          buckets: [{ bucketId: '3p-weekly', remainingFraction: null }],
        },
      ],
    },
  };

  const norm = usageCore.normalizeQuotaData(nestedQuota, null, null, 'zh-CN');
  const gem = norm.groups.find((g) => g.name === 'Gemini');
  const argon = norm.groups.find((g) => g.name === 'Gemini 4 Argon');
  const empty = norm.groups.find((g) => g.name === 'UnknownEmpty');
  assert.equal(gem.b5h.remainingPct, 72);
  assert.equal(gem.bWeek.remainingPct, 0);
  assert.equal(gem.effectiveRemainingPct, 0);
  assert.equal(argon.bWeek.remainingPct, 35);
  assert.equal(argon.b5h, null);
  assert.equal(empty.effectiveRemainingPct, null);

  // Legacy flat buckets array keeps Argon weekly separate from Gemini weekly
  const flatPayload = {
    buckets: [
      { bucketId: 'gemini-weekly', remainingFraction: 0.9 },
      { bucketId: 'gemini-argon-wtu-weekly', remainingFraction: 0.25 },
    ],
  };
  const flatNorm = usageCore.normalizeQuotaData(flatPayload, null, null, 'zh-CN');
  assert.equal(flatNorm.groups.length, 2);
  assert.equal(flatNorm.groups.find((g) => g.name === 'Gemini 4 Argon').bWeek.remainingPct, 25);

  const pools = qt.extractWeeklyPools(flatPayload);
  assert.equal(pools.length, 2);
  assert.equal(pools.find((p) => p.bucketId === 'gemini-argon-wtu-weekly').remainingPct, 25);
});

test('telemetry-db: bounded streaming reader handles oversized lines, extracts streamMs/P50/TPS, and computes modelsBreakdown', () => {
  const t = mkTmp('agy-cs-tele-');
  try {
    const file = join(t.dir, 'transcript.jsonl');
    const nowIso = new Date().toISOString();
    const hugeBody = 'A'.repeat(400 * 1024);
    const lines = [
      JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>测试大日志流式投影</USER_REQUEST>' }),
      // Oversized > 256 KiB single line with token fields AFTER huge content
      `{"type":"PLANNER_RESPONSE","step_index":1,"created_at":"${nowIso}","model":"gemini-4-neon","content":"${hugeBody}","input_tokens":2000,"cache_read_tokens":8000,"output_tokens":400,"ttft_ms":500,"streaming_duration_ms":2000}`,
      // Normal line with high TTFT outlier + short window (< 1s, quarantined from TPS)
      JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 2, created_at: nowIso, model: 'gemini-4-neon', input_tokens: 1000, cache_read_tokens: 9000, output_tokens: 20, ttft_ms: 9000, streaming_duration_ms: 200 }),
      // Normal line with low TTFT
      JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 3, created_at: nowIso, model: 'gemini-4-neon', input_tokens: 1000, cache_read_tokens: 9000, output_tokens: 300, ttft_ms: 600, streaming_duration_ms: 3000 }),
    ];
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    const rows = telemetry.parseTranscriptFileBounded(file, 'conv-huge', 'local');
    assert.equal(rows.length, 3);
    assert.equal(rows[0].conversationTitle, '测试大日志流式投影');
    assert.equal(rows[0].inputTokens, 10000);
    assert.equal(rows[0].cacheReadTokens, 8000);
    assert.equal(rows[0].outputTokens, 400);
    assert.equal(rows[0].streamMs, 2000);

    const dash = telemetry.queryTelemetryDashboard({
      brainDir: join(t.dir, 'nonexistent'),
      extraRequests: rows,
      range: '7d',
    });
    // P50 of [500, 600, 9000] = 600ms (resists 9000ms outlier, whereas avg is 3367ms)
    assert.equal(dash.summary.medianTtftMs, 600);
    // Weighted decode TPS over qualified rows (400 + 300) / (2 + 3) = 140.0 tok/s (row 2 quarantined)
    assert.equal(dash.summary.decodeTps, 140);
    assert.equal(dash.summary.quarantinedRateCount, 1);
    assert.equal(dash.modelsBreakdown[0].medianTtftMs, 600);
    assert.equal(dash.modelsBreakdown[0].decodeTps, 140);
    assert.equal(dash.modelsBreakdown[0].cacheHitPct, 86.7);

    // Protobuf timing parser preserves parseGenMetadataTtft shape and adds streamMs in parseGenMetadataTiming
    const encV = (n) => {
      const out = [];
      let v = BigInt(n);
      while (v >= 0x80n) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
      out.push(Number(v));
      return Buffer.from(out);
    };
    const fLen = (f, b) => Buffer.concat([encV((f << 3) | 2), encV(b.length), b]);
    const fVar = (f, v) => Buffer.concat([encV((f << 3) | 0), encV(v)]);
    const m1 = Buffer.concat([
      fLen(11, Buffer.concat([fVar(1, 1), fVar(2, 500_000_000)])), // 1500ms ttft
      fLen(12, Buffer.concat([fVar(1, 3), fVar(2, 250_000_000)])), // 3250ms stream
    ]);
    const top = Buffer.concat([fLen(1, m1), fLen(2, encV(5))]);
    assert.deepEqual(telemetry.parseGenMetadataTtft(top), { stepIndices: [5], ttftMs: 1500 });
    assert.deepEqual(telemetry.parseGenMetadataTiming(top), { stepIndices: [5], ttftMs: 1500, streamMs: 3250 });
  } finally {
    t.cleanup();
  }
});

test('ls-discovery: Windows TUN filtering, 2.34+ daemon credential, and automatic RPC recovery on 401', async () => {
  lsDisc.resetLsDiscoveryCache();
  const netstatText = [
    '  TCP    198.18.0.1:41000       198.18.0.2:443         LISTENING       2001',
    '  TCP    127.0.0.1:42000        0.0.0.0:0              LISTENING       2002',
  ].join('\n');
  const snap = lsDisc.parseWindowsNetstat(netstatText);
  assert.equal(snap.ports.has(2001), false);
  assert.ok(snap.rejectedPids.has(2001));
  assert.deepEqual(snap.ports.get(2002), [42000]);

  const fakeRun = async (exe) =>
    exe === 'netstat.exe'
      ? { stdout: netstatText }
      : { stdout: JSON.stringify([{ OwningProcess: 2001, LocalAddress: '127.0.0.1', LocalPort: 43001, RemoteAddress: '0.0.0.0', RemotePort: 0, State: 0 }]) };
  const winPorts = await lsDisc.discoverWindowsPorts([2001, 2002], { run: fakeRun, probe: async () => false });
  assert.deepEqual(winPorts.get(2001), [43001]);

  // Simulate stale token -> 401 -> automatic rediscovery -> retry succeeds with new token
  let attempts = 0;
  const server = http.createServer((req, res) => {
    attempts += 1;
    if (req.headers['x-codeium-csrf-token'] !== 'fresh-token') {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'gemini-weekly', remainingFraction: 0.8 }] }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const data = await qt.fetchLiveQuotaFromLs({
      lsAddress: `127.0.0.1:${port}`,
      csrfToken: 'stale-token',
      discoverFn: async () => ({ lsAddress: `127.0.0.1:${port}`, port, csrfToken: 'fresh-token', pid: process.pid }),
    });
    assert.equal(attempts, 2);
    assert.equal(qt.extractWeeklyPools(data)[0].remainingPct, 80);
  } finally {
    lsDisc.resetLsDiscoveryCache();
    await new Promise((r) => server.close(r));
  }
});

test('sidecar-owner: newer sidecar supersedes older instance and prevents stale quota-daily writes', async () => {
  const t = mkTmp('agy-cs-owner-');
  try {
    const o1 = new SidecarOwner(t.dir, { pid: 1111, startedAt: 1000, token: 'tok-a', intervalMs: 40, aliveCheck: (p) => p === 1111 || p === 2222 });
    assert.equal(await o1.claim(), true);
    assert.equal(o1.owns(), true);

    let lost = false;
    o1.watch(() => { lost = true; });

    const o2 = new SidecarOwner(t.dir, { pid: 2222, startedAt: 2000, token: 'tok-b', aliveCheck: (p) => p === 1111 || p === 2222 });
    assert.equal(await o2.claim(), true);
    assert.equal(o2.owns(), true);

    await new Promise((r) => setTimeout(r, 140));
    assert.equal(lost, true);
    assert.equal(o1.owns(), false);

    // Atomic file write leaves valid JSON and zero leftovers
    const target = join(t.dir, 'quota-daily.json');
    atomicWriteFileSync(target, JSON.stringify({ ok: true }) + '\n');
    assert.equal(existsSync(target), true);
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { ok: true });
    o2.stop();
  } finally {
    t.cleanup();
  }
});
