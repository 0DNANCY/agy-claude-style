// Opt-in TUN-free standalone proxy validator, connectivity tester, runtime detector, and launch builder.
// Never touches system proxy settings or signed Antigravity app bundles.
import { execFileSync } from 'node:child_process';
import net from 'node:net';

export const DEFAULT_PROXY_BYPASS = 'localhost,127.0.0.1,::1';
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);
const UNSAFE_CHARS = /[\x00-\x1f\x7f\s'"`\\;$|&<>]/;
const UNSAFE_BYPASS_CHARS = /[\x00-\x1f\x7f'"`\\$|&<>]/;
const REQUIRED_LOOPBACK = ['localhost', '127.0.0.1', '::1'];

export function normalizeProxyUrl(raw = '') {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.length > 256 || UNSAFE_CHARS.test(trimmed)) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  if (parsed.pathname && parsed.pathname !== '/') return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.port) {
    const portNum = Number(parsed.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;
  }
  const auth = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
    : '';
  const host = parsed.hostname.includes(':') && !parsed.hostname.startsWith('[')
    ? `[${parsed.hostname}]`
    : parsed.hostname;
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${auth}${host}${port}`;
}

export function normalizeBypassList(raw = DEFAULT_PROXY_BYPASS) {
  const str = String(raw || '').trim();
  if (UNSAFE_BYPASS_CHARS.test(str)) return DEFAULT_PROXY_BYPASS;
  const parts = str
    .split(/[;,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set(parts.map((p) => p.toLowerCase()));
  for (const req of REQUIRED_LOOPBACK) {
    if (!seen.has(req)) {
      parts.unshift(req);
      seen.add(req);
    }
  }
  return parts.join(',');
}

export function maskProxyUrl(raw = '') {
  const normalized = normalizeProxyUrl(raw);
  if (!normalized) return String(raw || '').trim();
  try {
    const parsed = new URL(normalized);
    if (!parsed.username && !parsed.password) return normalized;
    const host = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname;
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//***@${host}${port}`;
  } catch {
    return normalized;
  }
}

export function buildProxyLaunchOptions({
  proxyEnabled = false,
  proxyUrl = '',
  proxyBypass = DEFAULT_PROXY_BYPASS,
  proxyForceHttp1 = false,
} = {}) {
  if (!proxyEnabled) return { args: [], env: {} };
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return { args: [], env: {} };
  const bypass = normalizeBypassList(proxyBypass);
  const chromiumBypass = bypass
    .split(',')
    .map((s) => (s === '::1' ? '[::1]' : s))
    .join(';');
  const noProxy = bypass.includes('[::1]') ? bypass : `${bypass},[::1]`;
  const args = [
    `--proxy-server=${normalized}`,
    `--proxy-bypass-list=${chromiumBypass}`,
  ];
  const env = {
    HTTP_PROXY: normalized,
    HTTPS_PROXY: normalized,
    ALL_PROXY: normalized,
    NO_PROXY: noProxy,
    http_proxy: normalized,
    https_proxy: normalized,
    all_proxy: normalized,
    no_proxy: noProxy,
  };
  if (proxyForceHttp1) {
    env.GODEBUG = 'http2client=0';
  }
  return { args, env };
}

export function testProxyConnectivity(rawUrl, { timeoutMs = 4000, connectFn = net.connect } = {}) {
  const normalized = normalizeProxyUrl(rawUrl);
  if (!normalized) {
    return Promise.resolve({ ok: false, error: '代理地址格式无效（仅支持 http / https / socks5 / socks5h）' });
  }
  const parsed = new URL(normalized);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
    ? 443
    : parsed.protocol.startsWith('socks5')
    ? 1080
    : 80;

  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(res);
    };
    const socket = connectFn({ host, port });
    socket.setTimeout(Math.max(500, Number(timeoutMs) || 4000));
    socket.once('connect', () => {
      finish({ ok: true, host, port, latencyMs: Date.now() - started, maskedUrl: maskProxyUrl(normalized) });
    });
    socket.once('timeout', () => {
      finish({ ok: false, host, port, error: '连接超时' });
    });
    socket.once('error', (err) => {
      finish({ ok: false, host, port, error: err?.message || String(err) });
    });
  });
}

export function parseHostProxyFromCommandLine(cmdLine = '') {
  const s = String(cmdLine || '');
  const m = s.match(/--proxy-server=(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const activeProxyRaw = m ? m[1] || m[2] || m[3] || '' : '';
  const activeProxyUrl = normalizeProxyUrl(activeProxyRaw) || '';
  const bypassM = s.match(/--proxy-bypass-list=(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const activeBypass = bypassM ? bypassM[1] || bypassM[2] || bypassM[3] || '' : '';
  const hasHttp2Disabled = /(?:^|\s)GODEBUG=[^\s]*http2client=0/i.test(s);
  return { activeProxyUrl, activeBypass, hasHttp2Disabled };
}

export function detectHostProxyRuntime(
  {
    proxyEnabled = false,
    proxyUrl = '',
    proxyForceHttp1 = false,
  } = {},
  {
    platform = process.platform,
    execFileSyncFn = execFileSync,
    env = process.env,
  } = {}
) {
  const configuredUrl = proxyEnabled ? normalizeProxyUrl(proxyUrl) || '' : '';
  const configured = Boolean(proxyEnabled && configuredUrl);
  let inspected = false;
  let hostPid = null;
  let activeProxyUrl = '';
  let activeBypass = '';
  let forceHttp1Active = /http2client=0/i.test(String(env?.GODEBUG || ''));

  try {
    if (platform === 'darwin' || platform === 'linux') {
      const psOut = String(
        execFileSyncFn('ps', ['-axo', 'pid=,ppid=,command='], {
          encoding: 'utf8',
          timeout: 1500,
          stdio: ['ignore', 'pipe', 'ignore'],
        }) || ''
      );
      const mainRegex =
        platform === 'darwin'
          ? /Antigravity\.app\/Contents\/MacOS\/Antigravity\b/
          : /(?:^|\/)antigravity(?:\s|$)/i;
      const lines = psOut.split('\n');
      for (const line of lines) {
        if (!mainRegex.test(line) || /--type=/.test(line)) continue;
        const m = line.trim().match(/^(\d+)\s+\d+\s+(.+)$/);
        if (!m) continue;
        hostPid = Number(m[1]);
        inspected = true;
        const parsed = parseHostProxyFromCommandLine(m[2]);
        activeProxyUrl = parsed.activeProxyUrl;
        activeBypass = parsed.activeBypass;
        if (parsed.hasHttp2Disabled) forceHttp1Active = true;
        break;
      }
      if (platform === 'darwin' && hostPid && proxyForceHttp1 && !forceHttp1Active) {
        try {
          const envOut = String(
            execFileSyncFn('ps', ['eww', '-p', String(hostPid)], {
              encoding: 'utf8',
              timeout: 1500,
              stdio: ['ignore', 'pipe', 'ignore'],
            }) || ''
          );
          if (/GODEBUG=[^\s]*http2client=0/i.test(envOut)) forceHttp1Active = true;
        } catch {}
      }
    } else if (platform === 'win32') {
      const psOut = String(
        execFileSyncFn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$p = @(Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" | Select-Object ProcessId, CommandLine); if ($p.Count -gt 0) { $p | ConvertTo-Json -Compress }",
          ],
          {
            encoding: 'utf8',
            timeout: 3000,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
          }
        ) || ''
      ).trim();
      if (psOut) {
        const parsedJson = JSON.parse(psOut);
        const rows = Array.isArray(parsedJson) ? parsedJson : parsedJson && typeof parsedJson === 'object' ? [parsedJson] : [];
        for (const row of rows) {
          const cmd = String(row?.CommandLine || '').trim();
          if (!cmd) continue;
          if (/(?:^|\s)--type=/i.test(cmd)) continue;
          if (/(?:sidecar_sdk[\\\/]register_loader\.js|--import=[^\s]*sidecar_sdk|(?:^|\s)(?:-e|--eval)(?:\s|$))/i.test(cmd)) continue;
          hostPid = Number(row.ProcessId) || null;
          inspected = true;
          const parsed = parseHostProxyFromCommandLine(cmd);
          activeProxyUrl = parsed.activeProxyUrl;
          activeBypass = parsed.activeBypass;
          if (parsed.hasHttp2Disabled) forceHttp1Active = true;
          break;
        }
      }
      if (!inspected && env) {
        inspected = true;
        activeProxyUrl = normalizeProxyUrl(env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || '') || '';
      }
    } else if (env) {
      inspected = true;
      activeProxyUrl = normalizeProxyUrl(env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || '') || '';
    }
  } catch {}

  const active = Boolean(activeProxyUrl);
  const matchesConfig = Boolean(configured && active && activeProxyUrl === configuredUrl);
  const missingForceHttp1 = Boolean(configured && proxyForceHttp1 && inspected && !forceHttp1Active);
  const coldStartMismatch = Boolean(configured && inspected && (!matchesConfig || missingForceHttp1));

  let reason = '';
  if (coldStartMismatch) {
    if (!active) {
      reason = '当前 Antigravity 进程冷启动未携带独立代理参数';
    } else if (!matchesConfig) {
      reason = `当前生效代理 (${maskProxyUrl(activeProxyUrl)}) 与配置 (${maskProxyUrl(configuredUrl)}) 不一致`;
    } else if (missingForceHttp1) {
      reason = '已勾选强制 HTTP/1.1，但当前进程尚未注入 GODEBUG=http2client=0';
    }
  }

  return {
    inspected,
    hostPid,
    configured,
    active,
    matchesConfig,
    forceHttp1Requested: Boolean(proxyForceHttp1),
    forceHttp1Active,
    coldStartMismatch,
    reason,
    activeProxyMasked: active ? maskProxyUrl(activeProxyUrl) : '',
    configuredProxyMasked: configured ? maskProxyUrl(configuredUrl) : '',
    activeBypass,
  };
}
