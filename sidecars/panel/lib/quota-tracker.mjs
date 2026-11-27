// Daily Weekly-Quota Consumption Tracker for AGY Claude Style Aux Pane Dashboard.
// Polls Antigravity Language Server RetrieveUserQuotaSummary & GetUserStatus (loopback HTTP),
// persists account-isolated daily snapshots in ~/.gemini/antigravity/plugin_data/agy-claude-style/quota-daily.json,
// and tracks ONLY local-machine active consumption (ignoring offline/other-host drops while preserving mid-day 100% resets).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from './sidecar-owner.mjs';
import { callLsRpcWithRecovery } from './ls-discovery.mjs';

const MAX_STORED_DAYS = 90;
const MIN_DROP_PCT = 0.05;
const FULL_RESET_MIN_PREV_PCT = 90.0;
const FULL_RESET_TARGET_PCT = 99.5;
const MAX_LIVE_GAP_MS = 10 * 60_000;
const MAX_RESTART_GAP_MS = 3 * 60_000;
const ACTIVITY_CLOCK_SLACK_MS = 15_000;

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

function maskAccountLabel(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  const at = s.indexOf('@');
  if (at > 0) {
    const local = s.slice(0, at);
    const domain = s.slice(at + 1);
    const prefix = local.length <= 2 ? local[0] : local.slice(0, 2);
    return `${prefix}***@${domain}`;
  }
  if (s.length <= 3) return `${s[0]}***`;
  return `${s.slice(0, 2)}***${s.slice(-1)}`;
}

export function extractAccountInfo(userStatusRes) {
  const us = userStatusRes?.userStatus && typeof userStatusRes.userStatus === 'object'
    ? userStatusRes.userStatus
    : userStatusRes;
  if (!us || typeof us !== 'object') return { accountKey: 'default', accountLabel: '' };
  const email = String(us.email || us.userEmail || '').trim();
  const userId = String(us.userId || us.id || '').trim();
  const name = String(us.name || '').trim();
  const canonical = (email ? email.toLowerCase() : '') || userId || (name ? name.toLowerCase() : '');
  if (!canonical) return { accountKey: 'default', accountLabel: '' };
  const accountKey = `acct_${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
  const accountLabel = maskAccountLabel(email || name || userId);
  return { accountKey, accountLabel };
}

export function getLatestLocalActivityMs({
  brainDir = join(homedir(), '.gemini', 'antigravity', 'brain'),
  conversationsDir = join(homedir(), '.gemini', 'antigravity', 'conversations'),
} = {}) {
  let maxMs = 0;
  if (conversationsDir && existsSync(conversationsDir)) {
    try {
      for (const entry of readdirSync(conversationsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.pb')) continue;
        try {
          const st = statSync(join(conversationsDir, entry.name));
          if (st.mtimeMs > maxMs) maxMs = st.mtimeMs;
        } catch {}
      }
    } catch {}
  }
  if (brainDir && existsSync(brainDir)) {
    try {
      for (const entry of readdirSync(brainDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const st = statSync(join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl'));
          if (st.mtimeMs > maxMs) maxMs = st.mtimeMs;
        } catch {}
      }
    } catch {}
  }
  return maxMs;
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
  return { version: 2, days: {} };
}

function normalizeDayNode(dayRaw) {
  if (!dayRaw || typeof dayRaw !== 'object') return { accounts: {} };
  if (dayRaw.accounts && typeof dayRaw.accounts === 'object') {
    return dayRaw;
  }
  // Legacy v1 flat day node: migrate pools under 'default' account bucket
  const legacyPools = {};
  for (const [k, v] of Object.entries(dayRaw)) {
    if (v && typeof v === 'object' && typeof v.lastPct === 'number') {
      legacyPools[k] = v;
    }
  }
  return {
    accounts: Object.keys(legacyPools).length > 0 ? { default: { label: '', pools: legacyPools } } : {},
  };
}

function getAccountPoolsForDay(store, dateKey, accountKey = 'default', { create = false, accountLabel = '' } = {}) {
  const days = store.days || {};
  let dayNode = days[dateKey];
  if (!dayNode) {
    if (!create) return null;
    dayNode = { accounts: {} };
    days[dateKey] = dayNode;
  } else if (!dayNode.accounts || typeof dayNode.accounts !== 'object') {
    dayNode = normalizeDayNode(dayNode);
    if (create) days[dateKey] = dayNode;
  }
  const key = String(accountKey || 'default').trim() || 'default';
  let acct = dayNode.accounts[key];
  if (!acct) {
    if (!create) return null;
    acct = { label: accountLabel || '', pools: {} };
    dayNode.accounts[key] = acct;
  } else if (accountLabel && !acct.label) {
    acct.label = accountLabel;
  }
  if (!acct.pools || typeof acct.pools !== 'object') {
    acct.pools = {};
  }
  return acct.pools;
}

function resolveLocalActivityCredit(existing, nowMs, opts = {}) {
  if (typeof opts.hasLocalActivity === 'boolean') {
    return opts.hasLocalActivity;
  }
  if (typeof opts.localActivityMs === 'number') {
    const gapMs = Math.max(0, nowMs - Number(existing.lastAtMs || 0));
    const maxGap = opts.inSession === false ? MAX_RESTART_GAP_MS : MAX_LIVE_GAP_MS;
    if (gapMs > maxGap) return false;
    return opts.localActivityMs > Number(existing.lastAtMs || 0) - ACTIVITY_CLOCK_SLACK_MS;
  }
  return opts.inSession !== false;
}

export function recordQuotaSample(store, pools = [], nowMs = Date.now(), opts = {}) {
  const target = store && typeof store === 'object' && store.days ? store : createEmptyStore();
  target.version = 2;
  if (!Array.isArray(pools) || pools.length === 0) return { store: target, changed: false };

  const todayKey = formatLocalDate(nowMs);
  const accountKey = String(opts.accountKey || 'default').trim() || 'default';
  const accountLabel = String(opts.accountLabel || '').trim();
  const dayRec = getAccountPoolsForDay(target, todayKey, accountKey, { create: true, accountLabel });
  let changed = false;

  for (const pool of pools) {
    if (!pool || !pool.name || typeof pool.remainingPct !== 'number') continue;
    const curPct = round1(Math.max(0, Math.min(100, pool.remainingPct)));
    const curResetSec = Number(pool.resetSec || 0);
    const existing = dayRec[pool.name];

    if (!existing) {
      // Never carry over drops across midnight or offline windows: start local baseline at curPct with 0 burn.
      dayRec[pool.name] = {
        firstPct: curPct,
        segmentLowPct: curPct,
        lastPct: curPct,
        consumedPct: 0,
        resetSec: curResetSec,
        firstAtMs: nowMs,
        lastAtMs: nowMs,
        sampleCount: 1,
        carriedFromPrior: false,
      };
      changed = true;
      continue;
    }

    const prevPct = Number(existing.lastPct);
    const prevResetSec = Number(existing.resetSec || 0);
    if (typeof existing.segmentLowPct !== 'number') {
      existing.segmentLowPct = prevPct;
    }
    if (typeof existing.consumedPct !== 'number') {
      existing.consumedPct = 0;
    }

    const resetRegressed = prevResetSec > 0 && curResetSec > 0 && curResetSec < prevResetSec - 3600;
    const resetAdvanced = prevResetSec > 0 && curResetSec > prevResetSec + 3600;
    const jumpedToFull = prevPct <= FULL_RESET_MIN_PREV_PCT && curPct >= FULL_RESET_TARGET_PCT;
    const creditLocal = resolveLocalActivityCredit(existing, nowMs, opts);

    if (resetRegressed) {
      // Fallback account-switch / cycle-regression guard: re-baseline without counting cross-account delta.
      existing.segmentLowPct = curPct;
      existing.lastPct = curPct;
      existing.resetSec = curResetSec;
      existing.lastAtMs = nowMs;
      existing.sampleCount = (existing.sampleCount || 0) + 1;
      changed = true;
    } else if (resetAdvanced || jumpedToFull) {
      // Mid-day weekly quota reset (e.g. reset back to 100%): preserve already-accumulated local burn today.
      if (creditLocal && curPct < 100 - MIN_DROP_PCT) {
        const postResetBurn = round1(100 - curPct);
        existing.consumedPct = round1(existing.consumedPct + postResetBurn);
      }
      existing.segmentLowPct = curPct;
      existing.lastPct = curPct;
      if (curResetSec > 0) existing.resetSec = curResetSec;
      else if (jumpedToFull) existing.resetSec = 0;
      existing.lastAtMs = nowMs;
      existing.sampleCount = (existing.sampleCount || 0) + 1;
      changed = true;
    } else if (!creditLocal) {
      // Offline gap or idle machine while another host consumed quota: re-baseline without adding local burn.
      const pctChanged = Math.abs(curPct - prevPct) >= MIN_DROP_PCT || Math.abs(curPct - existing.segmentLowPct) >= MIN_DROP_PCT;
      const resetChanged = curResetSec > 0 && curResetSec !== prevResetSec;
      if (pctChanged || resetChanged) {
        existing.segmentLowPct = curPct;
        existing.lastPct = curPct;
        if (curResetSec > 0) existing.resetSec = curResetSec;
        existing.lastAtMs = nowMs;
        changed = true;
      }
    } else {
      // Active local session: credit incremental net drops below segmentLowPct (immune to reservation dip refunds).
      let delta = 0;
      if (existing.segmentLowPct - curPct >= MIN_DROP_PCT) {
        delta = round1(existing.segmentLowPct - curPct);
        existing.consumedPct = round1(existing.consumedPct + delta);
        existing.segmentLowPct = curPct;
      }
      const pctChanged = Math.abs(curPct - prevPct) >= MIN_DROP_PCT;
      const resetChanged = curResetSec > 0 && curResetSec !== prevResetSec;
      if (delta > 0 || pctChanged || resetChanged) {
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

function selectDayPoolsForSummary(dayRaw, accountKey = 'default') {
  const norm = normalizeDayNode(dayRaw);
  const accounts = norm.accounts || {};
  const key = String(accountKey || 'default').trim() || 'default';
  if (accounts[key]?.pools) {
    return { pools: accounts[key].pools, label: accounts[key].label || '' };
  }
  if (key === 'default') {
    const keys = Object.keys(accounts);
    if (keys.length === 1 && accounts[keys[0]]?.pools) {
      return { pools: accounts[keys[0]].pools, label: accounts[keys[0]].label || '' };
    }
  }
  return { pools: {}, label: '' };
}

export function summarizeWeeklyQuota(store, livePools = [], nowMs = Date.now(), opts = {}) {
  const todayKey = formatLocalDate(nowMs);
  const accountKey = String(opts.accountKey || 'default').trim() || 'default';
  let accountLabel = String(opts.accountLabel || '').trim();
  const days = store?.days || {};
  const todaySelected = selectDayPoolsForSummary(days[todayKey], accountKey);
  const todayRec = todaySelected.pools;
  if (!accountLabel && todaySelected.label) accountLabel = todaySelected.label;

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
      carriedFromPrior: false,
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
      carriedFromPrior: false,
    });
  }

  const pools = [...poolMap.values()];
  const byDate = {};
  for (const [dateKey, dayRaw] of Object.entries(days)) {
    const selected = selectDayPoolsForSummary(dayRaw, accountKey);
    const entries = Object.entries(selected.pools || {}).map(([name, rec]) => ({
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
    accountKey,
    accountLabel,
    localOnly: true,
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

export async function fetchLiveUserAccountFromLs({
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS,
  csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN,
  timeoutMs = 2000,
  allowRediscover = true,
  discoverFn,
  requestFn,
} = {}) {
  try {
    const res = await callLsRpcWithRecovery(
      'exa.language_server_pb.LanguageServerService',
      'GetUserStatus',
      {},
      {
        lsAddress,
        csrfToken,
        timeoutMs,
        allowRediscover,
        ...(discoverFn ? { discoverFn } : {}),
        ...(requestFn ? { requestFn } : {}),
      }
    );
    return res?.ok ? extractAccountInfo(res.data) : { accountKey: 'default', accountLabel: '' };
  } catch {
    return { accountKey: 'default', accountLabel: '' };
  }
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
  getLocalActivityMsFn = null,
  fetchQuotaFn = null,
  fetchAccountFn = null,
} = {}) {
  let store = loadStoreFromDisk(filePath);
  let lastLivePools = [];
  let lastAccount = { accountKey: 'default', accountLabel: '' };
  let lastFetchMs = 0;
  let hasSampledInSession = false;
  let inflight = null;

  const isTestLs = String(lsAddress || '').trim() === 'test.invalid';
  const readLocalActivity =
    typeof getLocalActivityMsFn === 'function'
      ? getLocalActivityMsFn
      : isTestLs
      ? () => 0
      : () => getLatestLocalActivityMs();

  async function sampleNow({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - lastFetchMs < minIntervalMs && lastLivePools.length > 0) {
      return summarizeWeeklyQuota(store, lastLivePools, now, lastAccount);
    }
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const quotaFetcher =
          typeof fetchQuotaFn === 'function'
            ? fetchQuotaFn
            : () =>
                fetchLiveQuotaFromLs({
                  lsAddress,
                  csrfToken,
                  forceRefresh: Boolean(force),
                  allowRediscover,
                });
        const accountFetcher =
          typeof fetchAccountFn === 'function'
            ? fetchAccountFn
            : () =>
                fetchLiveUserAccountFromLs({
                  lsAddress,
                  csrfToken,
                  allowRediscover,
                });

        const [raw, acct] = await Promise.all([quotaFetcher(), accountFetcher()]);
        const pools = extractWeeklyPools(raw);
        if (acct && acct.accountKey) {
          lastAccount = acct;
        }
        if (pools.length > 0) {
          const sampleMs = Date.now();
          const localActivityMs = Number(readLocalActivity() || 0);
          const inSession = hasSampledInSession;
          lastLivePools = pools;
          lastFetchMs = sampleMs;
          hasSampledInSession = true;
          const res = recordQuotaSample(store, pools, sampleMs, {
            accountKey: lastAccount.accountKey,
            accountLabel: lastAccount.accountLabel,
            inSession,
            localActivityMs,
          });
          store = res.store;
          if (res.changed) saveStoreToDisk(filePath, store, { ownsFn });
        }
      } catch {} finally {
        inflight = null;
      }
      return summarizeWeeklyQuota(store, lastLivePools, Date.now(), lastAccount);
    })();
    return inflight;
  }

  function getSummary(nowMs = Date.now()) {
    return summarizeWeeklyQuota(store, lastLivePools, nowMs, lastAccount);
  }

  return { sampleNow, getSummary };
}
