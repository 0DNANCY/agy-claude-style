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
  for (const c of cands.slice(0, 60)) {
    try {
      const lines = fs.readFileSync(c.p, 'utf8').split(/\\r?\\n/);
      const filtered = [];
      for (const l of lines) {
        if (!l || l[0] !== '{') continue;
        if (l.includes('"PLANNER_RESPONSE"') || l.includes('"ERROR_MESSAGE"') || l.includes('"CHECKPOINT"')) {
          filtered.push(l);
        }
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
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };

    let child;
    try {
      child = spawnFn(
        'ssh',
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-T', safeHost, 'node', '-e', REMOTE_LOADER],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (err) {
      finish({ ok: false, host: safeHost, requests: [], error: err?.message || String(err) });
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish({ ok: false, host: safeHost, requests: [], error: 'SSH 连接超时' });
    }, Math.max(2000, Number(timeoutMs) || 12000));

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      finish({ ok: false, host: safeHost, requests: [], error: err?.message || String(err) });
    });
    child.on('close', (code) => {
      const idx = stdout.lastIndexOf(PROTOCOL_PREFIX);
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
    remoteCache.set(safeHost, { at: Date.now(), value: result });
  }
  return result;
}
