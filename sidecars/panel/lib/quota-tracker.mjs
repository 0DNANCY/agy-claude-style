// Daily Weekly-Quota Consumption Tracker for AGY Claude Style Aux Pane Dashboard.
// Polls Antigravity Language Server RetrieveUserQuotaSummary (loopback HTTP, bypassing proxy/bad-ports),
// persists compact daily snapshots in ~/.gemini/antigravity/plugin_data/agy-claude-style/quota-daily.json,
// and computes exact per-pool daily weekly-quota burn (resilient to mid-day weekly resets).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname } from 'node:path';

const MAX_STORED_DAYS = 90;
const MIN_DROP_PCT = 0.05;
const RESET_JUMP_PCT = 3.0;

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

export function extractWeeklyPools(quotaJson) {
  const rawGroups = quotaJson?.response?.groups || quotaJson?.groups || [];
  if (!Array.isArray(rawGroups)) return [];
  const pools = [];
  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue;
    const name = String(g.displayName || g.name || '').trim();
    if (!name) continue;
    const buckets = Array.isArray(g.buckets) ? g.buckets : [];
    const weekly =
      buckets.find((b) => String(b?.window || '').toLowerCase() === 'weekly' && !b?.disabled) ||
      buckets.find((b) => String(b?.window || '').toLowerCase() === 'weekly') ||
      buckets.find((b) => String(b?.window || '').toLowerCase() !== '5h' && !b?.disabled) ||
      null;
    if (!weekly) continue;
    const rawFrac =
      weekly.remaining?.case === 'remainingFraction'
        ? weekly.remaining.value
        : weekly.remainingFraction;
    let remainingPct = null;
    if (rawFrac !== undefined && rawFrac !== null && Number.isFinite(Number(rawFrac))) {
      remainingPct = round1(Math.max(0, Math.min(100, Number(rawFrac) * 100)));
    } else if (typeof weekly.remainingPct === 'number' && Number.isFinite(weekly.remainingPct)) {
      remainingPct = round1(Math.max(0, Math.min(100, weekly.remainingPct)));
    }
    if (remainingPct === null) continue;
    const resetSec = parseResetEpochSec(weekly.resetTime);
    pools.push({
      name,
      remainingPct,
      resetSec,
      disabled: Boolean(weekly.disabled),
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
    const resetAdvanced = prevResetSec > 0 && curResetSec > prevResetSec + 3600;
    const jumpedUp = curPct > prevPct + RESET_JUMP_PCT;

    if (resetAdvanced || jumpedUp) {
      // Mid-day weekly quota reset: keep prior burn, plus any post-reset burn below 100%.
      const postResetBurn = curPct < 100 - MIN_DROP_PCT ? round1(100 - curPct) : 0;
      existing.consumedPct = round1((existing.consumedPct || 0) + postResetBurn);
      existing.lastPct = curPct;
      if (curResetSec > 0) existing.resetSec = curResetSec;
      existing.lastAtMs = nowMs;
      existing.sampleCount = (existing.sampleCount || 0) + 1;
      changed = true;
    } else if (prevPct - curPct >= MIN_DROP_PCT) {
      existing.consumedPct = round1((existing.consumedPct || 0) + (prevPct - curPct));
      existing.lastPct = curPct;
      if (curResetSec > 0) existing.resetSec = curResetSec;
      existing.lastAtMs = nowMs;
      existing.sampleCount = (existing.sampleCount || 0) + 1;
      changed = true;
    } else if (curResetSec > 0 && curResetSec !== prevResetSec) {
      existing.resetSec = curResetSec;
      existing.lastAtMs = nowMs;
      changed = true;
    } else if (Math.abs(curPct - prevPct) >= MIN_DROP_PCT) {
      existing.lastPct = curPct;
      existing.lastAtMs = nowMs;
      changed = true;
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

export function fetchLiveQuotaFromLs({
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS,
  csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN,
  timeoutMs = 2500,
} = {}) {
  const addr = String(lsAddress || '').trim();
  const token = String(csrfToken || '').trim();
  if (!addr || !token) return Promise.resolve(null);

  const normalized = /^https?:\/\//i.test(addr) ? addr : `http://${addr}`;
  let url;
  try {
    url = new URL('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', normalized);
  } catch {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': token,
          'Content-Length': 2,
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          finish(null);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            finish(null);
          }
        });
        res.on('error', () => finish(null));
      }
    );
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {}
      finish(null);
    });
    req.on('error', () => finish(null));
    req.end('{}');
  });
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

function saveStoreToDisk(filePath, store) {
  if (!filePath) return;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
    renameSync(tmp, filePath);
  } catch {}
}

export function createQuotaTracker({
  filePath = '',
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS,
  csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN,
  minIntervalMs = 15_000,
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
        const raw = await fetchLiveQuotaFromLs({ lsAddress, csrfToken });
        const pools = extractWeeklyPools(raw);
        if (pools.length > 0) {
          lastLivePools = pools;
          lastFetchMs = Date.now();
          const res = recordQuotaSample(store, pools, lastFetchMs);
          store = res.store;
          if (res.changed) saveStoreToDisk(filePath, store);
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
