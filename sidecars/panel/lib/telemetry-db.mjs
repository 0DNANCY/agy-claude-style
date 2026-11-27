// Read-only local transcript telemetry aggregator for AGY Claude Style Aux Pane Dashboard.
// Parses ~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl with mtime caching,
// computes reference USD cost, detects short-interval cache-drop anomalies, and builds a 53-week heatmap.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

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

function parsePbDurationMs(rawBuf, maxMs = 600_000) {
  if (!rawBuf || !rawBuf.length) return null;
  const dur = parsePbMap(rawBuf);
  if (!dur.has(1) && !dur.has(2)) return null;
  const sec = Number(dur.get(1)?.[0] || 0);
  const nanos = Number(dur.get(2)?.[0] || 0);
  if (!Number.isFinite(sec) || !Number.isFinite(nanos) || sec < 0 || nanos < 0 || nanos >= 1e9) return null;
  const ms = Math.round((sec + nanos / 1e9) * 1000);
  if (!Number.isFinite(ms) || ms < 0 || ms > maxMs) return null;
  return ms;
}

export function parseGenMetadataTiming(rawData) {
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
  const ttftMs = m1.has(11) ? parsePbDurationMs(m1.get(11)[0], 600_000) : null;
  const streamMs = m1.has(12) ? parsePbDurationMs(m1.get(12)[0], 3_600_000) : null;
  if (ttftMs === null && streamMs === null) return null;
  return { stepIndices, ttftMs, streamMs };
}

export function parseGenMetadataTtft(rawData) {
  const timing = parseGenMetadataTiming(rawData);
  if (!timing || timing.ttftMs === null) return null;
  return { stepIndices: timing.stepIndices, ttftMs: timing.ttftMs };
}

const MAX_CACHE_ENTRIES = 160;
const MAX_TRANSCRIPT_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_LINE_JSON_PARSE_BYTES = 256 * 1024;
const OVERSIZED_EDGE_CHARS = 64 * 1024;
const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;

function lruSet(map, key, value, max = MAX_CACHE_ENTRIES) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

export function medianNumber(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const dbTtftCache = new Map();
const summaryTitlesCache = new Map();

export function readConversationTitlesMap(summaryDbPath) {
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync || !summaryDbPath || !existsSync(summaryDbPath)) return null;
  let mtimeKey = '';
  try {
    const st = statSync(summaryDbPath);
    const walPath = `${summaryDbPath}-wal`;
    const walSt = existsSync(walPath) ? statSync(walPath) : null;
    mtimeKey = `${st.mtimeMs}:${st.size}:${walSt ? `${walSt.mtimeMs}:${walSt.size}` : '0'}`;
  } catch {
    return null;
  }
  const cached = summaryTitlesCache.get(summaryDbPath);
  if (cached && cached.mtimeKey === mtimeKey) return cached.map;

  const map = new Map();
  let db = null;
  try {
    db = new DatabaseSync(summaryDbPath, { readOnly: true });
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_summaries'")
      .get();
    if (hasTable) {
      const rows = db
        .prepare('SELECT conversation_id, title, agent_name, parent_conversation_id FROM conversation_summaries')
        .all();
      const rawTitles = new Map();
      for (const row of rows) {
        const cid = String(row?.conversation_id || '').trim();
        const title = String(row?.title || '').trim();
        if (cid && title) rawTitles.set(cid, title);
      }
      for (const row of rows) {
        const cid = String(row?.conversation_id || '').trim();
        if (!cid) continue;
        const title = String(row?.title || '').trim();
        if (title) {
          map.set(cid, title);
          continue;
        }
        const agentName = String(row?.agent_name || '').trim();
        if (agentName) {
          const parentId = String(row?.parent_conversation_id || '').trim();
          const parentTitle = parentId ? rawTitles.get(parentId) || '' : '';
          map.set(cid, parentTitle ? `${parentTitle} · @${agentName}` : `@${agentName}`);
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
  lruSet(summaryTitlesCache, summaryDbPath, { mtimeKey, map }, 16);
  return map;
}

export function readConversationTimingMap(dbPath) {
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
  if (cached && cached.mtimeKey === mtimeKey) return cached;

  const ttftMap = new Map();
  const streamMap = new Map();
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_metadata'")
      .get();
    if (hasTable) {
      const rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx ASC').all();
      for (const row of rows) {
        const parsed = parseGenMetadataTiming(row.data);
        if (!parsed) continue;
        for (const sIdx of parsed.stepIndices) {
          if (parsed.ttftMs !== null) ttftMap.set(sIdx, parsed.ttftMs);
          if (parsed.streamMs !== null) streamMap.set(sIdx, parsed.streamMs);
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
  const entry = { mtimeKey, ttftMap, streamMap };
  lruSet(dbTtftCache, dbPath, entry, MAX_CACHE_ENTRIES);
  return entry;
}

export function readConversationTtftMap(dbPath) {
  return readConversationTimingMap(dbPath)?.ttftMap || null;
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

function projectOversizedTranscriptLine(edgeText) {
  // Allowlist scalar projection over head+tail windows of huge (>256 KiB) JSONL lines so multi-MB
  // tool/response bodies never hit JSON.parse or bloat the 192 MiB sidecar heap.
  const typeMatch = edgeText.match(/"type"\s*:\s*"([A-Z0-9_]+)"/);
  if (!typeMatch) return null;
  const type = typeMatch[1];
  if (
    type !== 'PLANNER_RESPONSE' &&
    type !== 'ERROR_MESSAGE' &&
    type !== 'CHECKPOINT' &&
    type !== 'USER_INPUT' &&
    !/compact/i.test(type)
  ) {
    return null;
  }
  const numField = (name) => {
    const m = edgeText.match(new RegExp(`"${name}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
    return m ? Number(m[1]) : undefined;
  };
  const strField = (name) => {
    const m = edgeText.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){0,256})`));
    if (!m) return undefined;
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  };
  return {
    type,
    step_index: numField('step_index'),
    created_at: strField('created_at'),
    completed_at: strField('completed_at'),
    finished_at: strField('finished_at'),
    model: strField('model'),
    status: strField('status'),
    input_tokens: numField('input_tokens'),
    cache_read_tokens: numField('cache_read_tokens'),
    cache_write_tokens: numField('cache_write_tokens'),
    output_tokens: numField('output_tokens'),
    duration_ms: numField('duration_ms'),
    latency_ms: numField('latency_ms'),
    elapsed_ms: numField('elapsed_ms'),
    ttft_ms: numField('ttft_ms'),
    time_to_first_token_ms: numField('time_to_first_token_ms'),
    streaming_duration_ms: numField('streaming_duration_ms'),
    stream_ms: numField('stream_ms'),
    content: type === 'USER_INPUT' || type === 'ERROR_MESSAGE' ? strField('content') : undefined,
  };
}

function parseLineToProjectedObj(line, needTitle, oversized = false) {
  if (!line || line[0] !== '{') return null;
  const isRelevant =
    line.includes('"PLANNER_RESPONSE"') ||
    line.includes('"ERROR_MESSAGE"') ||
    line.includes('"CHECKPOINT"') ||
    (needTitle && line.includes('"USER_INPUT"')) ||
    /compact/i.test(line.slice(0, 180));
  if (!isRelevant) {
    // Retain only a tiny { type, created_at } anchor for next-step latency derivation without buffering body text.
    const edge =
      line.length > 1024 ? `${line.slice(0, 512)} ${line.slice(-512)}` : line;
    const created = edge.match(/"created_at"\s*:\s*"([^"\\]{1,64})"/);
    if (!created) return null;
    const typeM = edge.match(/"type"\s*:\s*"([A-Z0-9_]+)"/);
    return { type: typeM ? typeM[1] : 'STEP', created_at: created[1] };
  }
  if (oversized || line.length > MAX_LINE_JSON_PARSE_BYTES) {
    const edgeText =
      line.length > OVERSIZED_EDGE_CHARS * 2
        ? `${line.slice(0, OVERSIZED_EDGE_CHARS)} ${line.slice(-OVERSIZED_EDGE_CHARS)}`
        : line;
    return projectOversizedTranscriptLine(edgeText);
  }
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function buildRequestsFromProjectedObjs(parsedObjs, conversationId, sourceLabel) {
  const requests = [];
  let lastErrorText = '';
  let sawCompactionBeforeNext = false;
  let conversationTitle = '';

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
        streamMs: null,
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

    const totalIn = inputTokens + cacheReadTokens;
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
    let streamMs = null;
    const explicitStream = Number(obj.streaming_duration_ms ?? obj.stream_ms);
    if (Number.isFinite(explicitStream) && explicitStream >= 0 && explicitStream <= 3_600_000) {
      streamMs = Math.round(explicitStream);
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
      streamMs,
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

export function parseTranscriptJsonl(rawText = '', conversationId = '', sourceLabel = 'local') {
  if (!rawText) return [];
  const lines = String(rawText).split(/\r?\n/);
  const parsedObjs = [];
  let sawUserTitle = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const obj = parseLineToProjectedObj(line, !sawUserTitle);
    if (!obj) continue;
    if (obj.type === 'USER_INPUT') sawUserTitle = true;
    parsedObjs.push({ idx: i, obj });
  }
  return buildRequestsFromProjectedObjs(parsedObjs, conversationId, sourceLabel);
}

/**
 * Bounded 64 KiB chunked streaming reader for local transcript.jsonl files.
 * Keeps head + rolling tail windows for oversized (>256 KiB) lines so trailing token scalars
 * are preserved without loading multi-MB bodies into V8 heap.
 */
export function parseTranscriptFileBounded(
  filePath,
  conversationId = '',
  sourceLabel = 'local',
  { maxBytes = MAX_TRANSCRIPT_SCAN_BYTES, chunkBytes = TRANSCRIPT_CHUNK_BYTES } = {}
) {
  let fd = null;
  const parsedObjs = [];
  let lineIdx = 0;
  let sawUserTitle = false;
  let truncated = false;
  try {
    fd = openSync(filePath, 'r');
    const st = fstatSync(fd);
    const fileSize = Number(st?.size || 0);
    const buf = Buffer.allocUnsafe(chunkBytes);

    const readSlice = (startOffset, byteBudget, skipFirstLine = false) => {
      const decoder = new StringDecoder('utf8');
      let carry = '';
      let oversizedHead = '';
      let oversizedTail = '';
      let isOversized = false;
      let totalRead = 0;
      let skippedInitialPartial = !skipFirstLine;

      const emitLine = (text, oversized) => {
        if (!skippedInitialPartial) {
          skippedInitialPartial = true;
          return;
        }
        const idx = lineIdx++;
        const trimmed = text.trim();
        const obj = parseLineToProjectedObj(trimmed, !sawUserTitle, oversized);
        if (!obj) return;
        if (obj.type === 'USER_INPUT') sawUserTitle = true;
        parsedObjs.push({ idx, obj });
      };

      const appendOversized = (part) => {
        if (!part) return;
        if (part.length >= OVERSIZED_EDGE_CHARS) {
          oversizedTail = part.slice(-OVERSIZED_EDGE_CHARS);
        } else {
          const merged = oversizedTail + part;
          oversizedTail = merged.length > OVERSIZED_EDGE_CHARS ? merged.slice(-OVERSIZED_EDGE_CHARS) : merged;
        }
      };

      const feedChunk = (chunkStr) => {
        if (!chunkStr) return;
        let start = 0;
        for (;;) {
          const nl = chunkStr.indexOf('\n', start);
          if (nl === -1) break;
          const piece = chunkStr.slice(start, nl);
          start = nl + 1;
          if (isOversized) {
            appendOversized(piece);
            emitLine(`${oversizedHead} ${oversizedTail}`, true);
            oversizedHead = '';
            oversizedTail = '';
            isOversized = false;
          } else {
            emitLine(carry + piece, false);
            carry = '';
          }
        }
        const rem = chunkStr.slice(start);
        if (isOversized) {
          appendOversized(rem);
        } else if (carry.length + rem.length > MAX_LINE_JSON_PARSE_BYTES) {
          const combined = carry + rem;
          oversizedHead = combined.slice(0, OVERSIZED_EDGE_CHARS);
          oversizedTail = combined.slice(-OVERSIZED_EDGE_CHARS);
          carry = '';
          isOversized = true;
        } else {
          carry += rem;
        }
      };

      for (;;) {
        const remaining = byteBudget - totalRead;
        if (remaining <= 0) break;
        const n = readSync(fd, buf, 0, Math.min(chunkBytes, remaining), startOffset + totalRead);
        if (n <= 0) break;
        totalRead += n;
        feedChunk(decoder.write(buf.subarray(0, n)));
      }
      feedChunk(decoder.end());
      if (isOversized) emitLine(`${oversizedHead} ${oversizedTail}`, true);
      else if (carry) emitLine(carry, false);
    };

    if (fileSize > maxBytes && maxBytes > 0) {
      truncated = true;
      const headBudget = Math.min(256 * 1024, Math.max(0, fileSize - maxBytes));
      if (headBudget > 0) {
        readSlice(0, headBudget, false);
        const titleEntry = parsedObjs.find((p) => p.obj?.type === 'USER_INPUT');
        parsedObjs.length = 0;
        if (titleEntry) parsedObjs.push(titleEntry);
      }
      const tailOffset = Math.max(0, fileSize - maxBytes);
      readSlice(tailOffset, fileSize - tailOffset, tailOffset > 0);
    } else {
      readSlice(0, maxBytes, false);
    }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
  const rows = buildRequestsFromProjectedObjs(parsedObjs, conversationId, sourceLabel);
  if (truncated) {
    Object.defineProperty(rows, '_truncated', { value: true, enumerable: false });
  }
  return rows;
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

  const cells = [];
  let maxTokens = 0;
  for (let i = 0; i < totalDays; i++) {
    const dt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (totalDays - 1 - i));
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
  summaryDbPath,
  maxConversations = 160,
} = {}) {
  if (!existsSync(brainDir)) return [];
  const convDir = conversationsDir || join(dirname(brainDir), 'conversations');
  const resolvedSummaryDb = summaryDbPath || join(dirname(brainDir), 'conversation_summaries.db');
  const titleMap = readConversationTitlesMap(resolvedSummaryDb);
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

  let realBrainRoot = brainDir;
  try {
    realBrainRoot = realpathSync(brainDir);
  } catch {}
  const rootPrefix = realBrainRoot.endsWith(sep) ? realBrainRoot : `${realBrainRoot}${sep}`;

  for (const c of selected) {
    const dbPath = join(convDir, `${c.id}.db`);
    const timing = readConversationTimingMap(dbPath);
    const ttftMap = timing?.ttftMap || null;
    const streamMap = timing?.streamMap || null;
    const summaryTitle = titleMap?.get(c.id) || '';
    const cached = fileCache.get(c.logPath);
    let rows;
    if (cached && cached.mtimeMs === c.mtimeMs && cached.size === c.size) {
      rows = cached.rows;
    } else {
      try {
        const realLog = realpathSync(c.logPath);
        const withinRoot =
          process.platform === 'win32'
            ? realLog.toLowerCase().startsWith(rootPrefix.toLowerCase())
            : realLog.startsWith(rootPrefix);
        if (!withinRoot) continue;
        rows = parseTranscriptFileBounded(realLog, c.id, 'local');
        lruSet(fileCache, c.logPath, { mtimeMs: c.mtimeMs, size: c.size, rows }, MAX_CACHE_ENTRIES);
      } catch {
        continue;
      }
    }
    for (const r of rows) {
      const hasDbTtft = Boolean(ttftMap && Number.isInteger(r.stepIndex) && ttftMap.has(r.stepIndex));
      const hasDbStream = Boolean(streamMap && Number.isInteger(r.stepIndex) && streamMap.has(r.stepIndex));
      const nextTtft = hasDbTtft ? ttftMap.get(r.stepIndex) : r.ttftMs;
      const nextStream = hasDbStream ? streamMap.get(r.stepIndex) : r.streamMs ?? null;
      const nextTitle = summaryTitle || r.conversationTitle;
      if (nextTtft !== r.ttftMs || nextStream !== (r.streamMs ?? null) || nextTitle !== r.conversationTitle) {
        all.push({ ...r, ttftMs: nextTtft, streamMs: nextStream, conversationTitle: nextTitle });
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
        ttftValues: [],
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
      entry.ttftValues.push(r.ttftMs);
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
      const medianTtftRaw = medianNumber(m.ttftValues);
      const medianTtftMs = medianTtftRaw !== null ? Math.round(medianTtftRaw) : null;
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
        medianTtftMs,
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
  summaryDbPath,
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
  const localReqs = readLocalBrainRequests({ brainDir, conversationsDir, summaryDbPath });
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
  const allTtftValues = [];
  let qualDecodeOut = 0;
  let qualDecodeSec = 0;
  let qualE2eOut = 0;
  let qualE2eSec = 0;
  let quarantinedRateCount = 0;

  const isQualifiedDecode = (r) => {
    const sdMs = Number.isFinite(r.streamMs) && r.streamMs > 0 ? r.streamMs : null;
    const out = Number(r.outputTokens || 0);
    if (sdMs === null || out <= 0) return { ok: false, quarantined: false, sdSec: 0 };
    const sdSec = sdMs / 1000;
    const ttftSec = Number.isFinite(r.ttftMs) && r.ttftMs >= 0 ? r.ttftMs / 1000 : null;
    const shortBurst = sdSec < 0.3 && out >= 30 && ttftSec !== null && ttftSec >= 2 && ttftSec / sdSec >= 15;
    if (shortBurst || sdSec < 1 || out < 30) return { ok: false, quarantined: true, sdSec };
    return { ok: true, quarantined: false, sdSec, ttftSec };
  };

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
      allTtftValues.push(r.ttftMs);
    }

    let m = byModel.get(r.model);
    if (!m) {
      m = {
        model: r.model,
        requests: 0,
        errorCount: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        anomalies: 0,
        _ttfts: [],
        _decodeOut: 0,
        _decodeSec: 0,
        _e2eOut: 0,
        _e2eSec: 0,
      };
      byModel.set(r.model, m);
    }
    m.requests += 1;
    if (r.status === 'error') m.errorCount += 1;
    m.inputTokens += r.inputTokens || 0;
    m.cacheReadTokens += r.cacheReadTokens || 0;
    m.outputTokens += r.outputTokens || 0;
    m.costUsd += r.costUsd || 0;
    if (r.anomaly) m.anomalies += 1;
    if (Number.isFinite(r.ttftMs) && r.ttftMs >= 0) m._ttfts.push(r.ttftMs);

    const qd = isQualifiedDecode(r);
    if (qd.ok) {
      qualDecodeOut += r.outputTokens;
      qualDecodeSec += qd.sdSec;
      m._decodeOut += r.outputTokens;
      m._decodeSec += qd.sdSec;
      if (qd.ttftSec !== null) {
        qualE2eOut += r.outputTokens;
        qualE2eSec += qd.ttftSec + qd.sdSec;
        m._e2eOut += r.outputTokens;
        m._e2eSec += qd.ttftSec + qd.sdSec;
      }
    } else if (qd.quarantined) {
      quarantinedRateCount += 1;
    }
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
    .map((m) => {
      const med = medianNumber(m._ttfts);
      return {
        model: m.model,
        requests: m.requests,
        errorCount: m.errorCount,
        inputTokens: m.inputTokens,
        cacheReadTokens: m.cacheReadTokens,
        outputTokens: m.outputTokens,
        totalTokens: m.inputTokens + m.outputTokens,
        anomalies: m.anomalies,
        cacheHitPct: m.inputTokens > 0 ? Number(((m.cacheReadTokens / m.inputTokens) * 100).toFixed(1)) : null,
        medianTtftMs: med !== null ? Math.round(med) : null,
        decodeTps: m._decodeSec > 0 ? Number((m._decodeOut / m._decodeSec).toFixed(1)) : null,
        e2eTps: m._e2eSec > 0 ? Number((m._e2eOut / m._e2eSec).toFixed(1)) : null,
        costUsd: Number(m.costUsd.toFixed(4)),
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);

  const summaryMedianTtft = medianNumber(allTtftValues);

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
      medianTtftMs: summaryMedianTtft !== null ? Math.round(summaryMedianTtft) : null,
      decodeTps: qualDecodeSec > 0 ? Number((qualDecodeOut / qualDecodeSec).toFixed(1)) : null,
      e2eTps: qualE2eSec > 0 ? Number((qualE2eOut / qualE2eSec).toFixed(1)) : null,
      quarantinedRateCount,
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
