// Opt-in TUN-free standalone proxy validator, connectivity tester, and launch builder.
// Never touches system proxy settings or signed Antigravity app bundles.
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
