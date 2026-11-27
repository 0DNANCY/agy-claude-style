// Subagent & Swarm tree fetcher for AGY Claude Style Aux Pane Dashboard.
// Queries Antigravity Language Server ListConversations + GetAllCascadeTrajectories
// over loopback HTTP (bypassing proxy/bad-ports) to build parent -> child subagent trees.
import { callLsRpcWithRecovery } from './ls-discovery.mjs';

function callRpc(service, method, payload = {}, { env = process.env, fetchFn = null, timeoutMs = 2500, allowRediscover = true } = {}) {
  const addr = String(env?.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const token = String(env?.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (addr === 'test.invalid') {
    return Promise.resolve({ ok: false, reason: 'no_ls_address' });
  }
  const rpcPath = `/${service}/${method}`;
  const headers = {
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    ...(token ? { 'x-antigravity-csrf-token': token, 'x-codeium-csrf-token': token } : {}),
  };
  if (typeof fetchFn === 'function') {
    if (!addr) return Promise.resolve({ ok: false, reason: 'no_ls_address' });
    const url = `http://${addr}${rpcPath}`;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    return fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload || {}),
      signal: ctrl?.signal,
    })
      .then(async (res) => {
        if (!res.ok) return { ok: false, reason: `http_${res.status}` };
        const data = await res.json();
        return { ok: true, data };
      })
      .catch((err) => ({ ok: false, reason: err?.message || 'rpc_error' }))
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  }

  return callLsRpcWithRecovery(service, method, payload, {
    lsAddress: addr,
    csrfToken: token,
    timeoutMs,
    allowRediscover: allowRediscover && env === process.env,
  });
}

export function normalizeChildSubagent(conv, trajSummary) {
  const meta = trajSummary?.trajectoryMetadata || {};
  const spec = meta.subagentSpec || {};
  const scriptName = String(meta.agentScript?.name || '').trim();
  const typeName = String(spec.typeName || '').toLowerCase();
  const rawRole = String(spec.role || '').trim();
  const isSwarm =
    typeName === 'worker' ||
    /^swarm\s+worker/i.test(rawRole) ||
    /^@/.test(String(conv?.annotations?.title || ''));

  let title = '';
  if (isSwarm) {
    const swarmName =
      scriptName ||
      rawRole.replace(/^Swarm Worker\s*\((.+)\)$/i, '$1').trim() ||
      String(conv?.annotations?.title || '').trim();
    title = swarmName ? (swarmName.startsWith('@') ? swarmName : `@${swarmName}`) : 'Swarm Worker';
  } else {
    title =
      rawRole ||
      String(conv?.annotations?.title || '').trim() ||
      String(trajSummary?.summary || '').trim() ||
      scriptName ||
      'Subagent';
  }

  const runState = String(conv?.state?.runState || '').toUpperCase();
  const sumStatus = String(trajSummary?.status || '').toUpperCase();
  const term = String(trajSummary?.latestExecutorTerminationReason || '').toUpperCase();

  let state = 'done';
  if (runState === 'RUN_STATE_RUNNING' || sumStatus.includes('RUNNING')) {
    state = 'running';
  } else if (runState === 'RUN_STATE_CANCELLING' || sumStatus.includes('CANCELLING')) {
    state = 'cancelling';
  } else if (
    term.includes('CANCELED') ||
    term.includes('TERMINAL_CUSTOM_HOOK') ||
    sumStatus.includes('CANCELLED')
  ) {
    state = 'stopped';
  } else if (term.includes('ERROR') || sumStatus.includes('ERROR')) {
    state = 'error';
  }

  return {
    id: String(conv?.id || ''),
    title,
    kind: isSwarm ? 'swarm' : 'subagent',
    state,
    runState: runState || 'RUN_STATE_IDLE',
    stepCount: Number(trajSummary?.stepCount || 0),
    createdAt: String(conv?.metadata?.createTime || meta.createdAt || trajSummary?.createdTime || ''),
  };
}

const SUBAGENT_CACHE_TTL_MS = 4000;
let subagentCache = { data: null, expiresAt: 0 };
let subagentInFlight = null;

async function fetchSubagentTreeUncached({ env = process.env, fetchFn = null } = {}) {
  const listRes = await callRpc(
    'product.v1.ConversationService',
    'ListConversations',
    { pageSize: 30, includeArchived: false },
    { env, fetchFn }
  );
  if (!listRes.ok) {
    return {
      ok: true,
      available: false,
      reason: listRes.reason || 'unavailable',
      running: [],
      recent: [],
      checkedAt: new Date().toISOString(),
    };
  }

  const convos = Array.isArray(listRes.data?.conversations) ? listRes.data.conversations : [];
  const normalizeConvo = (c) => ({
    id: String(c?.id || ''),
    title: String(c?.annotations?.title || c?.state?.summary || 'Untitled Conversation').trim(),
    runState: String(c?.state?.runState || 'RUN_STATE_IDLE'),
    updateTime: c?.state?.updateTime || c?.metadata?.createTime || null,
    subagentCount: 0,
    activeSubagentCount: 0,
    subagents: [],
    stepCount: 0,
  });

  const normalized = convos.map(normalizeConvo);
  const running = normalized.filter(
    (c) => c.runState === 'RUN_STATE_RUNNING' || c.runState === 'RUN_STATE_CANCELLING'
  );
  const recent = normalized
    .filter((c) => c.runState !== 'RUN_STATE_RUNNING' && c.runState !== 'RUN_STATE_CANCELLING')
    .slice(0, 3);

  const targets = running.length > 0 ? running.slice(0, 5) : recent.slice(0, 2);
  if (targets.length > 0) {
    let summaries = {};
    const sumRes = await callRpc(
      'exa.language_server_pb.LanguageServerService',
      'GetAllCascadeTrajectories',
      {},
      { env, fetchFn }
    );
    if (sumRes.ok && sumRes.data?.trajectorySummaries && typeof sumRes.data.trajectorySummaries === 'object') {
      summaries = sumRes.data.trajectorySummaries;
    }

    for (const item of recent) {
      const sc = Number(summaries?.[item.id]?.stepCount || 0);
      if (sc > 0) item.stepCount = sc;
    }

    await Promise.all(
      targets.map(async (item) => {
        item.stepCount = Number(summaries?.[item.id]?.stepCount || 0);
        const subRes = await callRpc(
          'product.v1.ConversationService',
          'ListConversations',
          { pageSize: 30, parentConversationId: item.id, includeArchived: false },
          { env, fetchFn }
        );
        if (subRes.ok && Array.isArray(subRes.data?.conversations)) {
          const mapped = subRes.data.conversations
            .map((s) => normalizeChildSubagent(s, summaries?.[s?.id]))
            .sort((a, b) => (Date.parse(a.createdAt || 0) || 0) - (Date.parse(b.createdAt || 0) || 0));
          item.subagents = mapped;
          item.subagentCount = mapped.length;
          item.activeSubagentCount = mapped.filter(
            (s) => s.state === 'running' || s.state === 'cancelling'
          ).length;
        }
      })
    );
  }

  return {
    ok: true,
    available: true,
    running,
    recent,
    checkedAt: new Date().toISOString(),
  };
}

export async function fetchSubagentTree({ env = process.env, fetchFn = null, force = false } = {}) {
  const canCache = !force && typeof fetchFn !== 'function' && env === process.env;
  if (!canCache) {
    return fetchSubagentTreeUncached({ env, fetchFn });
  }
  const now = Date.now();
  if (subagentCache.data && now < subagentCache.expiresAt) {
    return subagentCache.data;
  }
  if (subagentInFlight) {
    return subagentInFlight;
  }
  subagentInFlight = fetchSubagentTreeUncached({ env, fetchFn })
    .then((res) => {
      if (res && res.ok) {
        subagentCache = { data: res, expiresAt: Date.now() + SUBAGENT_CACHE_TTL_MS };
      }
      return res;
    })
    .finally(() => {
      subagentInFlight = null;
    });
  return subagentInFlight;
}
