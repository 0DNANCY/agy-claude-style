// Read-only local transcript telemetry aggregator for AGY Claude Style Aux Pane Dashboard.
// Parses ~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl with mtime caching,
// computes reference USD cost, detects short-interval cache-drop anomalies, and builds a 53-week heatmap.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
let _DatabaseSync = undefined;
function getDatabaseSync() {
  if (_DatabaseSync !== undefined) return _DatabaseSync;
  try {
    _DatabaseSync = require('node:sqlite').DatabaseSync || null;
  } catch {
    _DatabaseSync = null;
  }
  return _DatabaseSync;
}

function readPbVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [Number(result), pos];
    shift += 7n;
    if (shift > 63n) break;
  }
  return [Number(result), pos];
}

function parsePbMap(buf) {
  const map = new Map();
  if (!buf || !buf.length) return map;
  let pos = 0;
  while (pos < buf.length) {
    const [tag, nextPos] = readPbVarint(buf, pos);
    pos = nextPos;
    const field = tag >>> 3;
    const wire = tag & 7;
    if (!field) break;
    let val;
    if (wire === 0) {
      [val, pos] = readPbVarint(buf, pos);
    } else if (wire === 1) {
      pos += 8;
      continue;
    } else if (wire === 2) {
      const [len, dataPos] = readPbVarint(buf, pos);
      if (len < 0 || dataPos + len > buf.length) break;
      val = buf.subarray(dataPos, dataPos + len);
      pos = dataPos + len;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) break;
      val = buf.readUInt32LE(pos);
      pos += 4;
    } else {
      break;
    }
    let arr = map.get(field);
    if (!arr) {
      arr = [];
      map.set(field, arr);
    }
    arr.push(val);
  }
  return map;
}

export function parseGenMetadataTtft(rawData) {
  if (!rawData || !rawData.length) return null;
  const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
  const top = parsePbMap(buf);
  if (!top.has(1)) return null;
  const stepIndices = [];
  for (const v of top.get(2) || []) {
    if (typeof v === 'number') {
      stepIndices.push(v);
    } else if (v && v.length) {
      let off = 0;
      while (off < v.length) {
        const [idx, next] = readPbVarint(v, off);
        stepIndices.push(idx);
        off = next;
      }
    }
  }
  const m1 = parsePbMap(top.get(1)[0]);
  if (!m1.has(11)) return null;
  const dur = parsePbMap(m1.get(11)[0]);
  const sec = Number(dur.get(1)?.[0] || 0);
  const nanos = Number(dur.get(2)?.[0] || 0);
  const ttftMs = Math.round((sec + nanos / 1e9) * 1000);
  if (!Number.isFinite(ttftMs) || ttftMs < 0 || ttftMs > 600_000) return null;
  return { stepIndices, ttftMs };
}

const dbTtftCache = new Map();

export function readConversationTtftMap(dbPath) {
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync || !dbPath || !existsSync(dbPath)) return null;
  let mtimeKey = '';
  try {
    const st = statSync(dbPath);
    const walPath = `${dbPath}-wal`;
    const walSt = existsSync(walPath) ? statSync(walPath) : null;
    mtimeKey = `${st.mtimeMs}:${st.size}:${walSt ? `${walSt.mtimeMs}:${walSt.size}` : '0'}`;
  } catch {
    return null;
  }
  const cached = dbTtftCache.get(dbPath);
  if (cached && cached.mtimeKey === mtimeKey) return cached.map;

  const map = new Map();
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_metadata'")
      .get();
    if (hasTable) {
      const rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx ASC').all();
      for (const row of rows) {
        const parsed = parseGenMetadataTtft(row.data);
        if (!parsed) continue;
        for (const sIdx of parsed.stepIndices) {
          map.set(sIdx, parsed.ttftMs);
        }
      }
    }
  } catch {
    return null;
  } finally {
    try {
      if (db) db.close();
    } catch {}
  }
  dbTtftCache.set(dbPath, { mtimeKey, map });
  return map;
}

const DAY_MS = 86400000;
const CACHE_DROP_GAP_MS = 5 * 60 * 1000;

// Reference per-1M token USD pricing (input, cacheRead, output).
const MODEL_PRICING = [
  { match: /gemini-4-carbon|carbon/i, input: 2.0, cacheRead: 0.2, output: 10.0 },
  { match: /gemini-4-neon|neon/i, input: 1.5, cacheRead: 0.15, output: 7.5 },
  { match: /gemini-4-hydrogen|hydrogen/i, input: 1.5, cacheRead: 0.15, output: 7.5 },
  { match: /gemini-4-argon|argon/i, input: 0.5, cacheRead: 0.05, output: 2.5 },
  { match: /gemini-.*pro/i, input: 1.25, cacheRead: 0.125, output: 10.0 },
  { match: /gemini-.*flash/i, input: 0.3, cacheRead: 0.03, output: 2.5 },
  { match: /claude-.*opus/i, input: 15.0, cacheRead: 1.5, output: 75.0 },
  { match: /claude-.*sonnet/i, input: 3.0, cacheRead: 0.3, output: 15.0 },
  { match: /claude-.*haiku/i, input: 0.8, cacheRead: 0.08, output: 4.0 },
  { match: /gpt-5|o3|o4/i, input: 2.5, cacheRead: 0.25, output: 10.0 },
  { match: /gpt-4/i, input: 2.5, cacheRead: 1.25, output: 10.0 },
];
const DEFAULT_PRICE = { input: 1.5, cacheRead: 0.15, output: 7.5 };

export function normalizeModelFamily(model = '') {
  return String(model || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/-(low|medium|high|xhigh|max|minimal|extra)$/i, '');
}

export function lookupModelPrice(model = '') {
  const m = String(model || '');
  for (const row of MODEL_PRICING) {
    if (row.match.test(m)) return row;
  }
  return DEFAULT_PRICE;
}

export function estimateRequestCost(
  { model = '', inputTokens = 0, cacheReadTokens = 0, outputTokens = 0 } = {},
  priceLookup = lookupModelPrice
) {
  const price = typeof priceLookup === 'function' ? priceLookup(model) : lookupModelPrice(model);
  const inRate = Number(price?.inputPerM ?? price?.input ?? 1.5);
  const cacheRate = Number(price?.cacheReadPerM ?? price?.cacheRead ?? 0.3);
  const outRate = Number(price?.outputPerM ?? price?.output ?? 6.0);
  const totalIn = Math.max(0, Number(inputTokens) || 0);
  const cached = Math.min(totalIn, Math.max(0, Number(cacheReadTokens) || 0));
  const freshIn = Math.max(0, totalIn - cached);
  const out = Math.max(0, Number(outputTokens) || 0);
  return (freshIn * inRate + cached * cacheRate + out * outRate) / 1_000_000;
}

export function extractUserTitle(rawContent = '') {
  const s = String(rawContent || '');
  if (!s) return '';
  const reqMatch = s.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  let body = reqMatch ? reqMatch[1] : s;
  body = body
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, ' ')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!body) return '';
  return body.length > 42 ? `${body.slice(0, 42)}…` : body;
}

export function parseTranscriptJsonl(rawText = '', conversationId = '', sourceLabel = 'local') {
  const requests = [];
  if (!rawText) return requests;
  const lines = String(rawText).split(/\r?\n/);
  let lastErrorText = '';
  let sawCompactionBeforeNext = false;
  let conversationTitle = '';
  const parsedObjs = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    try {
      parsedObjs.push({ idx: i, obj: JSON.parse(line) });
    } catch {}
  }

  for (let p = 0; p < parsedObjs.length; p++) {
    const { idx: i, obj } = parsedObjs[p];
    const type = String(obj.type || '');
    if (type === 'USER_INPUT' && !conversationTitle) {
      const t = extractUserTitle(obj.content || obj.text || '');
      if (t) conversationTitle = t;
      continue;
    }
    if (type === 'CHECKPOINT' || /compact/i.test(type)) {
      sawCompactionBeforeNext = true;
      continue;
    }
    if (type === 'ERROR_MESSAGE') {
      lastErrorText = String(obj.content || obj.error || obj.message || 'Error').trim().slice(0, 180);
      const tsMs = Date.parse(obj.created_at || '') || 0;
      requests.push({
        id: `${sourceLabel}:${conversationId}:${obj.step_index ?? i}:err`,
        source: sourceLabel,
        conversationId,
        conversationTitle: '',
        stepIndex: Number.isInteger(obj.step_index) ? obj.step_index : i,
        timestampMs: tsMs,
        responseMs: null,
        ttftMs: null,
        model: String(obj.model || 'unknown'),
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheHitPct: 0,
        costUsd: 0,
        status: 'error',
        errorText: lastErrorText,
        afterCompaction: false,
      });
      continue;
    }
    if (type !== 'PLANNER_RESPONSE') continue;

    const inputTokens = Math.max(0, Number(obj.input_tokens ?? obj.usage?.input_tokens ?? 0) || 0);
    const cacheReadTokens = Math.max(0, Number(obj.cache_read_tokens ?? obj.usage?.cache_read_tokens ?? 0) || 0);
    const outputTokens = Math.max(0, Number(obj.output_tokens ?? obj.usage?.output_tokens ?? 0) || 0);
    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && obj.status !== 'ERROR') continue;

    const totalIn = Math.max(inputTokens, cacheReadTokens);
    const cacheHitPct = totalIn > 0 ? Math.min(100, (cacheReadTokens / totalIn) * 100) : 0;
    const tsMs = Date.parse(obj.created_at || '') || 0;
    let responseMs = null;
    const explicitDur = Number(obj.duration_ms ?? obj.latency_ms ?? obj.elapsed_ms);
    if (Number.isFinite(explicitDur) && explicitDur >= 0 && explicitDur <= 600_000) {
      responseMs = Math.round(explicitDur);
    } else {
      const completedMs = Date.parse(obj.completed_at || obj.finished_at || '') || 0;
      if (completedMs > 0 && tsMs > 0 && completedMs >= tsMs && completedMs - tsMs <= 600_000) {
        responseMs = completedMs - tsMs;
      } else if (tsMs > 0 && p + 1 < parsedObjs.length) {
        const nextObj = parsedObjs[p + 1].obj;
        const nextType = String(nextObj?.type || '');
        const nextTs = Date.parse(nextObj?.created_at || '') || 0;
        if (nextType !== 'USER_INPUT' && nextTs >= tsMs && nextTs - tsMs <= 600_000) {
          responseMs = nextTs - tsMs;
        }
      }
    }
    let ttftMs = null;
    const explicitTtft = Number(obj.ttft_ms ?? obj.time_to_first_token_ms ?? obj.first_token_ms);
    if (Number.isFinite(explicitTtft) && explicitTtft >= 0 && explicitTtft <= 600_000) {
      ttftMs = Math.round(explicitTtft);
    }
    const model = String(obj.model || 'unknown').trim() || 'unknown';
    const isErr = String(obj.status || '').toUpperCase() === 'ERROR';
    const costUsd = estimateRequestCost({ model, inputTokens: totalIn, cacheReadTokens, outputTokens });

    requests.push({
      id: `${sourceLabel}:${conversationId}:${obj.step_index ?? i}`,
      source: sourceLabel,
      conversationId,
      conversationTitle: '',
      stepIndex: Number.isInteger(obj.step_index) ? obj.step_index : i,
      timestampMs: tsMs,
      responseMs,
      ttftMs,
      model,
      inputTokens: totalIn,
      cacheReadTokens,
      outputTokens,
      totalTokens: totalIn + outputTokens,
      cacheHitPct,
      costUsd,
      status: isErr ? 'error' : 'ok',
      errorText: isErr ? (lastErrorText || String(obj.content || 'Request failed').slice(0, 160)) : '',
      afterCompaction: sawCompactionBeforeNext,
    });
    sawCompactionBeforeNext = false;
    lastErrorText = '';
  }
  const fallbackTitle = conversationTitle || (conversationId ? `会话 #${String(conversationId).slice(0, 8)}` : '未命名会话');
  for (const r of requests) {
    r.conversationTitle = fallbackTitle;
  }
  return requests;
}

export function detectCacheDropAnomalies(requests = []) {
  const byConvo = new Map();
  for (const r of requests) {
    if (!r || r.status !== 'ok' || !r.timestampMs) continue;
    const key = `${r.source || 'local'}:${r.conversationId}`;
    if (!byConvo.has(key)) byConvo.set(key, []);
    byConvo.get(key).push(r);
  }
  const anomalyMap = new Map();
  for (const list of byConvo.values()) {
    list.sort((a, b) => a.timestampMs - b.timestampMs || a.stepIndex - b.stepIndex);
    let prev = null;
    for (const cur of list) {
      if (prev && !cur.afterCompaction) {
        const gapMs = cur.timestampMs - prev.timestampMs;
        const sameFamily = normalizeModelFamily(prev.model) === normalizeModelFamily(cur.model);
        const notCompacted = cur.inputTokens >= prev.inputTokens * 0.55;
        if (
          gapMs > 0 &&
          gapMs <= CACHE_DROP_GAP_MS &&
          sameFamily &&
          notCompacted &&
          prev.inputTokens >= 4000 &&
          prev.cacheHitPct >= 55 &&
          cur.cacheHitPct <= prev.cacheHitPct - 30
        ) {
          anomalyMap.set(cur.id, {
            kind: 'cache-drop',
            gapSec: Math.round(gapMs / 1000),
            prevHit: Number(prev.cacheHitPct.toFixed(1)),
            curHit: Number(cur.cacheHitPct.toFixed(1)),
            prevCache: prev.cacheReadTokens,
            curCache: cur.cacheReadTokens,
          });
        }
      }
      if (cur.inputTokens >= 1000) prev = cur;
    }
  }
  return anomalyMap;
}

function formatLocalDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function buildHeatmap53w(requests = [], nowMs = Date.now()) {
  const dayBuckets = new Map();
  for (const r of requests) {
    if (!r || !r.timestampMs) continue;
    const key = formatLocalDate(r.timestampMs);
    let b = dayBuckets.get(key);
    if (!b) {
      b = {
        date: key,
        count: 0,
        tokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        errorCount: 0,
        anomalyCount: 0,
      };
      dayBuckets.set(key, b);
    }
    b.count += 1;
    b.tokens += r.totalTokens || 0;
    b.inputTokens += r.inputTokens || 0;
    b.cacheReadTokens += r.cacheReadTokens || 0;
    b.outputTokens += r.outputTokens || 0;
    b.costUsd += r.costUsd || 0;
    if (r.status === 'error') b.errorCount += 1;
    if (r.anomaly) b.anomalyCount += 1;
  }

  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const todayKey = formatLocalDate(today.getTime());
  const endDow = today.getDay();
  const totalDays = 52 * 7 + endDow + 1;
  const startMs = today.getTime() - (totalDays - 1) * DAY_MS;

  const cells = [];
  let maxTokens = 0;
  for (let i = 0; i < totalDays; i++) {
    const dt = new Date(startMs + i * DAY_MS);
    const key = formatLocalDate(dt.getTime());
    const b = dayBuckets.get(key) || {
      date: key,
      count: 0,
      tokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      errorCount: 0,
      anomalyCount: 0,
    };
    if (b.tokens > maxTokens) maxTokens = b.tokens;
    cells.push(b);
  }
  return cells.map((c) => {
    // Square-root 4-step scale so a single heavy day does not flatten normal days.
    const level =
      c.tokens > 0 && maxTokens > 0
        ? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(c.tokens / maxTokens) * 4)))
        : 0;
    const cacheHitPct =
      c.inputTokens > 0 ? Number(((c.cacheReadTokens / c.inputTokens) * 100).toFixed(1)) : 0;
    return {
      ...c,
      cacheHitPct,
      costUsd: Number(c.costUsd.toFixed(4)),
      level,
      isToday: c.date === todayKey,
    };
  });
}

const fileCache = new Map();

export function readLocalBrainRequests({
  brainDir = join(homedir(), '.gemini', 'antigravity', 'brain'),
  conversationsDir,
  maxConversations = 160,
} = {}) {
  if (!existsSync(brainDir)) return [];
  const convDir = conversationsDir || join(dirname(brainDir), 'conversations');
  let entries = [];
  try {
    entries = readdirSync(brainDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }

  const candidates = [];
  for (const dir of entries) {
    const logPath = join(brainDir, dir.name, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      const st = statSync(logPath);
      if (st.isFile() && st.size > 0) {
        candidates.push({ id: dir.name, logPath, mtimeMs: st.mtimeMs, size: st.size });
      }
    } catch {}
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected = candidates.slice(0, maxConversations);
  const all = [];

  for (const c of selected) {
    const dbPath = join(convDir, `${c.id}.db`);
    const ttftMap = readConversationTtftMap(dbPath);
    const cached = fileCache.get(c.logPath);
    let rows;
    if (cached && cached.mtimeMs === c.mtimeMs && cached.size === c.size) {
      rows = cached.rows;
    } else {
      try {
        const raw = readFileSync(c.logPath, 'utf8');
        rows = parseTranscriptJsonl(raw, c.id, 'local');
        fileCache.set(c.logPath, { mtimeMs: c.mtimeMs, size: c.size, rows });
      } catch {
        continue;
      }
    }
    for (const r of rows) {
      if (ttftMap && Number.isInteger(r.stepIndex) && ttftMap.has(r.stepIndex)) {
        const dbTtft = ttftMap.get(r.stepIndex);
        all.push(r.ttftMs === dbTtft ? r : { ...r, ttftMs: dbTtft });
      } else {
        all.push(r);
      }
    }
  }
  return all;
}

function classifyHealthErrorTag(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return 'error';
  if (/unexpected\s+eof|\beof\b|connection\s+reset|broken\s+pipe/i.test(s)) return 'EOF';
  if (/\b429\b|rate\s*limit|resource_exhausted|quota/i.test(s)) return '429';
  if (/\b503\b|\b502\b|\b504\b|unavailable|overloaded|capacity/i.test(s)) return '503';
  if (/timeout|timed\s*out|deadline/i.test(s)) return '超时';
  if (/\b403\b|permission|region|forbidden/i.test(s)) return '403';
  return s.slice(0, 18);
}

export function buildModelHealth(requests = [], { range = '7d', selectedDate = '', nowMs = Date.now(), slotCount = 12 } = {}) {
  const slotsN = Math.max(6, Math.min(24, Number(slotCount) || 12));
  let windowEndMs = nowMs;
  let windowStartMs = nowMs - 7 * DAY_MS;

  if (selectedDate && /^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
    const d0 = new Date(`${selectedDate}T00:00:00`);
    windowStartMs = d0.getTime();
    windowEndMs = windowStartMs + DAY_MS;
  } else if (range === 'today') {
    const d0 = new Date(nowMs);
    d0.setHours(0, 0, 0, 0);
    windowStartMs = d0.getTime();
    windowEndMs = Math.max(nowMs, windowStartMs + 60 * 60 * 1000);
  } else if (range === '24h') {
    windowStartMs = nowMs - DAY_MS;
  } else if (range === '7d') {
    windowStartMs = nowMs - 7 * DAY_MS;
  } else if (range === '30d') {
    windowStartMs = nowMs - 30 * DAY_MS;
  } else {
    let minTs = Infinity;
    let maxTs = 0;
    for (const r of requests) {
      if (r.timestampMs > 0) {
        if (r.timestampMs < minTs) minTs = r.timestampMs;
        if (r.timestampMs > maxTs) maxTs = r.timestampMs;
      }
    }
    if (Number.isFinite(minTs) && maxTs > minTs) {
      windowStartMs = minTs;
      windowEndMs = maxTs + 1000;
    } else {
      windowStartMs = nowMs - 7 * DAY_MS;
    }
  }

  const spanMs = Math.max(60_000, windowEndMs - windowStartMs);
  const bucketMs = spanMs / slotsN;
  const byModel = new Map();

  for (const r of requests) {
    const mName = r.model || 'unknown';
    let entry = byModel.get(mName);
    if (!entry) {
      entry = {
        model: mName,
        requests: 0,
        errorCount: 0,
        anomalyCount: 0,
        ttftSum: 0,
        ttftCount: 0,
        errorTags: new Map(),
        slots: Array.from({ length: slotsN }, (_, idx) => ({
          idx,
          startMs: Math.round(windowStartMs + idx * bucketMs),
          endMs: Math.round(windowStartMs + (idx + 1) * bucketMs),
          count: 0,
          errors: 0,
          anomalies: 0,
          ttftSum: 0,
          ttftCount: 0,
        })),
      };
      byModel.set(mName, entry);
    }

    entry.requests += 1;
    const isErr = r.status === 'error';
    const isAnom = Boolean(r.anomaly);
    if (isErr) {
      entry.errorCount += 1;
      const tag = classifyHealthErrorTag(r.errorText);
      entry.errorTags.set(tag, (entry.errorTags.get(tag) || 0) + 1);
    }
    if (isAnom) entry.anomalyCount += 1;
    if (Number.isFinite(r.ttftMs) && r.ttftMs >= 0) {
      entry.ttftSum += r.ttftMs;
      entry.ttftCount += 1;
    }

    if (r.timestampMs >= windowStartMs && r.timestampMs <= windowEndMs) {
      const rawIdx = Math.floor((r.timestampMs - windowStartMs) / bucketMs);
      const sIdx = Math.max(0, Math.min(slotsN - 1, rawIdx));
      const slot = entry.slots[sIdx];
      slot.count += 1;
      if (isErr) slot.errors += 1;
      if (isAnom) slot.anomalies += 1;
      if (Number.isFinite(r.ttftMs) && r.ttftMs >= 0) {
        slot.ttftSum += r.ttftMs;
        slot.ttftCount += 1;
      }
    }
  }

  const models = Array.from(byModel.values())
    .map((m) => {
      const avgTtftMs = m.ttftCount > 0 ? Math.round(m.ttftSum / m.ttftCount) : null;
      const successRatePct = m.requests > 0 ? Number((((m.requests - m.errorCount) / m.requests) * 100).toFixed(1)) : 100;
      const cacheDropRatePct = m.requests > 0 ? Number(((m.anomalyCount / m.requests) * 100).toFixed(1)) : 0;
      let topError = '';
      let topErrorCount = 0;
      for (const [tag, cnt] of m.errorTags.entries()) {
        if (cnt > topErrorCount) {
          topError = tag;
          topErrorCount = cnt;
        }
      }
      const slots = m.slots.map((s) => {
        const sAvgTtft = s.ttftCount > 0 ? Math.round(s.ttftSum / s.ttftCount) : null;
        let status = 'empty';
        if (s.count > 0) {
          if (s.errors > 0) status = 'err';
          else if (s.anomalies > 0 || (sAvgTtft !== null && sAvgTtft >= 15000)) status = 'warn';
          else status = 'ok';
        }
        return {
          startMs: s.startMs,
          endMs: s.endMs,
          count: s.count,
          errors: s.errors,
          anomalies: s.anomalies,
          avgTtftMs: sAvgTtft,
          status,
        };
      });

      const errRate = m.requests > 0 ? m.errorCount / m.requests : 0;
      const overallStatus =
        errRate >= 0.1 || m.errorCount >= 3
          ? 'err'
          : m.errorCount > 0 || cacheDropRatePct >= 15 || (avgTtftMs !== null && avgTtftMs >= 15000)
          ? 'warn'
          : 'ok';

      return {
        model: m.model,
        requests: m.requests,
        errorCount: m.errorCount,
        anomalyCount: m.anomalyCount,
        successRatePct,
        cacheDropRatePct,
        avgTtftMs,
        topError,
        overallStatus,
        slots,
      };
    })
    .sort((a, b) => b.requests - a.requests || b.errorCount - a.errorCount)
    .slice(0, 8);

  return {
    windowStartMs: Math.round(windowStartMs),
    windowEndMs: Math.round(windowEndMs),
    slotCount: slotsN,
    models,
  };
}

export function queryTelemetryDashboard({
  brainDir,
  conversationsDir,
  extraRequests = [],
  priceLookup = null,
  range = '7d',
  date = '',
  conversationId = '',
  model = '',
  status = 'all',
  search = '',
  offset = 0,
  limit = 50,
  nowMs = Date.now(),
} = {}) {
  const localReqs = readLocalBrainRequests({ brainDir, conversationsDir });
  const combined = [...localReqs, ...(Array.isArray(extraRequests) ? extraRequests : [])];
  const anomalies = detectCacheDropAnomalies(combined);

  const enriched = combined.map((r) => ({
    ...r,
    costUsd: typeof priceLookup === 'function' ? estimateRequestCost(r, priceLookup) : r.costUsd,
    anomaly: anomalies.get(r.id) || null,
  }));

  const heatmap = buildHeatmap53w(enriched, nowMs);
  const todaySummary = heatmap.find((c) => c.isToday) || {
    date: formatLocalDate(nowMs),
    count: 0,
    tokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    cacheHitPct: 0,
    costUsd: 0,
    errorCount: 0,
    anomalyCount: 0,
    level: 0,
    isToday: true,
  };

  const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '').trim())
    ? String(date).trim()
    : '';

  let cutoffMs = 0;
  if (!selectedDate) {
    if (range === 'today') {
      const d = new Date(nowMs);
      d.setHours(0, 0, 0, 0);
      cutoffMs = d.getTime();
    } else if (range === '24h') {
      cutoffMs = nowMs - DAY_MS;
    } else if (range === '7d') {
      cutoffMs = nowMs - 7 * DAY_MS;
    } else if (range === '30d') {
      cutoffMs = nowMs - 30 * DAY_MS;
    }
  }

  const rangeRows = selectedDate
    ? enriched.filter((r) => r.timestampMs && formatLocalDate(r.timestampMs) === selectedDate)
    : cutoffMs > 0
    ? enriched.filter((r) => r.timestampMs >= cutoffMs)
    : enriched;

  const modelSet = new Set();
  const byModel = new Map();
  let totalRequests = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalCostUsd = 0;
  let anomalyCount = 0;
  let errorCount = 0;
  let respSumMs = 0;
  let respCount = 0;
  let ttftSumMs = 0;
  let ttftCount = 0;

  for (const r of rangeRows) {
    modelSet.add(r.model);
    totalRequests += 1;
    totalInput += r.inputTokens || 0;
    totalCacheRead += r.cacheReadTokens || 0;
    totalOutput += r.outputTokens || 0;
    totalCostUsd += r.costUsd || 0;
    if (r.anomaly) anomalyCount += 1;
    if (r.status === 'error') errorCount += 1;
    if (Number.isFinite(r.responseMs) && r.responseMs >= 0) {
      respSumMs += r.responseMs;
      respCount += 1;
    }
    if (Number.isFinite(r.ttftMs) && r.ttftMs >= 0) {
      ttftSumMs += r.ttftMs;
      ttftCount += 1;
    }

    let m = byModel.get(r.model);
    if (!m) {
      m = { model: r.model, requests: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0, anomalies: 0 };
      byModel.set(r.model, m);
    }
    m.requests += 1;
    m.inputTokens += r.inputTokens || 0;
    m.cacheReadTokens += r.cacheReadTokens || 0;
    m.outputTokens += r.outputTokens || 0;
    m.costUsd += r.costUsd || 0;
    if (r.anomaly) m.anomalies += 1;
  }

  const q = String(search || '').trim().toLowerCase();
  const convoFilter = String(conversationId || '').trim();
  const allFiltered = rangeRows
    .filter((r) => {
      if (convoFilter && r.conversationId !== convoFilter) return false;
      if (model && r.model !== model) return false;
      if (status === 'anomaly' && !r.anomaly) return false;
      if (status === 'error' && r.status !== 'error') return false;
      if (q) {
        const hay = `${r.model} ${r.conversationId} ${r.conversationTitle || ''} ${r.source} ${r.errorText}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => b.timestampMs - a.timestampMs || b.stepIndex - a.stepIndex);

  const safeOffset = Math.max(0, Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0);
  const safeLimit = Math.max(10, Math.min(2000, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 50));
  const filtered = allFiltered.slice(safeOffset, safeOffset + safeLimit);
  const totalFiltered = allFiltered.length;
  const hasMore = safeOffset + filtered.length < totalFiltered;

  const modelsBreakdown = Array.from(byModel.values())
    .map((m) => ({
      ...m,
      cacheHitPct: m.inputTokens > 0 ? Number(((m.cacheReadTokens / m.inputTokens) * 100).toFixed(1)) : 0,
      costUsd: Number(m.costUsd.toFixed(4)),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);

  const modelHealth = buildModelHealth(rangeRows, {
    range,
    selectedDate,
    nowMs,
    slotCount: 12,
  });

  return {
    ok: true,
    range,
    selectedDate,
    conversationId: convoFilter,
    updatedAtMs: nowMs,
    todaySummary,
    summary: {
      totalRequests,
      totalTokens: totalInput + totalOutput,
      totalInput,
      totalCacheRead,
      totalOutput,
      cacheHitPct: totalInput > 0 ? Number(((totalCacheRead / totalInput) * 100).toFixed(1)) : 0,
      totalCostUsd: Number(totalCostUsd.toFixed(4)),
      anomalyCount,
      errorCount,
      avgResponseMs: respCount > 0 ? Math.round(respSumMs / respCount) : null,
      avgTtftMs: ttftCount > 0 ? Math.round(ttftSumMs / ttftCount) : null,
    },
    availableModels: Array.from(modelSet).sort(),
    modelsBreakdown,
    modelHealth,
    heatmap,
    pagination: {
      totalFiltered,
      offset: safeOffset,
      limit: safeLimit,
      returned: filtered.length,
      hasMore,
    },
    requests: filtered.map((r) => ({
      ...r,
      conversationTitle: r.conversationTitle || (r.conversationId ? `会话 #${String(r.conversationId).slice(0, 8)}` : '未命名会话'),
      cacheHitPct: Number((r.cacheHitPct || 0).toFixed(1)),
      costUsd: Number((r.costUsd || 0).toFixed(5)),
    })),
  };
}
