import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const usageCore = require('../usage-core.js');

test('formatCompactTokens matches expected units and rounding', () => {
  assert.equal(usageCore.formatCompactTokens(0), '0');
  assert.equal(usageCore.formatCompactTokens(949), '949');
  assert.equal(usageCore.formatCompactTokens(1540), '1.5k');
  assert.equal(usageCore.formatCompactTokens(999990), '1M');
  assert.equal(usageCore.formatCompactTokens(647800000), '647.8M');
  assert.equal(usageCore.formatCompactTokens(2500000000), '2.5B');
});

test('formatHomeHour formats AM/PM in zh and en', () => {
  assert.equal(usageCore.formatHomeHour(0, true), '上午 12 点');
  assert.equal(usageCore.formatHomeHour(12, true), '下午 12 点');
  assert.equal(usageCore.formatHomeHour(15, true), '下午 3 点');
  assert.equal(usageCore.formatHomeHour(0, false), '12 AM');
  assert.equal(usageCore.formatHomeHour(14, false), '2 PM');
});

test('analyzeTrajectoryForUsage extracts calls, days, hours, models, and retryInfos fallback', () => {
  const t0 = Math.floor(new Date(2026, 10, 10, 14, 15, 0).getTime() / 1000);
  const t1 = Math.floor(new Date(2026, 10, 11, 9, 30, 0).getTime() / 1000);
  const traj = {
    trajectory: {
      steps: [
        { metadata: { createdAt: { seconds: String(t0), nanos: 0 } } },
        { metadata: { createdAt: { seconds: String(t1), nanos: 0 } } },
      ],
      generatorMetadata: [
        {
          stepIndices: [0],
          metadata: {
            value: {
              modelDisplayName: 'Gemini 4 Argon (High)',
              usage: { inputTokens: '1000', cacheReadTokens: '4000', outputTokens: '500' },
            },
          },
        },
        {
          stepIndices: [1],
          metadata: {
            value: {
              responseModel: 'claude-opus-5.5',
              retryInfos: [
                { usage: { inputTokens: '100', outputTokens: '10' } },
                { usage: { inputTokens: '2000', cacheReadTokens: '8000', cacheWriteTokens: '500', outputTokens: '1000' } },
              ],
            },
          },
        },
      ],
    },
  };
  const rec = usageCore.analyzeTrajectoryForUsage(traj, { stepCount: 2, lastModifiedTime: { seconds: String(t1) } }, 'c1');
  assert.equal(rec.cascadeId, 'c1');
  assert.equal(rec.subagent, false);
  assert.equal(rec.calls, 2);
  assert.equal(rec.days['2026-11-10'].total, 5500);
  assert.equal(rec.days['2026-11-10'].hours[14], 1);
  assert.equal(rec.days['2026-11-11'].total, 11500);
  assert.equal(rec.days['2026-11-11'].hours[9], 1);
  assert.equal(rec.days['2026-11-11'].models['claude-opus-5.5'].total, 11500);
});

test('aggregateUsageRollup excludes subagents from sessions, filters ranges, and picks book yardstick', () => {
  const now = new Date(2026, 10, 14, 12, 0, 0);
  const dToday = usageCore.homeDayKey(now);
  const d10 = usageCore.homeDayKey(new Date(2026, 10, 4, 12, 0, 0));
  const d45 = usageCore.homeDayKey(new Date(2026, 8, 25, 12, 0, 0));

  const records = [
    {
      cascadeId: 'main-1',
      subagent: false,
      days: {
        [dToday]: {
          calls: 3,
          input: 10000,
          output: 2000,
          cacheRead: 30000,
          cacheWrite: 0,
          total: 42000,
          hours: (() => { const a = new Array(24).fill(0); a[15] = 3; return a; })(),
          models: { 'Gemini 4 Argon': { input: 10000, output: 2000, cacheRead: 30000, cacheWrite: 0, total: 42000, calls: 3 } },
        },
        [d45]: {
          calls: 1,
          input: 5000,
          output: 1000,
          cacheRead: 0,
          cacheWrite: 0,
          total: 6000,
          hours: (() => { const a = new Array(24).fill(0); a[8] = 1; return a; })(),
          models: { 'Claude Opus': { input: 5000, output: 1000, cacheRead: 0, cacheWrite: 0, total: 6000, calls: 1 } },
        },
      },
    },
    {
      cascadeId: 'sub-1',
      subagent: true,
      days: {
        [d10]: {
          calls: 2,
          input: 8000,
          output: 2000,
          cacheRead: 0,
          cacheWrite: 0,
          total: 10000,
          hours: (() => { const a = new Array(24).fill(0); a[15] = 2; return a; })(),
          models: { 'Gemini 4 Argon': { input: 8000, output: 2000, cacheRead: 0, cacheWrite: 0, total: 10000, calls: 2 } },
        },
      },
    },
  ];

  const all = usageCore.aggregateUsageRollup(records, 'all', 0.0, true, now);
  assert.equal(all.sessions, 1); // sub-1 excluded!
  assert.equal(all.calls, 6);
  assert.equal(all.tokens, 58000);
  assert.equal(all.activeDays, 3);
  assert.equal(all.peakHour, '下午 3 点');
  assert.equal(all.model, 'Gemini 4 Argon');
  assert.match(all.funBook, /《道德经》/);

  const seven = usageCore.aggregateUsageRollup(records, '7d', 0.0, true, now);
  assert.equal(seven.sessions, 1);
  assert.equal(seven.calls, 3);
  assert.equal(seven.tokens, 42000);
  assert.equal(seven.activeDays, 1);

  const thirty = usageCore.aggregateUsageRollup(records, '30d', 0.0, false, now);
  assert.equal(thirty.tokens, 52000);
  assert.equal(thirty.activeDays, 2);
});

test('homeHeatGrid produces Sunday-aligned 26+ week cells with levels 0..5', () => {
  const now = new Date(2026, 10, 14, 12, 0, 0); // Saturday
  const dToday = usageCore.homeDayKey(now);
  const dPrev = usageCore.homeDayKey(new Date(2026, 10, 13, 12, 0, 0));
  const grid = usageCore.homeHeatGrid({ [dToday]: 10000, [dPrev]: 1500 }, now);
  assert.ok(grid.cells.length >= 26 * 7);
  assert.equal(grid.cells[0].date.length, 10);
  const last = grid.cells[grid.cells.length - 1];
  assert.equal(last.date, dToday);
  assert.equal(last.level, 5);
  const prevCell = grid.cells.find((c) => c.date === dPrev);
  assert.equal(prevCell.level, 1);
});

test('homeChartTicks never produce overlapping labels', () => {
  const widths = new Array(30).fill(42);
  const ticks = usageCore.homeChartTicks(widths, 420, 8, 2);
  assert.ok(ticks.length >= 1);
  assert.equal(ticks[ticks.length - 1].index, 29);
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i - 1].left + widths[ticks[i - 1].index] + 8 <= ticks[i].left);
  }
});

test('analyzeActiveConversation handles empty and populated trajectories', () => {
  const empty = usageCore.analyzeActiveConversation(null);
  assert.equal(empty.calls, 0);
  assert.equal(empty.contextUsed, 0);
  assert.equal(empty.isRunning, false);

  const traj = {
    steps: [
      { status: 3, step: { case: 'userInput' } },
      { status: 1, step: { case: 'plannerResponse', value: {} } },
    ],
    generatorMetadata: [
      {
        metadata: {
          value: {
            usage: { inputTokens: '2000', cacheReadTokens: '18000', outputTokens: '500', thinkingOutputTokens: '100' },
            streamingDuration: { seconds: '1', nanos: 0 },
            timeToFirstToken: { seconds: '0', nanos: 500000000 },
            chatStartMetadata: {
              contextWindowMetadata: {
                estimatedTokensUsed: 50000,
                maxContextTokens: 256000,
                tokenBreakdown: {
                  groups: [
                    { type: 1, name: 'System', numTokens: 10000 },
                    { type: 2, name: 'Tools', numTokens: 5000 },
                    { type: 7, name: 'Chat', numTokens: 35000 },
                  ],
                },
              },
            },
          },
        },
      },
    ],
  };
  const info = usageCore.analyzeActiveConversation(traj);
  assert.equal(info.calls, 1);
  assert.equal(info.steps, 2);
  assert.equal(info.contextUsed, 50000);
  assert.equal(info.sysTokens, 10000);
  assert.equal(info.toolsTokens, 5000);
  assert.equal(info.msgTokens, 35000);
  assert.equal(info.cacheHitPct, 90);
  assert.equal(info.lastSpeed, 500);
  assert.equal(info.isRunning, true);
  assert.equal(info.isThinking, true);
});

test('computeRingTelemetry calculates remaining percentage, color thresholds, draft deduction, and quota mode', () => {
  // 1. > 30% remaining -> ok (#257de0)
  const okRing = usageCore.computeRingTelemetry({
    activeInfo: { contextUsed: 51500, maxContextTokens: 256000 },
    draftTokens: 0,
    ringMode: 'context',
  });
  assert.equal(okRing.mode, 'context');
  assert.equal(okRing.remainingTokens, 204500);
  assert.equal(okRing.pctRound, 80);
  assert.equal(okRing.level, 'ok');
  assert.equal(okRing.color, '#257de0');

  // 2. <= 30% remaining -> warn (#fbb315)
  const warnRing = usageCore.computeRingTelemetry({
    activeInfo: { contextUsed: 185000, maxContextTokens: 256000 },
    draftTokens: 5000,
    ringMode: 'context',
  });
  assert.equal(warnRing.usedTokens, 190000);
  assert.equal(warnRing.remainingTokens, 66000);
  assert.equal(warnRing.pctRound, 26);
  assert.equal(warnRing.level, 'warn');
  assert.equal(warnRing.color, '#fbb315');

  // 3. <= 10% remaining -> danger (#dc3c3d)
  const dangerRing = usageCore.computeRingTelemetry({
    activeInfo: { contextUsed: 240000, maxContextTokens: 256000 },
    draftTokens: 0,
    ringMode: 'context',
  });
  assert.equal(dangerRing.pctRound, 6);
  assert.equal(dangerRing.level, 'danger');
  assert.equal(dangerRing.color, '#dc3c3d');

  // 4. Quota mode with valid quotaInfo vs fallback when quotaInfo is null
  const quotaRing = usageCore.computeRingTelemetry({
    activeInfo: { contextUsed: 50000, maxContextTokens: 256000 },
    quotaInfo: { effectiveRemainingPct: 71.3 },
    ringMode: 'quota',
  });
  assert.equal(quotaRing.mode, 'quota');
  assert.equal(quotaRing.pctRound, 71);
  assert.equal(quotaRing.color, '#257de0');

  const fallbackRing = usageCore.computeRingTelemetry({
    activeInfo: { contextUsed: 128000, maxContextTokens: 256000 },
    quotaInfo: null,
    ringMode: 'quota',
  });
  assert.equal(fallbackRing.mode, 'context');
  assert.equal(fallbackRing.pctRound, 50);
});

test('estimateTextTokens, normalizeQuotaData, and getActiveQuotaInfo handle CJK, code, and model pools', () => {
  assert.equal(usageCore.estimateTextTokens('').tokens, 0);
  const est = usageCore.estimateTextTokens('把右下角的圆环改成显示用量剩余 const x = 42;');
  assert.ok(est.tokens > 5);
  assert.ok(est.cjk >= 10);

  const qData = usageCore.normalizeQuotaData(
    null,
    {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              label: 'Gemini 4 Argon (High)',
              quotaInfo: { remainingFraction: 0.75, resetTime: { seconds: String(Math.floor(Date.now() / 1000) + 3600) } },
            },
            {
              label: 'Claude Opus 5.5 (High)',
              quotaInfo: { remainingFraction: 0.2, resetTime: { seconds: String(Math.floor(Date.now() / 1000) + 7200) } },
            },
          ],
        },
      },
    }
  );
  assert.ok(qData.groups.length >= 2);
  const activeArgon = usageCore.getActiveQuotaInfo(qData, 'Gemini 4 Argon (High)');
  assert.ok(activeArgon);
  assert.equal(Math.round(activeArgon.effectiveRemainingPct), 75);
});

test('analyzeActiveConversation splits chatMsgTokens and toolResultsTokens without double-counting and attaches subagent telemetry', () => {
  const traj = {
    steps: [
      { status: 3, metadata: { createdAt: { seconds: '1700000000' } }, step: { case: 'userInput', value: { query: 'Inspect files' } } },
      { status: 3, metadata: { createdAt: { seconds: '1700000005' }, toolCall: { name: 'read_file' } }, step: { case: 'generic', value: {} } },
      { status: 3, metadata: { createdAt: { seconds: '1700000010' } }, step: { case: 'plannerResponse', value: { response: 'Done' } } },
    ],
    generatorMetadata: [
      {
        stepIndices: [0, 1, 2],
        metadata: {
          value: {
            modelDisplayName: 'Gemini 4 Argon (High)',
            usage: { inputTokens: '4000', cacheReadTokens: '124000', outputTokens: '500', thinkingOutputTokens: '100' },
            chatStartMetadata: {
              contextWindowMetadata: {
                estimatedTokensUsed: 131200,
                maxContextTokens: 256000,
                tokenBreakdown: {
                  groups: [
                    { type: 1, name: 'System', numTokens: 11900, children: [{ name: 'SYSTEM_PROMPT', numTokens: 11900 }] },
                    { type: 2, name: 'Tools', numTokens: 8200, children: [{ name: 'read_file', numTokens: 8200 }] },
                    {
                      type: 7,
                      name: 'Messages',
                      numTokens: 111100,
                      children: [
                        { name: '0: USER_INPUT', numTokens: 12000 },
                        { name: '1: GENERIC', numTokens: 89200 },
                        { name: '2: PLANNER_RESPONSE', numTokens: 9900 },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ],
  };

  const info = usageCore.analyzeActiveConversation(traj, {
    cascadeId: 'parent-1',
    subagents: [
      {
        id: 'sub-abc12345',
        parentId: 'parent-1',
        rootId: 'parent-1',
        status: 1,
        createdAtSec: 1700000006,
        analysis: {
          totalCalls: 4,
          totalSteps: 12,
          totalTokens: 45000,
          totalOutput: 2100,
          contextUsed: 18000,
          lastModel: 'Gemini 4 Argon (High)',
          toolBreakdown: [{ name: 'run_command', count: 3, tokens: 4000 }],
        },
      },
    ],
  });

  // Verify no double counting: sys + tools + chatMsgTokens + toolResultsTokens === contextUsed
  assert.equal(info.sysTokens, 11900);
  assert.equal(info.toolsTokens, 8200);
  assert.equal(info.msgTokens, 111100);
  assert.equal(info.toolResultsTokens, 89200);
  assert.equal(info.chatMsgTokens, 21900);
  assert.equal(info.sysTokens + info.toolsTokens + info.chatMsgTokens + info.toolResultsTokens, 131200);

  // Verify subagent aggregation and per-turn attribution
  assert.equal(info.subagentCount, 1);
  assert.equal(info.subagentCalls, 4);
  assert.equal(info.subagentTokens, 45000);
  assert.equal(info.turnDetails.length, 1);
  assert.equal(info.turnDetails[0].toolCalls, 1);
  assert.equal(info.turnDetails[0].subagentCount, 1);
  assert.equal(info.turnDetails[0].subagentCalls, 4);
  assert.equal(info.turnDetails[0].subagentTokens, 45000);
});

test('analyzeActiveConversation exposes liveTokens and liveSpeed during Turn 1 before generatorMetadata completes', () => {
  const traj = {
    steps: [
      { status: 3, step: { case: 'userInput', value: { query: 'Hello' } } },
      {
        status: 1,
        metadata: { viewableAt: { seconds: '1000', nanos: 0 }, modelUsage: { outputTokens: '42' } },
        step: { case: 'plannerResponse', value: { thinking: 'Analyzing the workspace files carefully...', response: '' } },
      },
    ],
    generatorMetadata: [],
  };
  const info = usageCore.analyzeActiveConversation(traj, { cascadeId: 'new-c1', nowSec: 1002 });
  assert.equal(info.calls, 0);
  assert.equal(info.steps, 2);
  assert.equal(info.totalTokens, 0);
  assert.equal(info.isRunning, true);
  assert.equal(info.isThinking, true);
  assert.equal(info.liveTokens, 42);
  assert.equal(info.liveSpeed, 21);
  assert.equal(info.displaySpeed, 21);
});

test('getActiveQuotaInfo prioritizes Argon and Claude/GPT before matching specific or default Gemini groups', () => {
  const quota = {
    groups: [
      { name: 'Gemini', buckets: [{ window: '5h', disabled: false, remainingPct: 60 }] },
      { name: 'Gemini 4 Argon', buckets: [{ window: '5h', disabled: false, remainingPct: 25 }] },
      { name: 'Gemini 3.8 Flash', buckets: [{ window: '5h', disabled: false, remainingPct: 90 }] },
      { name: 'Claude / GPT', buckets: [{ window: 'weekly', disabled: false, remainingPct: 40 }] },
    ],
    modelConfigs: [],
  };
  assert.equal(usageCore.getActiveQuotaInfo(quota, 'Gemini 4 Argon (High)')?.groupName, 'Gemini 4 Argon');
  assert.equal(usageCore.getActiveQuotaInfo(quota, 'Gemini 3.8 Flash (Low)')?.groupName, 'Gemini 3.8 Flash');
  assert.equal(usageCore.getActiveQuotaInfo(quota, 'Gemini 4 Hydrogen Extra')?.groupName, 'Gemini');
  assert.equal(usageCore.getActiveQuotaInfo(quota, 'Claude Opus 5.5')?.groupName, 'Claude / GPT');
});
