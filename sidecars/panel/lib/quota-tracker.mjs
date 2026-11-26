// Daily Weekly-Quota Consumption Tracker for AGY Claude Style Aux Pane Dashboard.
// Polls Antigravity Language Server RetrieveUserQuotaSummary (loopback HTTP, bypassing proxy/bad-ports),
// persists compact daily snapshots in ~/.gemini/antigravity/plugin_data/agy-claude-style/quota-daily.json,
// and computes exact per-pool daily weekly-quota burn (resilient to mid-day weekly resets).
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from './sidecar-owner.mjs';
import { callLsRpcWithRecovery } from './ls-discovery.mjs';

const MAX_STORED_DAYS = 90;
const MIN_DROP_PCT = 0.05;
const FULL_RESET_MIN_PREV_PCT = 90.0;
const FULL_RESET_TARGET_PCT = 99.5;

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

export function formatLocalDate(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseResetEpochSec(resetTime) {
  if (!resetTime) return 0;
  if (typeof resetTime === 'number' && Number.isFinite(resetTime)) {
    return resetTime > 1e12 ? Math.floor(resetTime / 1000) : Math.floor(resetTime);
  }
  if (typeof resetTime === 'object') {
    const sec = Number(resetTime.seconds ?? resetTime.sec ?? 0);
    if (Number.isFinite(sec) && sec > 0) return Math.floor(sec);
    return 0;
  }
  const ms = Date.parse(String(resetTime));
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
}

export function formatResetCountdown(resetSec, nowMs = Date.now()) {
  if (!resetSec || resetSec <= 0) return '';
  const diffSec = Math.max(0, Math.floor(resetSec - nowMs / 1000));
  if (diffSec <= 0) return '即将重置';
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  if (days > 0) return `${days}天${hours > 0 ? `${hours}小时` : ''}`;
  if (hours > 0) return `${hours}小时${mins > 0 ? `${mins}分` : ''}`;
  return `${Math.max(1, mins)}分钟`;
}

function extractRemainingFraction(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const flat = bucket.remainingFraction ?? bucket.remaining_fraction;
  if (flat !== undefined && flat !== null && flat !== '' && Number.isFinite(Number(flat))) {
    return Number(flat);
  }
  if (bucket.remaining?.case === 'remainingFraction') {
    const val = bucket.remaining.value;
    if (val !== undefined && val !== null && val !== '' && Number.isFinite(Number(val))) {
      return Number(val);
    }
  }
  const nested = bucket.remaining?.remainingFraction ?? bucket.remaining?.remaining_fraction;
  if (nested !== undefined && nested !== null && nested !== '' && Number.isFinite(Number(nested))) {
    return Number(nested);
  }
  return null;
}

function resolveBucketRemainingPct(bucket) {
  const frac = extractRemainingFraction(bucket);
  if (frac !== null) return round1(Math.max(0, Math.min(100, frac * 100)));
  if (typeof bucket?.remainingPct === 'number' && Number.isFinite(bucket.remainingPct)) {
    return round1(Math.max(0, Math.min(100, bucket.remainingPct)));
  }
  return null;
}

export function extractWeeklyPools(quotaJson) {
  const root = quotaJson?.response && typeof quotaJson.response === 'object' ? quotaJson.response : quotaJson;
  const rawGroups = root?.groups || [];
  const pools = [];
  const seenNames = new Set();

  if (Array.isArray(rawGroups)) {
    for (const g of rawGroups) {
      if (!g || typeof g !== 'object') continue;
      const name = String(g.displayName || g.name || '').trim();
      if (!name) continue;
      const buckets = Array.isArray(g.buckets) ? g.buckets : [];
      const weekly =
        buckets.find((b) => String(b?.window || '').toLowerCase() === 'weekly' && !b?.disabled) ||
        buckets.find((b) => /weekly/i.test(String(b?.bucketId || b?.bucket_id || '')) && !b?.disabled) ||
        buckets.find((b) => String(b?.window || '').toLowerCase() === 'weekly') ||
        buckets.find((b) => /weekly/i.test(String(b?.bucketId || b?.bucket_id || ''))) ||
        buckets.find((b) => String(b?.window || '').toLowerCase() !== '5h' && !/5h/i.test(String(b?.bucketId || b?.bucket_id || '')) && !b?.disabled) ||
        null;
      if (!weekly) continue;
      const remainingPct = resolveBucketRemainingPct(weekly);
      if (remainingPct === null) continue;
      const resetSec = parseResetEpochSec(weekly.resetTime ?? weekly.reset_time ?? weekly.remaining?.resetTime);
      seenNames.add(name);
      pools.push({
        name,
        bucketId: String(weekly.bucketId || weekly.bucket_id || ''),
        remainingPct,
        resetSec,
        disabled: Boolean(weekly.disabled),
      });
    }
  }

  // Fallback for legacy flat bucket lists without conflating Argon weekly and Gemini weekly.
  const flatBuckets = Array.isArray(root?.buckets) ? root.buckets : [];
  for (const b of flatBuckets) {
    if (!b || typeof b !== 'object') continue;
    const bid = String(b.bucketId || b.bucket_id || b.id || '').trim();
    const win = String(b.window || '').toLowerCase();
    const isWeekly = win === 'weekly' || /weekly/i.test(bid);
    if (!isWeekly) continue;
    const remainingPct = resolveBucketRemainingPct(b);
    if (remainingPct === null) continue;
    const name =
      String(b.displayName || b.display_name || '').trim() ||
      (bid === 'gemini-argon-wtu-weekly'
        ? 'Gemini 4 Argon'
        : bid === 'gemini-weekly'
        ? 'Gemini'
        : bid === '3p-weekly'
        ? 'Claude / 3p'
        : bid);
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);
    pools.push({
      name,
      bucketId: bid,
      remainingPct,
      resetSec: parseResetEpochSec(b.resetTime ?? b.reset_time ?? b.remaining?.resetTime),
      disabled: Boolean(b.disabled),
    });
  }

  return pools;
}

export function createEmptyStore() {
  return { version: 1, days: {} };
}

function findLatestPriorPool(store, todayKey, poolName) {
  const dates = Object.keys(store.days || {}).filter((d) => d < todayKey).sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const rec = store.days[dates[i]]?.[poolName];
    if (rec && typeof rec.lastPct === 'number') return rec;
  }
  return null;
}

export function recordQuotaSample(store, pools = [], nowMs = Date.now()) {
  const target = store && typeof store === 'object' && store.days ? store : createEmptyStore();
  if (!Array.isArray(pools) || pools.length === 0) return { store: target, changed: false };

  const todayKey = formatLocalDate(nowMs);
  if (!target.days[todayKey]) target.days[todayKey] = {};
  const dayRec = target.days[todayKey];
  let changed = false;

  for (const pool of pools) {
    if (!pool || !pool.name || typeof pool.remainingPct !== 'number') continue;
    const curPct = round1(Math.max(0, Math.min(100, pool.remainingPct)));
    const curResetSec = Number(pool.resetSec || 0);
    const existing = dayRec[pool.name];

    if (!existing) {
      const prior = findLatestPriorPool(target, todayKey, pool.name);
      const sameCycle =
        prior &&
        prior.resetSec > 0 &&
        curResetSec > 0 &&
        Math.abs(prior.resetSec - curResetSec) <= 3600;
      const canCarryOver = Boolean(sameCycle && prior.lastPct >= curPct);
      const initialConsumed = canCarryOver && prior.lastPct - curPct >= MIN_DROP_PCT
        ? round1(prior.lastPct - curPct)
        : 0;
      dayRec[pool.name] = {
        firstPct: canCarryOver ? prior.lastPct : curPct,
        cycleStartPct: canCarryOver ? prior.lastPct : curPct,
        priorCyclesBurnPct: 0,
        lastPct: curPct,
        consumedPct: initialConsumed,
        resetSec: curResetSec,
        firstAtMs: nowMs,
        lastAtMs: nowMs,
        sampleCount: 1,
        carriedFromPrior: canCarryOver,
      };
      changed = true;
      continue;
    }

    const prevPct = Number(existing.lastPct);
    const prevResetSec = Number(existing.resetSec || 0);
    // Backfill cycle fields for legacy records written before cycleStartPct existed
    if (typeof existing.cycleStartPct !== 'number') {
      existing.cycleStartPct = typeof existing.firstPct === 'number' ? existing.firstPct : prevPct;
    }
    if (typeof existing.priorCyclesBurnPct !== 'number') {
      existing.priorCyclesBurnPct = 0;
    }

    const resetAdvanced = prevResetSec > 0 && curResetSec > prevResetSec + 3600;
    const jumpedToFull = prevPct <= FULL_RESET_MIN_PREV_PCT && curPct >= FULL_RESET_TARGET_PCT;

    if (resetAdvanced || jumpedToFull) {
      // True mid-day weekly quota reset: lock previous cycle's net burn and start new cycle at 100%.
      const prevCycleBurn = Math.max(0, round1(existing.cycleStartPct - prevPct));
      existing.priorCyclesBurnPct = round1(existing.priorCyclesBurnPct + prevCycleBurn);
      existing.cycleStartPct = 100;
      const postResetBurn = curPct < 100 - MIN_DROP_PCT ? round1(100 - curPct) : 0;
      existing.consumedPct = round1(existing.priorCyclesBurnPct + postResetBurn);
      existing.lastPct = curPct;
      if (curResetSec > 0) existing.resetSec = curResetSec;
      else if (jumpedToFull) existing.resetSec = 0;
      existing.lastAtMs = nowMs;
      existing.sampleCount = (existing.sampleCount || 0) + 1;
      changed = true;
    } else {
      // Same weekly cycle: use true net burn (cycleStartPct - curPct) so reservation dips & refunds
      // or slight upward jitter never double-count consumption.
      if (curPct > existing.cycleStartPct) {
        // Quota recovered slightly above initial baseline in the same cycle (e.g. rolling expiry or initial dip)
        existing.cycleStartPct = curPct;
      }
      const nextCycleBurn = existing.cycleStartPct - curPct >= MIN_DROP_PCT
        ? round1(existing.cycleStartPct - curPct)
        : 0;
      const nextConsumed = round1(existing.priorCyclesBurnPct + nextCycleBurn);
      const pctChanged = Math.abs(curPct - prevPct) >= MIN_DROP_PCT;
      const resetChanged = curResetSec > 0 && curResetSec !== prevResetSec;
      const consumedChanged = Math.abs(nextConsumed - Number(existing.consumedPct || 0)) >= MIN_DROP_PCT;
      if (pctChanged || resetChanged || consumedChanged) {
        existing.consumedPct = nextConsumed;
        existing.lastPct = curPct;
        if (curResetSec > 0) existing.resetSec = curResetSec;
        existing.lastAtMs = nowMs;
        if (pctChanged) existing.sampleCount = (existing.sampleCount || 0) + 1;
        changed = true;
      }
    }
  }

  // Prune oldest days beyond retention limit
  const allDates = Object.keys(target.days).sort();
  if (allDates.length > MAX_STORED_DAYS) {
    for (const oldDate of allDates.slice(0, allDates.length - MAX_STORED_DAYS)) {
      delete target.days[oldDate];
      changed = true;
    }
  }

  return { store: target, changed };
}

export function summarizeWeeklyQuota(store, livePools = [], nowMs = Date.now()) {
  const todayKey = formatLocalDate(nowMs);
  const days = store?.days || {};
  const todayRec = days[todayKey] || {};

  const poolMap = new Map();
  for (const p of livePools || []) {
    if (!p?.name) continue;
    const rec = todayRec[p.name];
    poolMap.set(p.name, {
      name: p.name,
      remainingPct: p.remainingPct,
      consumedTodayPct: rec ? round1(rec.consumedPct || 0) : 0,
      firstPct: rec ? rec.firstPct : p.remainingPct,
      resetSec: p.resetSec || rec?.resetSec || 0,
      resetIn: formatResetCountdown(p.resetSec || rec?.resetSec || 0, nowMs),
      sampleCount: rec?.sampleCount || 0,
      carriedFromPrior: Boolean(rec?.carriedFromPrior),
    });
  }
  for (const [name, rec] of Object.entries(todayRec)) {
    if (poolMap.has(name)) continue;
    poolMap.set(name, {
      name,
      remainingPct: rec.lastPct,
      consumedTodayPct: round1(rec.consumedPct || 0),
      firstPct: rec.firstPct,
      resetSec: rec.resetSec || 0,
      resetIn: formatResetCountdown(rec.resetSec || 0, nowMs),
      sampleCount: rec.sampleCount || 0,
      carriedFromPrior: Boolean(rec.carriedFromPrior),
    });
  }

  const pools = [...poolMap.values()];
  const byDate = {};
  for (const [dateKey, perPool] of Object.entries(days)) {
    const entries = Object.entries(perPool || {}).map(([name, rec]) => ({
      name,
      consumedPct: round1(rec?.consumedPct || 0),
      lastPct: typeof rec?.lastPct === 'number' ? round1(rec.lastPct) : null,
    }));
    if (entries.length === 0) continue;
    const maxConsumedPct = entries.reduce((mx, e) => Math.max(mx, e.consumedPct), 0);
    byDate[dateKey] = {
      pools: entries,
      maxConsumedPct: round1(maxConsumedPct),
    };
  }

  const totalConsumedPct = round1(pools.reduce((sum, p) => sum + (p.consumedTodayPct || 0), 0));
  const maxConsumedPct = round1(pools.reduce((mx, p) => Math.max(mx, p.consumedTodayPct || 0), 0));
  return {
    available: pools.length > 0,
    date: todayKey,
    pools,
    totalConsumedPct,
    maxConsumedPct,
    byDate,
  };
}

export async function fetchLiveQuotaFromLs({
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS,
  csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN,
  timeoutMs = 2500,
  forceRefresh = false,
  allowRediscover = true,
  discoverFn,
  requestFn,
} = {}) {
  const res = await callLsRpcWithRecovery(
    'exa.language_server_pb.LanguageServerService',
    'RetrieveUserQuotaSummary',
    forceRefresh ? { forceRefresh: true } : {},
    {
      lsAddress,
      csrfToken,
      timeoutMs,
      allowRediscover,
      ...(discoverFn ? { discoverFn } : {}),
      ...(requestFn ? { requestFn } : {}),
    }
  );
  return res?.ok ? res.data : null;
}

function loadStoreFromDisk(filePath) {
  try {
    if (!filePath || !existsSync(filePath)) return createEmptyStore();
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
      return parsed;
    }
  } catch {}
  return createEmptyStore();
}

function saveStoreToDisk(filePath, store, { ownsFn = null } = {}) {
  if (!filePath) return;
  if (typeof ownsFn === 'function' && !ownsFn()) return;
  try {
    atomicWriteFileSync(filePath, JSON.stringify(store, null, 2) + '\n');
  } catch {}
}

export function createQuotaTracker({
  filePath = '',
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS,
  csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN,
  minIntervalMs = 15_000,
  ownsFn = null,
  allowRediscover = true,
} = {}) {
  let store = loadStoreFromDisk(filePath);
  let lastLivePools = [];
  let lastFetchMs = 0;
  let inflight = null;

  async function sampleNow({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - lastFetchMs < minIntervalMs && lastLivePools.length > 0) {
      return summarizeWeeklyQuota(store, lastLivePools, now);
    }
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const raw = await fetchLiveQuotaFromLs({
          lsAddress,
          csrfToken,
          forceRefresh: Boolean(force),
          allowRediscover,
        });
        const pools = extractWeeklyPools(raw);
        if (pools.length > 0) {
          lastLivePools = pools;
          lastFetchMs = Date.now();
          const res = recordQuotaSample(store, pools, lastFetchMs);
          store = res.store;
          if (res.changed) saveStoreToDisk(filePath, store, { ownsFn });
        }
      } catch {} finally {
        inflight = null;
      }
      return summarizeWeeklyQuota(store, lastLivePools, Date.now());
    })();
    return inflight;
  }

  function getSummary(nowMs = Date.now()) {
    return summarizeWeeklyQuota(store, lastLivePools, nowMs);
  }

  return { sampleNow, getSummary };
}
