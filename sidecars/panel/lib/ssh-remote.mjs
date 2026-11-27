// Zero-footprint SSH remote telemetry collector for AGY Claude Style.
// Streams a gzipped read-only Node.js worker over stdin to the remote host (no remote files written).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseTranscriptJsonl } from './telemetry-db.mjs';

const PROTOCOL_PREFIX = '__AGY_CS_SSH__:';
const CACHE_TTL_MS = 60000;
const MAX_CACHE_ENTRIES = 16;
const MAX_SSH_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_SSH_STDERR_BYTES = 256 * 1024;
const remoteCache = new Map();

export function validateSshHost(host) {
  if (typeof host !== 'string') throw new Error('无效的 SSH 主机名');
  const trimmed = host.trim();
  if (!trimmed || trimmed.length > 255 || trimmed.startsWith('-') || /[\x00-\x20\x7f`'"\\;$|&<>]/.test(trimmed)) {
    throw new Error('无效的 SSH 主机名');
  }
  return trimmed;
}

export function listConfiguredSshHosts(homeDir = homedir()) {
  const cfgPath = join(homeDir, '.ssh', 'config');
  if (!existsSync(cfgPath)) return [];
  const hosts = new Set();
  try {
    const raw = readFileSync(cfgPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*Host\s+(.+)$/i);
      if (!m) continue;
      for (const tok of m[1].trim().split(/\s+/)) {
        if (!tok || tok.includes('*') || tok.includes('?') || tok.startsWith('!')) continue;
        try {
          hosts.add(validateSshHost(tok));
        } catch {}
      }
    }
  } catch {}
  return Array.from(hosts);
}

const REMOTE_WORKER_JS = `
const fs = require('fs');
const os = require('os');
const path = require('path');
const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const out = [];
if (fs.existsSync(brainDir)) {
  const dirs = fs.readdirSync(brainDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const cands = [];
  for (const d of dirs) {
    const p = path.join(brainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0) cands.push({ id: d.name, p, mtime: st.mtimeMs });
    } catch {}
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  const keepFields = (obj) => ({
    type: obj.type,
    step_index: obj.step_index,
    created_at: obj.created_at,
    completed_at: obj.completed_at,
    finished_at: obj.finished_at,
    model: obj.model,
    status: obj.status,
    usage: obj.usage,
    input_tokens: obj.input_tokens,
    cache_read_tokens: obj.cache_read_tokens,
    cache_write_tokens: obj.cache_write_tokens,
    output_tokens: obj.output_tokens,
    duration_ms: obj.duration_ms,
    latency_ms: obj.latency_ms,
    elapsed_ms: obj.elapsed_ms,
    ttft_ms: obj.ttft_ms,
    time_to_first_token_ms: obj.time_to_first_token_ms,
    streaming_duration_ms: obj.streaming_duration_ms,
    stream_ms: obj.stream_ms,
    content: (obj.type === 'USER_INPUT' || obj.type === 'ERROR_MESSAGE') && typeof obj.content === 'string'
      ? obj.content.slice(0, 256)
      : undefined
  });
  for (const c of cands.slice(0, 60)) {
    try {
      const lines = fs.readFileSync(c.p, 'utf8').split(/\\r?\\n/);
      const filtered = [];
      let sawTitle = false;
      for (const l of lines) {
        if (!l || l[0] !== '{') continue;
        const rel = l.includes('"PLANNER_RESPONSE"') || l.includes('"ERROR_MESSAGE"') || l.includes('"CHECKPOINT"') || (!sawTitle && l.includes('"USER_INPUT"'));
        if (!rel) continue;
        try {
          const obj = JSON.parse(l);
          if (obj.type === 'USER_INPUT') sawTitle = true;
          filtered.push(JSON.stringify(keepFields(obj)));
        } catch {}
      }
      if (filtered.length) out.push({ id: c.id, lines: filtered });
    } catch {}
  }
}
process.stdout.write('\\n${PROTOCOL_PREFIX}' + JSON.stringify({ ok: true, conversations: out }) + '\\n');
`;

const REMOTE_LOADER =
  'const z=require("zlib");let d="";process.stdin.setEncoding("utf8");' +
  'process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{' +
  'try{const code=z.gunzipSync(Buffer.from(d.trim(),"base64")).toString("utf8");new Function("require",code)(require);}' +
  'catch(e){process.stdout.write("\\n__AGY_CS_SSH__:"+JSON.stringify({ok:false,error:String(e&&e.message||e)})+"\\n");process.exit(1);}});';

export async function fetchSshRemoteRequests(host, { force = false, timeoutMs = 12000, spawnFn = spawn } = {}) {
  const safeHost = validateSshHost(host);
  const cached = remoteCache.get(safeHost);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const payloadB64 = gzipSync(Buffer.from(REMOTE_WORKER_JS, 'utf8')).toString('base64');

  const result = await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutOverflow = false;
    let done = false;
    let timer = null;
    const finish = (val) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(val);
    };

    let child;
    try {
      child = spawnFn(
        'ssh',
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T', safeHost, `node -e '${REMOTE_LOADER}'`],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
    } catch (err) {
      finish({ ok: false, host: safeHost, requests: [], error: err?.message || String(err) });
      return;
    }

    timer = setTimeout(() => {
      try { child.kill?.('SIGTERM'); } catch {}
      finish({ ok: false, host: safeHost, requests: [], error: 'SSH 连接超时' });
    }, Math.max(2000, Number(timeoutMs) || 12000));

    child.stdin?.on?.('error', () => {});
    child.stdout?.on('data', (chunk) => {
      if (stdoutOverflow) return;
      const piece = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stdout.length + piece.length > MAX_SSH_STDOUT_BYTES) {
        stdoutOverflow = true;
        try { child.kill?.('SIGTERM'); } catch {}
        finish({ ok: false, host: safeHost, requests: [], error: 'SSH 输出超出上限' });
        return;
      }
      stdout += piece;
    });
    child.stderr?.on('data', (chunk) => {
      const piece = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stderr.length < MAX_SSH_STDERR_BYTES) {
        stderr += piece.slice(0, MAX_SSH_STDERR_BYTES - stderr.length);
      }
    });
    child.on('error', (err) => {
      finish({ ok: false, host: safeHost, requests: [], error: err?.message || String(err) });
    });
    child.on('close', (code) => {
      const anchoredIdx = stdout.lastIndexOf(`\n${PROTOCOL_PREFIX}`);
      const idx = anchoredIdx >= 0 ? anchoredIdx + 1 : (stdout.startsWith(PROTOCOL_PREFIX) ? 0 : -1);
      if (idx >= 0) {
        const line = stdout.slice(idx + PROTOCOL_PREFIX.length).split(/\r?\n/)[0].trim();
        try {
          const parsed = JSON.parse(line);
          if (parsed && parsed.ok && Array.isArray(parsed.conversations)) {
            const requests = [];
            for (const c of parsed.conversations) {
              const raw = Array.isArray(c.lines) ? c.lines.join('\n') : '';
              const rows = parseTranscriptJsonl(raw, String(c.id || ''), `ssh:${safeHost}`);
              for (const r of rows) requests.push(r);
            }
            finish({ ok: true, host: safeHost, requests, count: requests.length, error: '' });
            return;
          }
          finish({ ok: false, host: safeHost, requests: [], error: parsed?.error || '远端执行失败' });
          return;
        } catch {}
      }
      const errMsg = stderr.trim().split(/\r?\n/).slice(-1)[0] || `SSH 退出码 ${code}`;
      finish({ ok: false, host: safeHost, requests: [], error: errMsg });
    });

    try {
      child.stdin?.end(payloadB64 + '\n');
    } catch {}
  });

  if (result.ok) {
    if (remoteCache.has(safeHost)) remoteCache.delete(safeHost);
    remoteCache.set(safeHost, { at: Date.now(), value: result });
    while (remoteCache.size > MAX_CACHE_ENTRIES) {
      const oldest = remoteCache.keys().next().value;
      if (oldest === undefined) break;
      remoteCache.delete(oldest);
    }
  }
  return result;
}
