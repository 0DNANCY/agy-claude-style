// Official Reference Pricing Sync & Local Cache for AGY Claude Style Dashboard.
// Fetches structured public API reference pricing (LiteLLM official model catalog with jsDelivr fallback),
// caches atomically to plugin_data/pricing-cache.json, and falls back gracefully to built-in reference rates.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const BUILTIN_MODEL_PRICING = [
  { match: /opus/i, inputPerM: 15.0, cacheReadPerM: 1.5, outputPerM: 75.0 },
  { match: /sonnet/i, inputPerM: 3.0, cacheReadPerM: 0.3, outputPerM: 15.0 },
  { match: /haiku/i, inputPerM: 0.8, cacheReadPerM: 0.08, outputPerM: 4.0 },
  { match: /gemini.*flash/i, inputPerM: 0.15, cacheReadPerM: 0.0375, outputPerM: 0.6 },
  { match: /gemini.*pro|gemini-4|gemini-3/i, inputPerM: 1.25, cacheReadPerM: 0.31, outputPerM: 10.0 },
  { match: /gpt-5|o3|o4/i, inputPerM: 2.5, cacheReadPerM: 0.625, outputPerM: 10.0 },
  { match: /gpt-4/i, inputPerM: 2.5, cacheReadPerM: 1.25, outputPerM: 10.0 },
  { match: /./, inputPerM: 1.5, cacheReadPerM: 0.3, outputPerM: 6.0 },
];

export const PRICING_SOURCES = [
  {
    name: 'LiteLLM (jsDelivr)',
    url: 'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json',
  },
  {
    name: 'LiteLLM (GitHub)',
    url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  },
];

const RELEVANT_KEY_RE = /^(?:(?:anthropic|openai|gemini|google|vertex_ai)\/)?(claude-|gemini-|gpt-|o[134]-)/i;

function normalizePricingKey(raw = '') {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^(?:anthropic|openai|gemini|google|vertex_ai|models)\//i, '')
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/-thinking$/i, '')
    .replace(/-high$|-medium$|-low$/i, '');
}

export function parseLiteLlmPricingJson(rawObj) {
  const out = {};
  if (!rawObj || typeof rawObj !== 'object') return out;
  for (const [key, entry] of Object.entries(rawObj)) {
    if (!entry || typeof entry !== 'object') continue;
    if (!RELEVANT_KEY_RE.test(key)) continue;
    const inPerTok = Number(entry.input_cost_per_token);
    const outPerTok = Number(entry.output_cost_per_token);
    if (!Number.isFinite(inPerTok) || !Number.isFinite(outPerTok) || inPerTok <= 0 || outPerTok <= 0) {
      continue;
    }
    const cachePerTok = Number(entry.cache_read_input_token_cost);
    const inputPerM = Number((inPerTok * 1_000_000).toFixed(4));
    const outputPerM = Number((outPerTok * 1_000_000).toFixed(4));
    const cacheReadPerM =
      Number.isFinite(cachePerTok) && cachePerTok >= 0
        ? Number((cachePerTok * 1_000_000).toFixed(4))
        : Number((inputPerM * 0.25).toFixed(4));

    const norm = normalizePricingKey(key);
    if (!norm) continue;
    // Prefer canonical unprefixed entries when both prefixed and unprefixed exist
    const isPrefixed = key.includes('/');
    if (!out[norm] || !isPrefixed) {
      out[norm] = { inputPerM, cacheReadPerM, outputPerM };
    }
  }
  return out;
}

export function lookupBuiltinPrice(model = '') {
  const s = String(model || '');
  for (const row of BUILTIN_MODEL_PRICING) {
    if (row.match.test(s)) return row;
  }
  return BUILTIN_MODEL_PRICING[BUILTIN_MODEL_PRICING.length - 1];
}

export function resolveModelPrice(model = '', syncedModels = null) {
  if (syncedModels && typeof syncedModels === 'object') {
    const norm = normalizePricingKey(model);
    if (norm) {
      if (syncedModels[norm]) return syncedModels[norm];
      // Match longest prefix/substring (e.g. "claude-sonnet-4-6" -> "claude-sonnet-4-6-2026...")
      let bestKey = '';
      for (const k of Object.keys(syncedModels)) {
        if (norm.startsWith(k) || k.startsWith(norm)) {
          if (k.length > bestKey.length) bestKey = k;
        }
      }
      if (bestKey) return syncedModels[bestKey];
      // Family alias fallback (e.g. "Claude 4.6 Sonnet" -> claude-sonnet-4-6)
      const tokens = norm.split('-').filter((t) => t && !/^(preview|latest|beta|exp|neon|pro-high)$/.test(t));
      if (tokens.length >= 2) {
        for (const k of Object.keys(syncedModels)) {
          if (tokens.every((t) => k.includes(t))) {
            if (k.length > bestKey.length) bestKey = k;
          }
        }
        if (bestKey) return syncedModels[bestKey];
      }
    }
  }
  return lookupBuiltinPrice(model);
}

function writeAtomicJson(filePath, obj) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

export function createPricingStore({
  cachePath = '',
  fetchFn = globalThis.fetch,
  sources = PRICING_SOURCES,
  ttlMs = 24 * 60 * 60 * 1000,
} = {}) {
  let state = {
    source: 'builtin',
    sourceName: '内置参考单价',
    sourceUrl: '',
    updatedAtMs: 0,
    models: {},
    lastError: '',
  };

  if (cachePath && existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (parsed && typeof parsed.models === 'object' && Object.keys(parsed.models).length > 0) {
        state = {
          source: 'online',
          sourceName: String(parsed.sourceName || '官方参考单价'),
          sourceUrl: String(parsed.sourceUrl || ''),
          updatedAtMs: Number(parsed.updatedAtMs || 0),
          models: parsed.models,
          lastError: '',
        };
      }
    } catch {}
  }

  let inflight = null;

  async function refresh({ force = false, timeoutMs = 8000 } = {}) {
    const now = Date.now();
    if (!force && state.source === 'online' && state.updatedAtMs > 0 && now - state.updatedAtMs < ttlMs) {
      return { ok: true, cached: true, ...getMeta() };
    }
    if (inflight) return inflight;

    inflight = (async () => {
      let lastErr = '';
      for (const src of sources) {
        try {
          const res = await fetchFn(src.url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
          });
          if (!res || !res.ok) {
            lastErr = `HTTP ${res?.status || 'ERR'} (${src.name})`;
            continue;
          }
          const json = await res.json();
          const models = parseLiteLlmPricingJson(json);
          const count = Object.keys(models).length;
          if (count === 0) {
            lastErr = `未解析到有效模型单价 (${src.name})`;
            continue;
          }
          state = {
            source: 'online',
            sourceName: src.name,
            sourceUrl: src.url,
            updatedAtMs: Date.now(),
            models,
            lastError: '',
          };
          if (cachePath) {
            try {
              writeAtomicJson(cachePath, {
                sourceName: state.sourceName,
                sourceUrl: state.sourceUrl,
                updatedAtMs: state.updatedAtMs,
                modelCount: count,
                models,
              });
            } catch {}
          }
          return { ok: true, cached: false, ...getMeta() };
        } catch (err) {
          lastErr = `${src.name}: ${err?.message || String(err)}`;
        }
      }
      state.lastError = lastErr || '拉取失败';
      return { ok: false, error: state.lastError, ...getMeta() };
    })();

    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  function lookupPrice(model = '') {
    return resolveModelPrice(model, state.source === 'online' ? state.models : null);
  }

  function getMeta() {
    return {
      source: state.source,
      sourceName: state.sourceName,
      sourceUrl: state.sourceUrl,
      updatedAtMs: state.updatedAtMs,
      modelCount: Object.keys(state.models || {}).length,
      lastError: state.lastError || '',
    };
  }

  return {
    lookupPrice,
    refresh,
    getMeta,
  };
}
