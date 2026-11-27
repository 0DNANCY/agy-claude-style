// Resilient Language Server discovery & credential recovery for AGY Claude Style panel sidecar.
// Adapted from agy-context-dashboard's discovery.mjs & client.mjs (MIT):
// - Recovers automatically when injected ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN go stale
//   after a Language Server restart or Antigravity 2.34+ daemon credential rotation.
// - Verifies PID-to-port ownership across Windows / macOS / Linux (log ports are hints only).
// - Filters Windows VPN/TUN fake-IP LISTENING rows and supports Get-NetTCPConnection State: 0 fallback.
// - Uses reverse-chunked log tail reading (never loads large logs into memory).

import { execFile } from 'node:child_process';
import { open, readFile, readdir, readlink, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { isPidAlive } from './sidecar-owner.mjs';

const execFileP = promisify(execFile);
const isLanguageServerCmd = (cmd) =>
  /(?:^|[\\/])language_server(?:\.native)?(?:_(?:linux|macos|darwin)(?:_(?:x64|arm64))?)?(?:\.exe)?(?:\s|$)/.test(cmd);
const validPid = (v) => Number.isSafeInteger(v) && v > 0 && v <= 0xffffffff;
const validPort = (v) => Number.isInteger(v) && v > 0 && v <= 65535;
const normalizeAddr = (v) => (typeof v === 'string' ? v.toLowerCase().replace(/^\[|\]$/g, '') : '');
const isLocalAddr = (v) =>
  ['127.0.0.1', '0.0.0.0', '::1', '::', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', 'localhost'].includes(normalizeAddr(v));
const isUnspecifiedAddr = (v) => ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '*'].includes(normalizeAddr(v));
const parseEndpoint = (v) => {
  const m = String(v).match(/^(\[[^\]]+\]|[^:\s]+):(\d+|\*)$/);
  return m ? { address: m[1], port: m[2] } : null;
};
const toInt = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);

export function httpLogPorts(log) {
  const ports = new Set();
  for (const match of String(log || '').matchAll(/listening on random port at (\d+) for HTTP(?:\s|$)/g)) {
    const port = Number(match[1]);
    if (port < 1 || port > 65535) continue;
    ports.delete(port);
    ports.add(port);
  }
  return [...ports].reverse();
}

export async function readLogTail(file, encoding = 'utf8', { chunkBytes = 256 * 1024, maxScanBytes = 32 * 1024 * 1024 } = {}) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size <= 0) return '';
    if (size <= chunkBytes) {
      const buf = Buffer.allocUnsafe(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(buf, offset, size - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return buf.subarray(0, offset).toString(encoding);
    }
    const buf = Buffer.allocUnsafe(chunkBytes);
    const overlap = 128;
    const found = [];
    let scanned = 0;
    let end = size;
    let extraAfterMatch = 0;
    while (end > 0 && scanned < maxScanBytes && found.length < 8) {
      const hadMatch = found.length > 0;
      const start = Math.max(0, end - chunkBytes);
      const len = end - start;
      let readTotal = 0;
      while (readTotal < len) {
        const { bytesRead } = await handle.read(buf, readTotal, len - readTotal, start + readTotal);
        if (!bytesRead) break;
        readTotal += bytesRead;
      }
      if (!readTotal) break;
      for (const p of httpLogPorts(buf.subarray(0, readTotal).toString(encoding))) {
        if (!found.includes(p)) found.push(p);
      }
      if (hadMatch) extraAfterMatch += 1;
      if ((found.length > 0 && extraAfterMatch >= 1) || start === 0) break;
      scanned += readTotal;
      end = start + Math.min(overlap, readTotal - 1);
    }
    if (!found.length) return '';
    return [...found].reverse().map((p) => `listening on random port at ${p} for HTTP\n`).join('');
  } finally {
    await handle.close();
  }
}

export function parseWindowsNetstat(text) {
  const ports = new Map();
  const rejectedPids = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+)\s+(\S+)\s+(?:LISTENING|LISTEN|侦听|监听)\s+(\d+)\s*$/i);
    if (!match) continue;
    const local = parseEndpoint(match[1]);
    const remote = parseEndpoint(match[2]);
    const pid = Number(match[3]);
    if (!validPid(pid)) continue;
    const port = Number(local?.port);
    // TUN drivers can report outbound fake-IP connections as LISTENING.
    if (
      !local ||
      !remote ||
      !isLocalAddr(local.address) ||
      !validPort(port) ||
      !isUnspecifiedAddr(remote.address) ||
      !(remote.port === '0' || (remote.address === '*' && remote.port === '*'))
    ) {
      rejectedPids.add(pid);
      continue;
    }
    if (!ports.has(pid)) ports.set(pid, new Set());
    ports.get(pid).add(port);
  }
  return {
    ports: new Map([...ports].map(([pid, set]) => [pid, [...set]])),
    rejectedPids,
  };
}

export function parsePs(text, uid) {
  return String(text || '').split(/\r?\n/).flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m || Number(m[2]) !== uid || !isLanguageServerCmd(m[3]) || !/--standalone\b/.test(m[3])) return [];
    return [{ ProcessId: Number(m[1]), CommandLine: m[3] }];
  });
}

export function parseLsof(text) {
  let pid = null;
  const ports = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^p\d+$/.test(line)) {
      pid = Number(line.slice(1));
      if (!ports.has(pid)) ports.set(pid, []);
    }
    const port = line[0] === 'n' && line.match(/:(\d+)(?:\s|$)/)?.[1];
    if (pid && port) ports.get(pid).push(Number(port));
  }
  return ports;
}

export function parseProcNet(text) {
  return String(text || '').split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '0A' || !/^\d+$/.test(fields[9] || '')) return [];
    const hex = fields[1]?.split(':')[1];
    const port = /^[0-9A-F]{4}$/i.test(hex || '') ? parseInt(hex, 16) : 0;
    return port > 0 ? [{ inode: fields[9], port }] : [];
  });
}

export function probeLoopbackPort(port, { timeoutMs = 400, signal, connect = createConnection } = {}) {
  if (!validPort(port) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let socket;
    let timer;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket?.destroy();
      resolve(ok);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(false), Math.min(400, timeoutMs));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      socket = connect({ host: '127.0.0.1', port, family: 4 });
      socket.once('error', () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('close', () => finish(false));
      socket.unref?.();
      if (settled) socket.destroy();
    } catch {
      finish(false);
    }
  });
}

export async function discoverWindowsPorts(pids, { run = execFileP, expectedPorts = new Map(), probe = probeLoopbackPort } = {}) {
  const wanted = new Set(pids.filter(validPid));
  if (!wanted.size) return new Map();
  const preferred = new Map();
  for (const pid of wanted) {
    for (const port of expectedPorts.get(pid) || []) {
      if (validPort(port)) {
        preferred.set(pid, port);
        break;
      }
    }
  }
  const { stdout } = await run('netstat.exe', ['-ano', '-p', 'tcp'], {
    windowsHide: true,
    timeout: 4000,
    maxBuffer: 4194304,
  }).catch(() => ({ stdout: '' }));
  const snapshot = parseWindowsNetstat(stdout);
  const ports = new Map([...snapshot.ports].filter(([pid]) => wanted.has(pid)));
  const missing = [...wanted].filter((pid) => {
    const found = ports.get(pid) || [];
    const expected = preferred.get(pid);
    if (expected !== undefined) return !found.includes(expected);
    return !found.length || snapshot.rejectedPids.has(pid);
  });
  if (!missing.length) return ports;

  const script = `$p = @(${missing.join(',')}); Get-NetTCPConnection -OwningProcess $p -ErrorAction SilentlyContinue | Select-Object OwningProcess,LocalAddress,LocalPort,RemoteAddress,RemotePort,State | ConvertTo-Json -Compress`;
  try {
    const { stdout: psOut } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 1048576,
    });
    const cleaned = String(psOut || '').replace(/^\uFEFF/, '').trim();
    const rows = cleaned ? JSON.parse(cleaned) : [];
    const allowed = new Set(missing);
    const uncertain = new Map();
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      const pid = toInt(row?.OwningProcess);
      const port = toInt(row?.LocalPort);
      const state = row?.State;
      const listen = state === 2 || state === '2' || (typeof state === 'string' && /^listen$/i.test(state));
      const tunUnknown = state === 0 || state === '0';
      if (
        !allowed.has(pid) ||
        !validPort(port) ||
        !isLocalAddr(row?.LocalAddress) ||
        !isUnspecifiedAddr(row?.RemoteAddress) ||
        toInt(row?.RemotePort) !== 0
      ) {
        continue;
      }
      if (!(listen || tunUnknown)) {
        if (
          Object.hasOwn(row, 'State') &&
          (state === null || state === '') &&
          port === preferred.get(pid) &&
          uncertain.size < 4 &&
          !uncertain.has(pid)
        ) {
          uncertain.set(pid, port);
        }
        continue;
      }
      if (!ports.has(pid)) ports.set(pid, []);
      if (!ports.get(pid).includes(port)) ports.get(pid).push(port);
    }
    const deadline = performance.now() + 1500;
    for (const [pid, port] of uncertain) {
      if (ports.get(pid)?.includes(port)) continue;
      const rem = Math.min(400, Math.floor(deadline - performance.now()));
      if (rem <= 0) break;
      if (await probe(port, { timeoutMs: rem })) {
        if (!ports.has(pid)) ports.set(pid, []);
        ports.get(pid).push(port);
      }
    }
  } catch {}
  return ports;
}

async function linuxPorts(pid, proc = '/proc') {
  const inodes = new Set();
  for (const fd of await readdir(join(proc, String(pid), 'fd'))) {
    try {
      const link = await readlink(join(proc, String(pid), 'fd', fd));
      const m = link.match(/^socket:\[(\d+)\]$/);
      if (m) inodes.add(m[1]);
    } catch {}
  }
  const rows = [];
  for (const name of ['tcp', 'tcp6']) {
    try {
      rows.push(...parseProcNet(await readFile(join(proc, String(pid), 'net', name), 'utf8')));
    } catch {}
  }
  return [...new Set(rows.filter((r) => inodes.has(r.inode)).map((r) => r.port))];
}

export async function discoverLsProcesses({
  platform = process.platform,
  run = execFileP,
  uid = process.getuid?.(),
  proc = '/proc',
  expectedPorts = [],
} = {}) {
  if (platform === 'win32') {
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='language_server.exe'\" | Where-Object { $_.CommandLine -match '(?:^|\\s)--standalone(?:\\s|=|$)' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 1048576,
    });
    const cleaned = String(stdout || '').replace(/^\uFEFF/, '').trim();
    const parsed = cleaned ? JSON.parse(cleaned) : [];
    const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (r) => validPid(r?.ProcessId) && /(?:^|\s)--standalone(?:\s|=|$)/.test(r?.CommandLine || '')
    );
    if (!rows.length) return [];
    const ports = await discoverWindowsPorts(
      rows.map((r) => r.ProcessId),
      { run, expectedPorts: new Map(rows.map((r) => [r.ProcessId, expectedPorts])) }
    );
    return rows.map((r) => ({ ...r, Ports: ports.get(r.ProcessId) || [] }));
  }
  if (platform === 'darwin') {
    const { stdout } = await run('/bin/ps', ['-ww', '-axo', 'pid=,uid=,args='], { timeout: 8000, maxBuffer: 4194304 });
    const rows = parsePs(stdout, uid);
    if (!rows.length) return [];
    const { stdout: sockOut } = await run(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', rows.map((r) => r.ProcessId).join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn'],
      { timeout: 8000, maxBuffer: 1048576 }
    ).catch((err) => (err?.code === 1 ? { stdout: err.stdout || '' } : Promise.reject(err)));
    const ports = parseLsof(sockOut);
    return rows.map((r) => ({ ...r, Ports: ports.get(r.ProcessId) || [] }));
  }
  if (platform === 'linux') {
    const rows = [];
    for (const pid of (await readdir(proc)).filter((p) => /^\d+$/.test(p))) {
      try {
        const status = await readFile(join(proc, pid, 'status'), 'utf8');
        if (Number(status.match(/^Uid:\s+(\d+)/m)?.[1]) !== uid) continue;
        const cmd = (await readFile(join(proc, pid, 'cmdline'), 'utf8')).split('\0').filter(Boolean).join(' ');
        if (!isLanguageServerCmd(cmd) || !/--standalone\b/.test(cmd)) continue;
        rows.push({ ProcessId: Number(pid), CommandLine: cmd, Ports: await linuxPorts(pid, proc) });
      } catch {}
    }
    return rows;
  }
  return [];
}

export async function resolveDaemonCredential({
  commandLine = '',
  pid,
  ports = [],
  home = homedir(),
  daemonDir = null,
  readFileFn = readFile,
  readdirFn = readdir,
} = {}) {
  const inlineCsrf = String(commandLine || '').match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1];
  if (inlineCsrf) return { csrf: inlineCsrf, daemonHttpPort: null };
  if (!validPid(pid)) return null;
  const rawAppDir = String(commandLine || '').match(/--app_data_dir(?:=|\s+)"?([^\s"]+)/)?.[1] || 'antigravity';
  const appDir = /^[a-zA-Z0-9._-]+$/.test(rawAppDir) ? rawAppDir : 'antigravity';
  const dir = daemonDir || join(home, '.gemini', appDir, 'daemon');
  let names;
  try {
    names = await readdirFn(dir);
  } catch {
    return null;
  }
  const portSet = new Set([ports].flat().map(Number).filter(validPort));
  let fallback = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const data = JSON.parse(await readFileFn(join(dir, name), 'utf8'));
      if (Number(data?.pid) !== pid || typeof data?.csrfToken !== 'string' || !data.csrfToken) continue;
      const httpPort = Number(data.httpPort);
      const httpsPort = Number(data.httpsPort);
      const validHttp = validPort(httpPort) ? httpPort : null;
      const entry = { csrf: data.csrfToken, daemonHttpPort: validHttp };
      if ((validHttp && portSet.has(validHttp)) || (validPort(httpsPort) && portSet.has(httpsPort))) return entry;
      if (!fallback) fallback = entry;
    } catch {}
  }
  return fallback;
}

export function lsLogCandidates({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  const list = [];
  if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    list.push(join(appData, 'Antigravity', 'logs', 'language_server.log'));
    list.push(join(home, '.gemini', 'antigravity', 'logs', 'language_server.log'));
  } else if (platform === 'darwin') {
    list.push(join(home, 'Library', 'Logs', 'Antigravity', 'language_server.log'));
    list.push(join(home, 'Library', 'Application Support', 'Antigravity', 'logs', 'language_server.log'));
  } else if (platform === 'linux') {
    const cfg = env.XDG_CONFIG_HOME || join(home, '.config');
    list.push(join(cfg, 'Antigravity', 'logs', 'language_server.log'));
  }
  return [...new Set(list)];
}

export async function discoverLiveLsEndpoint({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  processesFn = discoverLsProcesses,
  readLogFn = readLogTail,
  statFn = stat,
  resolveDaemonFn = resolveDaemonCredential,
} = {}) {
  const logEntries = [];
  for (const file of lsLogCandidates({ platform, home, env })) {
    try {
      const info = await statFn(file).catch(() => null);
      const tail = await readLogFn(file, 'utf8');
      logEntries.push({ ports: httpLogPorts(tail), mtimeMs: Number.isFinite(info?.mtimeMs) ? info.mtimeMs : -Infinity });
    } catch {}
  }
  logEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const expectedPorts = [...new Set(logEntries.flatMap((e) => e.ports))];

  const procs = await processesFn({ platform, expectedPorts });
  const standalone = (Array.isArray(procs) ? procs : [procs]).filter((p) => /--standalone\b/.test(p?.CommandLine || ''));
  if (standalone.length !== 1) return null;
  const proc = standalone[0];
  const livePorts = new Set([proc.Ports].flat().map(Number).filter(validPort));
  const daemon = await resolveDaemonFn({
    commandLine: proc.CommandLine,
    pid: proc.ProcessId,
    ports: [...livePorts],
    home,
  }).catch(() => null);
  const csrf = proc.CommandLine.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1] || daemon?.csrf || null;
  if (!csrf) return null;

  let port = expectedPorts.find((p) => livePorts.has(p)) || null;
  if (!port && daemon?.daemonHttpPort && livePorts.has(daemon.daemonHttpPort)) port = daemon.daemonHttpPort;
  if (!port) return null;
  return { lsAddress: `127.0.0.1:${port}`, port, csrfToken: csrf, pid: proc.ProcessId };
}

let cachedEndpoint = null;
let cachedAt = 0;
let inFlightDiscovery = null;
let nextRetryAt = 0;

export function resetLsDiscoveryCache() {
  cachedEndpoint = null;
  cachedAt = 0;
  inFlightDiscovery = null;
  nextRetryAt = 0;
}

export async function resolveCachedLsEndpoint({
  force = false,
  discoverFn = discoverLiveLsEndpoint,
  probeFn = probeLoopbackPort,
  aliveCheck = isPidAlive,
  now = Date.now,
} = {}) {
  if (!force && cachedEndpoint && now() - cachedAt < 15_000 && aliveCheck(cachedEndpoint.pid)) {
    if (await probeFn(cachedEndpoint.port, { timeoutMs: 350 }).catch(() => false)) {
      return cachedEndpoint;
    }
  }
  if (!force && !cachedEndpoint && now() < nextRetryAt) return null;
  if (inFlightDiscovery) return inFlightDiscovery;

  inFlightDiscovery = (async () => {
    try {
      const ep = await discoverFn();
      if (ep) {
        cachedEndpoint = ep;
        cachedAt = now();
        nextRetryAt = 0;
        return ep;
      }
      cachedEndpoint = null;
      nextRetryAt = now() + 5000;
      return null;
    } catch {
      cachedEndpoint = null;
      nextRetryAt = now() + 5000;
      return null;
    } finally {
      inFlightDiscovery = null;
    }
  })();
  return inFlightDiscovery;
}

function postJsonLoopback(lsAddress, csrfToken, service, method, payload = {}, { timeoutMs = 2500, requestFn = null } = {}) {
  const normalized = /^https?:\/\//i.test(lsAddress) ? lsAddress : `http://${lsAddress}`;
  let url;
  try {
    url = new URL(`/${service}/${method}`, normalized);
  } catch {
    return Promise.resolve({ ok: false, reason: 'invalid_url', lost: false });
  }
  const cleanHostname = String(url.hostname || '').replace(/^\[|\]$/g, '');
  if (!isLocalAddr(cleanHostname)) {
    return Promise.resolve({ ok: false, reason: 'non_local_host', lost: false });
  }
  const isHttps = url.protocol === 'https:';
  const runner = requestFn || (isHttps ? httpsRequest : httpRequest);
  const body = JSON.stringify(payload || {});
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const req = runner(
      {
        hostname: cleanHostname,
        port: Number(url.port) || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        agent: false,
        ...(isHttps ? { rejectUnauthorized: false } : {}),
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          ...(csrfToken ? { 'x-antigravity-csrf-token': csrfToken, 'x-codeium-csrf-token': csrfToken } : {}),
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes > 16 * 1024 * 1024) {
            req.destroy();
            finish({ ok: false, reason: 'response_too_large', lost: false });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const lost = res.statusCode === 401 || res.statusCode === 403;
            finish({ ok: false, reason: `http_${res.statusCode}`, status: res.statusCode, lost });
            return;
          }
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish({ ok: true, data });
          } catch {
            finish({ ok: false, reason: 'invalid_json', lost: false });
          }
        });
        res.on('error', (err) => finish({ ok: false, reason: err?.message || 'stream_error', lost: true }));
      }
    );
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {}
      finish({ ok: false, reason: 'timeout', lost: false });
    });
    req.on('error', (err) => {
      const lost = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTCONN', 'ENOTFOUND'].includes(err?.code);
      finish({ ok: false, reason: err?.message || 'network_error', lost });
    });
    req.end(body);
  });
}

/**
 * Call an Antigravity LS RPC using env credentials first; on 401/403/ECONNREFUSED (or missing env),
 * automatically rediscovers the live Language Server port & daemon credential and retries once.
 */
export async function callLsRpcWithRecovery(
  service,
  method,
  payload = {},
  {
    lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS,
    csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN,
    timeoutMs = 2500,
    allowRediscover = true,
    discoverFn = discoverLiveLsEndpoint,
    requestFn = null,
  } = {}
) {
  const envAddr = String(lsAddress || '').trim();
  const envToken = String(csrfToken || '').trim();
  if (envAddr === 'test.invalid') {
    return { ok: false, reason: 'no_ls_address' };
  }

  // Prefer already-recovered endpoint if cached, otherwise env endpoint.
  const firstAddr = cachedEndpoint?.lsAddress || envAddr;
  const firstToken = cachedEndpoint?.csrfToken || envToken;

  if (firstAddr) {
    const res = await postJsonLoopback(firstAddr, firstToken, service, method, payload, { timeoutMs, requestFn });
    if (res.ok || !res.lost || !allowRediscover) return res;
    if (cachedEndpoint) {
      cachedEndpoint = null;
      nextRetryAt = 0;
    }
  } else if (!allowRediscover) {
    return { ok: false, reason: 'no_ls_address' };
  }

  // Rediscover live LS process/daemon credential respecting negative-cache backoff.
  const recovered = await resolveCachedLsEndpoint({ force: false, discoverFn });
  if (!recovered) return { ok: false, reason: 'ls_rediscovery_failed' };
  if (recovered.lsAddress === firstAddr && recovered.csrfToken === firstToken) {
    return { ok: false, reason: 'endpoint_unchanged' };
  }
  return postJsonLoopback(recovered.lsAddress, recovered.csrfToken, service, method, payload, { timeoutMs, requestFn });
}
