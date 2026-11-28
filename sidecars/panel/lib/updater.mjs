// Shared zero-dependency update checker, safe pure-Node ZIP extractor,
// atomic in-place plugin upgrader, and Language Server hot-reloader for AGY Claude Style.
import { execFile, execFileSync, spawn } from 'node:child_process';
import dns from 'node:dns';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { callLsRpcWithRecovery } from './ls-discovery.mjs';
import { isPidAlive } from './sidecar-owner.mjs';

try {
  dns.setDefaultResultOrder?.('ipv4first');
} catch {}

const execFileAsync = promisify(execFile);

export const REPO_OWNER = '0DNANCY';
export const REPO_NAME = 'agy-claude-style';
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
export const RELEASES_PAGE_URL = `${REPO_URL}/releases`;
export const DEFAULT_UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_ZIP_BYTES = 64 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;

const ALLOWED_REMOTE_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'cdn.jsdelivr.net',
]);

const SKIP_TOP_DIRS = new Set(['.git', 'dist', 'node_modules', 'installer', 'test', 'wallpapers']);
const SKIP_BASE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.watch.pid', 'watch.log', 'config.json']);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeAtomicText(filePath, text) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      copyFileSync(tmp, filePath);
    } catch {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
      throw err;
    }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
  }
}

function writeAtomicJson(filePath, obj) {
  writeAtomicText(filePath, JSON.stringify(obj, null, 2) + '\n');
}

export function getPlatformInstallCommand(platform = process.platform) {
  if (platform === 'win32') {
    return `irm https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/install.ps1 | iex`;
  }
  return `curl -fsSL https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/install.sh | bash`;
}

export function normalizeSemver(raw = '') {
  const s = String(raw || '').trim().replace(/^v/i, '').split('+')[0].trim();
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]) || 0,
    minor: Number(m[2] ?? 0) || 0,
    patch: Number(m[3] ?? 0) || 0,
    prerelease: m[4] ? m[4].split('.').filter(Boolean) : [],
    raw: s,
  };
}

/**
 * SemVer 2.0 comparison: returns 1 if a > b, -1 if a < b, 0 if equal/uncomparable.
 */
export function compareSemver(a, b) {
  const pa = normalizeSemver(a);
  const pb = normalizeSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;
  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= aPre.length) return -1;
    if (i >= bPre.length) return 1;
    const ai = aPre[i];
    const bi = bPre[i];
    if (ai === bi) continue;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const na = Number(ai);
      const nb = Number(bi);
      if (na !== nb) return na > nb ? 1 : -1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else {
      return ai > bi ? 1 : -1;
    }
  }
  return 0;
}

export function isAllowedRemoteUrl(rawUrl, { allowCustomUrlForTest = false } = {}) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (allowCustomUrlForTest) {
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    }
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_REMOTE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function buildDeterministicZipUrl(version) {
  const clean = String(version || '').trim().replace(/^v/i, '');
  if (!clean) return `${REPO_URL}/archive/refs/heads/main.zip`;
  return `${REPO_URL}/releases/download/v${clean}/agy-claude-style-v${clean}.zip`;
}

function buildReleaseNotesPreview(body = '', maxLen = 1200) {
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen).trimEnd()}…` : text;
}

function hasEnvProxyConfigured(env = process.env) {
  return Boolean(
    env?.HTTPS_PROXY ||
      env?.https_proxy ||
      env?.HTTP_PROXY ||
      env?.http_proxy ||
      env?.ALL_PROXY ||
      env?.all_proxy
  );
}

function fetchViaHttpConnectTunnel(targetUrl, { proxyUrl, headers = {}, redirect = 'follow', timeoutMs = 10000, maxRedirects = 5 } = {}) {
  const visit = (curUrl, hopsLeft) =>
    new Promise((resolvePromise, rejectPromise) => {
      let target;
      let proxy;
      try {
        target = new URL(curUrl);
        proxy = new URL(proxyUrl);
      } catch (err) {
        rejectPromise(err);
        return;
      }
      if (target.protocol !== 'https:') {
        rejectPromise(new Error('CONNECT tunnel supports HTTPS target URLs only'));
        return;
      }
      const targetPort = Number(target.port) || 443;
      const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
      const proxyHost = proxy.hostname.replace(/^\[|\]$/g, '');
      const connectHeaders = {
        Host: `${target.hostname}:${targetPort}`,
      };
      if (proxy.username || proxy.password) {
        const creds = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
        connectHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
      }

      let settled = false;
      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(val);
      };
      const timer = setTimeout(() => {
        try { connectReq.destroy(); } catch {}
        done(rejectPromise, new Error('Proxy request timeout'));
      }, Math.max(1000, timeoutMs));

      const connectReq = http.request({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${target.hostname}:${targetPort}`,
        headers: connectHeaders,
      });

      connectReq.on('connect', (connectRes, socket) => {
        if (connectRes.statusCode !== 200) {
          socket.destroy();
          done(rejectPromise, new Error(`Proxy CONNECT HTTP ${connectRes.statusCode}`));
          return;
        }
        const tlsSocket = tls.connect({
          socket,
          servername: target.hostname,
        });
        const req = https.request(
          {
            hostname: target.hostname,
            port: targetPort,
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            createConnection: () => tlsSocket,
            headers: {
              'User-Agent': 'agy-claude-style-updater/4.0.0',
              ...headers,
            },
          },
          (res) => {
            const status = Number(res.statusCode || 0);
            const loc = res.headers?.location ? String(res.headers.location) : '';
            if (status >= 300 && status < 400 && loc && redirect === 'follow') {
              res.resume();
              if (hopsLeft <= 0) {
                done(rejectPromise, new Error('Too many redirects'));
                return;
              }
              let nextUrl;
              try {
                nextUrl = new URL(loc, curUrl).toString();
              } catch (err) {
                done(rejectPromise, err);
                return;
              }
              if (!isAllowedRemoteUrl(nextUrl)) {
                done(rejectPromise, new Error(`Blocked redirect host: ${nextUrl}`));
                return;
              }
              clearTimeout(timer);
              settled = true;
              visit(nextUrl, hopsLeft - 1).then(resolvePromise, rejectPromise);
              return;
            }

            const chunks = [];
            let total = 0;
            res.on('data', (c) => {
              total += c.length;
              if (total > MAX_ZIP_BYTES) {
                req.destroy(new Error('Response exceeds max allowed size'));
                return;
              }
              chunks.push(c);
            });
            res.on('end', () => {
              const buf = Buffer.concat(chunks);
              const lowerHeaders = new Map(
                Object.entries(res.headers || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v ?? '')])
              );
              done(resolvePromise, {
                ok: status >= 200 && status < 300,
                status,
                url: curUrl,
                headers: {
                  get(name) {
                    return lowerHeaders.get(String(name || '').toLowerCase()) ?? null;
                  },
                },
                async text() {
                  return buf.toString('utf8');
                },
                async json() {
                  return JSON.parse(buf.toString('utf8'));
                },
                async arrayBuffer() {
                  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                },
              });
            });
            res.on('error', (err) => done(rejectPromise, err));
          }
        );
        req.on('error', (err) => done(rejectPromise, err));
        req.end();
      });

      connectReq.on('error', (err) => done(rejectPromise, err));
      connectReq.end();
    });

  return visit(targetUrl, maxRedirects);
}

function fetchDirectHttpsIpv4(targetUrl, { headers = {}, redirect = 'follow', timeoutMs = 3500, maxRedirects = 4 } = {}) {
  const visit = (curUrl, hopsLeft) =>
    new Promise((resolvePromise, rejectPromise) => {
      let target;
      try {
        target = new URL(curUrl);
      } catch (err) {
        rejectPromise(err);
        return;
      }
      if (target.protocol !== 'https:' || !isAllowedRemoteUrl(curUrl)) {
        rejectPromise(new Error(`Disallowed direct URL: ${curUrl}`));
        return;
      }
      let settled = false;
      const done = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(val);
      };
      const timer = setTimeout(() => {
        try { req.destroy(); } catch {}
        done(rejectPromise, new Error('Direct IPv4 HTTPS timeout'));
      }, Math.max(800, timeoutMs));

      const req = https.request(
        {
          hostname: target.hostname,
          port: Number(target.port) || 443,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          agent: false,
          family: 4,
          headers: {
            'User-Agent': 'agy-claude-style-updater/4.0.0',
            ...headers,
          },
        },
        (res) => {
          const status = Number(res.statusCode || 0);
          const loc = res.headers?.location ? String(res.headers.location) : '';
          if (status >= 300 && status < 400 && loc && redirect === 'follow') {
            res.resume();
            if (hopsLeft <= 0) {
              done(rejectPromise, new Error('Too many redirects'));
              return;
            }
            let nextUrl;
            try {
              nextUrl = new URL(loc, curUrl).toString();
            } catch (err) {
              done(rejectPromise, err);
              return;
            }
            if (!isAllowedRemoteUrl(nextUrl)) {
              done(rejectPromise, new Error(`Blocked redirect host: ${nextUrl}`));
              return;
            }
            clearTimeout(timer);
            settled = true;
            visit(nextUrl, hopsLeft - 1).then(resolvePromise, rejectPromise);
            return;
          }
          const chunks = [];
          let total = 0;
          res.on('data', (c) => {
            total += c.length;
            if (total > MAX_ZIP_BYTES) {
              req.destroy(new Error('Response exceeds max allowed size'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const lowerHeaders = new Map(
              Object.entries(res.headers || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v ?? '')])
            );
            done(resolvePromise, {
              ok: status >= 200 && status < 300,
              status,
              url: curUrl,
              headers: {
                get(name) {
                  return lowerHeaders.get(String(name || '').toLowerCase()) ?? null;
                },
              },
              async text() {
                return buf.toString('utf8');
              },
              async json() {
                return JSON.parse(buf.toString('utf8'));
              },
              async arrayBuffer() {
                return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
              },
            });
          });
          res.on('error', (err) => done(rejectPromise, err));
        }
      );
      req.on('error', (err) => done(rejectPromise, err));
      req.end();
    });

  return visit(targetUrl, maxRedirects);
}

async function fetchRemote(url, opts = {}, { fetchFn = globalThis.fetch, proxyConfig = null, allowCustomUrlForTest = false, timeoutMs = 4200 } = {}) {
  if (!isAllowedRemoteUrl(url, { allowCustomUrlForTest })) {
    throw new Error(`Disallowed remote URL: ${url}`);
  }
  const hasExplicitFetch = typeof fetchFn === 'function' && fetchFn !== globalThis.fetch;
  const rawProxyUrl = proxyConfig?.proxyEnabled ? String(proxyConfig?.proxyUrl || '').trim() : '';
  let parsedProxy = null;
  if (rawProxyUrl) {
    try {
      parsedProxy = new URL(rawProxyUrl);
    } catch {}
  }

  // If standalone HTTP proxy is configured in config.json and process env does not already carry proxy env,
  // tunnel HTTPS requests through the configured HTTP proxy so updates work even before an IDE restart.
  if (
    !hasExplicitFetch &&
    !hasEnvProxyConfigured() &&
    parsedProxy &&
    (parsedProxy.protocol === 'http:' || parsedProxy.protocol === 'https:') &&
    String(url).startsWith('https://')
  ) {
    try {
      return await fetchViaHttpConnectTunnel(url, {
        proxyUrl: rawProxyUrl,
        headers: opts.headers || {},
        redirect: opts.redirect || 'follow',
        timeoutMs,
      });
    } catch {
      // Fall through to direct IPv4 / fetch if configured standalone proxy is temporarily down
    }
  }

  try {
    const res = await fetchFn(url, {
      method: opts.method || 'GET',
      redirect: opts.redirect || 'follow',
      headers: {
        'User-Agent': 'agy-claude-style-updater/4.0.0',
        ...(opts.headers || {}),
      },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (res?.url && !isAllowedRemoteUrl(res.url, { allowCustomUrlForTest })) {
      throw new Error(`Disallowed redirect target: ${res.url}`);
    }
    return res;
  } catch (err) {
    if (!hasExplicitFetch && hasEnvProxyConfigured() && String(url).startsWith('https://') && isAllowedRemoteUrl(url)) {
      try {
        return await fetchDirectHttpsIpv4(url, {
          headers: opts.headers || {},
          redirect: opts.redirect || 'follow',
          timeoutMs: Math.min(3500, timeoutMs),
        });
      } catch {}
    }
    throw err;
  }
}

function readUpdateCache(cachePath) {
  if (!cachePath || !existsSync(cachePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return null;
}

export function isGitCheckoutDir(installDir) {
  if (!installDir) return false;
  return existsSync(join(installDir, '.git'));
}

export function resolveInstalledVersion(installDir, fallback = '4.0.0') {
  if (installDir) {
    const pj = join(installDir, 'plugin.json');
    if (existsSync(pj)) {
      try {
        const ver = String(JSON.parse(readFileSync(pj, 'utf8'))?.version || '').trim();
        if (ver) return ver;
      } catch {}
    }
  }
  return String(fallback || '4.0.0').trim();
}

function parseTagFromUrl(rawUrl = '') {
  const m = String(rawUrl || '').match(/\/releases\/tag\/(v?[0-9]+\.[0-9]+\.[0-9]+[^\s/?#]*)/i);
  return m ? m[1] : '';
}

export async function checkForUpdates({
  currentVersion = '4.0.0',
  installDir = '',
  stateDir = '',
  cachePath = '',
  force = false,
  ttlMs = DEFAULT_UPDATE_TTL_MS,
  fetchFn = globalThis.fetch,
  proxyConfig = null,
  platform = process.platform,
  timeoutMs = 10000,
  apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
  webLatestUrl = `${REPO_URL}/releases/latest`,
  mirrorPluginUrl = `https://cdn.jsdelivr.net/gh/${REPO_OWNER}/${REPO_NAME}@main/plugin.json`,
  allowCustomUrlForTest = false,
} = {}) {
  const effectiveCachePath = cachePath || (stateDir ? join(stateDir, 'update-cache.json') : '');
  const curVer = String(currentVersion || resolveInstalledVersion(installDir)).trim() || '4.0.0';
  const isGitRepo = isGitCheckoutDir(installDir);
  const installCommand = getPlatformInstallCommand(platform);
  const cached = readUpdateCache(effectiveCachePath);
  const now = Date.now();

  if (!force && cached && Number(cached.checkedAtMs) > 0 && now - Number(cached.checkedAtMs) < ttlMs && cached.latestVersion) {
    const hasUpdate = compareSemver(cached.latestVersion, curVer) > 0;
    return {
      ok: true,
      cached: true,
      currentVersion: curVer,
      latestVersion: String(cached.latestVersion),
      hasUpdate,
      isGitRepo,
      checkedAtMs: Number(cached.checkedAtMs),
      releaseUrl: String(cached.releaseUrl || `${REPO_URL}/releases/tag/v${cached.latestVersion}`),
      downloadUrl: String(cached.downloadUrl || buildDeterministicZipUrl(cached.latestVersion)),
      releaseNotes: String(cached.releaseNotes || ''),
      publishedAt: String(cached.publishedAt || ''),
      source: String(cached.source || 'cache'),
      installCommand,
      lastError: '',
    };
  }

  const apiTimeoutMs = Math.max(1200, Math.min(3800, Number(timeoutMs) || 3800));
  const fallbackTimeoutMs = Math.max(1000, Math.min(3200, Number(timeoutMs) || 3200));

  const probeApi = async () => {
    try {
      const res = await fetchRemote(
        apiUrl,
        { headers: { Accept: 'application/vnd.github+json' } },
        { fetchFn, proxyConfig, allowCustomUrlForTest, timeoutMs: apiTimeoutMs }
      );
      if (res && res.ok) {
        const rel = await res.json();
        const rawTag = String(rel?.tag_name || '').trim();
        const latestVersion = rawTag.replace(/^v/i, '');
        if (normalizeSemver(latestVersion)) {
          const assets = Array.isArray(rel?.assets) ? rel.assets : [];
          const zipAsset = assets.find((a) => /^agy-claude-style-v.*\.zip$/i.test(String(a?.name || '')));
          return {
            ok: true,
            resolved: {
              latestVersion,
              releaseUrl: String(rel?.html_url || `${REPO_URL}/releases/tag/v${latestVersion}`),
              downloadUrl: String(zipAsset?.browser_download_url || buildDeterministicZipUrl(latestVersion)),
              releaseNotes: buildReleaseNotesPreview(rel?.body || ''),
              publishedAt: String(rel?.published_at || ''),
              source: 'github-api',
            },
          };
        }
        return { ok: false, error: 'GitHub API 返回了无效版本号' };
      }
      return { ok: false, error: `GitHub API HTTP ${res?.status || 'ERR'}` };
    } catch (err) {
      return { ok: false, error: `GitHub API: ${err?.message || String(err)}` };
    }
  };

  const probeRedirect = async () => {
    try {
      const res = await fetchRemote(
        webLatestUrl,
        { redirect: 'manual', headers: { Accept: 'text/html' } },
        { fetchFn, proxyConfig, allowCustomUrlForTest, timeoutMs: fallbackTimeoutMs }
      );
      const loc = res?.headers?.get?.('location') || res?.url || '';
      const rawTag = parseTagFromUrl(loc);
      const latestVersion = rawTag.replace(/^v/i, '');
      if (normalizeSemver(latestVersion)) {
        return {
          ok: true,
          resolved: {
            latestVersion,
            releaseUrl: `${REPO_URL}/releases/tag/v${latestVersion}`,
            downloadUrl: buildDeterministicZipUrl(latestVersion),
            releaseNotes: '',
            publishedAt: '',
            source: 'github-redirect',
          },
        };
      }
      return { ok: false, error: `GitHub Release Redirect HTTP ${res?.status || 'ERR'}` };
    } catch (err) {
      return { ok: false, error: `GitHub Redirect: ${err?.message || String(err)}` };
    }
  };

  const probeMirror = async () => {
    try {
      const res = await fetchRemote(
        mirrorPluginUrl,
        { headers: { Accept: 'application/json' } },
        { fetchFn, proxyConfig, allowCustomUrlForTest, timeoutMs: fallbackTimeoutMs }
      );
      if (res && res.ok) {
        const doc = await res.json();
        const latestVersion = String(doc?.version || '').trim().replace(/^v/i, '');
        if (normalizeSemver(latestVersion)) {
          return {
            ok: true,
            resolved: {
              latestVersion,
              releaseUrl: `${REPO_URL}/releases/tag/v${latestVersion}`,
              downloadUrl: buildDeterministicZipUrl(latestVersion),
              releaseNotes: '',
              publishedAt: '',
              source: 'jsdelivr-mirror',
            },
          };
        }
      }
      return { ok: false, error: `Mirror HTTP ${res?.status || 'ERR'}` };
    } catch (err) {
      return { ok: false, error: `Mirror: ${err?.message || String(err)}` };
    }
  };

  let lastError = '';
  let resolved = null;

  // Hedged check: give primary GitHub API a 1500ms head start (rich release notes),
  // then race quota-free redirect & jsDelivr mirror in parallel so worst-case stays <= 4.5s.
  const apiPromise = probeApi();
  let hedgeTimer = null;
  const headStart = await Promise.race([
    apiPromise.then((r) => ({ kind: 'api', result: r })),
    new Promise((resolveTimer) => {
      hedgeTimer = setTimeout(() => resolveTimer({ kind: 'hedge' }), 1400);
      if (typeof hedgeTimer.unref === 'function') hedgeTimer.unref();
    }),
  ]);
  if (hedgeTimer) clearTimeout(hedgeTimer);

  if (headStart.kind === 'api' && headStart.result.ok) {
    resolved = headStart.result.resolved;
  } else {
    if (headStart.kind === 'api' && headStart.result.error) {
      lastError = headStart.result.error;
    }
    const candidates = [
      ...(headStart.kind === 'hedge' ? [apiPromise] : []),
      probeRedirect(),
      probeMirror(),
    ];
    const winner = await new Promise((resolveWinner) => {
      let pending = candidates.length;
      let settled = false;
      for (const p of candidates) {
        p.then((r) => {
          if (settled) return;
          if (r && r.ok) {
            settled = true;
            resolveWinner(r);
            return;
          }
          if (r?.error && !lastError) lastError = r.error;
          pending -= 1;
          if (pending <= 0) {
            settled = true;
            resolveWinner(null);
          }
        }).catch((err) => {
          if (settled) return;
          if (!lastError) lastError = err?.message || String(err);
          pending -= 1;
          if (pending <= 0) {
            settled = true;
            resolveWinner(null);
          }
        });
      }
    });
    if (winner?.ok) resolved = winner.resolved;
  }

  if (resolved) {
    const hasUpdate = compareSemver(resolved.latestVersion, curVer) > 0;
    const result = {
      ok: true,
      cached: false,
      currentVersion: curVer,
      latestVersion: resolved.latestVersion,
      hasUpdate,
      isGitRepo,
      checkedAtMs: Date.now(),
      releaseUrl: resolved.releaseUrl,
      downloadUrl: resolved.downloadUrl,
      releaseNotes: resolved.releaseNotes,
      publishedAt: resolved.publishedAt,
      source: resolved.source,
      installCommand,
      lastError: '',
    };
    if (effectiveCachePath) {
      try {
        writeAtomicJson(effectiveCachePath, {
          checkedAtMs: result.checkedAtMs,
          latestVersion: result.latestVersion,
          releaseUrl: result.releaseUrl,
          downloadUrl: result.downloadUrl,
          releaseNotes: result.releaseNotes,
          publishedAt: result.publishedAt,
          source: result.source,
        });
      } catch {}
    }
    return result;
  }

  const fallbackLatest = cached?.latestVersion ? String(cached.latestVersion) : '';
  return {
    ok: false,
    cached: false,
    error: lastError || '检查更新失败，请检查网络或代理设置',
    lastError: lastError || '检查更新失败，请检查网络或代理设置',
    currentVersion: curVer,
    latestVersion: fallbackLatest,
    hasUpdate: fallbackLatest ? compareSemver(fallbackLatest, curVer) > 0 : false,
    isGitRepo,
    checkedAtMs: Number(cached?.checkedAtMs || 0),
    releaseUrl: String(cached?.releaseUrl || RELEASES_PAGE_URL),
    downloadUrl: String(cached?.downloadUrl || ''),
    releaseNotes: String(cached?.releaseNotes || ''),
    publishedAt: String(cached?.publishedAt || ''),
    source: 'error',
    installCommand,
  };
}

function sanitizeZipEntryPath(rawName) {
  const norm = String(rawName || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.endsWith('/')) return null;
  if (/[\x00-\x1f\x7f]/.test(norm)) {
    throw new Error(`Unsafe control character in zip entry: ${rawName}`);
  }
  if (/^[A-Za-z]:/.test(norm)) {
    throw new Error(`Unsafe drive path in zip entry: ${rawName}`);
  }
  const parts = norm.split('/');
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..') {
      throw new Error(`Unsafe zip entry path: ${rawName}`);
    }
  }
  return norm;
}

/**
 * Pure-Node PKZIP extractor with CRC32 validation, Zip-Slip rejection, and Zip-Bomb limits.
 */
export function extractZipBufferSafe(
  inputBuf,
  { maxZipBytes = MAX_ZIP_BYTES, maxTotalUncompressedBytes = MAX_UNCOMPRESSED_BYTES } = {}
) {
  const buf = Buffer.isBuffer(inputBuf) ? inputBuf : Buffer.from(inputBuf);
  if (buf.length < 22) throw new Error('Invalid ZIP archive: too small');
  if (buf.length > maxZipBytes) throw new Error(`ZIP archive exceeds max limit (${maxZipBytes} bytes)`);

  let eocdOffset = -1;
  const minEocdOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minEocdOffset; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) {
        eocdOffset = i;
        break;
      }
    }
  }
  if (eocdOffset < 0) throw new Error('Invalid ZIP archive: EOCD header not found');

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset + cdSize > eocdOffset) {
    throw new Error('Invalid ZIP archive: central directory out of bounds');
  }

  const rawEntries = [];
  let cursor = cdOffset;
  let totalUncompressed = 0;

  for (let idx = 0; idx < totalEntries; idx += 1) {
    if (cursor + 46 > cdOffset + cdSize || buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Invalid ZIP archive: corrupt central directory entry');
    }
    const method = buf.readUInt16LE(cursor + 10);
    const expectedCrc = buf.readUInt32LE(cursor + 16);
    const compSize = buf.readUInt32LE(cursor + 20);
    const uncompSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);

    const nameEnd = cursor + 46 + nameLen;
    if (nameEnd > cdOffset + cdSize) throw new Error('Invalid ZIP entry name bounds');
    const rawName = buf.subarray(cursor + 46, nameEnd).toString('utf8');
    cursor = nameEnd + extraLen + commentLen;

    const cleanName = sanitizeZipEntryPath(rawName);
    if (!cleanName) continue;

    if (localHeaderOffset + 30 > cdOffset || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid local file header for ${cleanName}`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > cdOffset) {
      throw new Error(`Compressed entry out of bounds: ${cleanName}`);
    }

    totalUncompressed += uncompSize;
    if (totalUncompressed > maxTotalUncompressedBytes) {
      throw new Error('Extracted payload exceeds maximum uncompressed size limit');
    }

    const compSlice = buf.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      data = Buffer.from(compSlice);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compSlice, { maxOutputLength: maxTotalUncompressedBytes });
    } else {
      throw new Error(`Unsupported ZIP compression method (${method}) for ${cleanName}`);
    }

    if (data.length !== uncompSize) {
      throw new Error(`Uncompressed size mismatch for ${cleanName}`);
    }
    if (crc32(data) !== expectedCrc) {
      throw new Error(`CRC32 checksum mismatch for ${cleanName}`);
    }
    rawEntries.push({ name: cleanName, data });
  }

  let hasRootManifest = false;
  const topSegments = new Set();
  for (const e of rawEntries) {
    if (e.name === 'plugin.json') hasRootManifest = true;
    const slash = e.name.indexOf('/');
    if (slash > 0) topSegments.add(e.name.slice(0, slash));
  }
  const stripPrefix = !hasRootManifest && topSegments.size === 1 ? `${[...topSegments][0]}/` : '';

  const files = [];
  let manifest = null;
  for (const e of rawEntries) {
    const rel = stripPrefix && e.name.startsWith(stripPrefix) ? e.name.slice(stripPrefix.length) : e.name;
    if (!rel) continue;
    const parts = rel.split('/');
    const top = parts[0];
    const base = parts[parts.length - 1];
    if (SKIP_TOP_DIRS.has(top) || SKIP_BASE_NAMES.has(base)) continue;
    if (rel === 'plugin.json') {
      try {
        manifest = JSON.parse(e.data.toString('utf8'));
      } catch {
        throw new Error('Invalid plugin.json inside update archive');
      }
    }
    files.push({ name: rel, data: e.data });
  }

  if (!manifest || manifest.name !== REPO_NAME || !String(manifest.version || '').trim()) {
    throw new Error('Update archive missing valid agy-claude-style plugin.json manifest');
  }
  return { manifest, files };
}

function writeBinaryAtomic(destPath, data) {
  const dir = dirname(destPath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${destPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, destPath);
  } catch (err) {
    try {
      writeFileSync(destPath, data);
    } catch {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
      throw err;
    }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
  }
}

function getLegacyInstallDirForCleanup(env = process.env, platform = process.platform) {
  const testRoot = String(env?.AGY_CS_TEST_SYSTEM_ROOT || '').trim();
  if (testRoot) {
    return join(resolve(testRoot), platform === 'win32' ? 'LegacyLocalAppData' : 'LegacyAppSupport', REPO_NAME);
  }
  if (platform === 'win32') {
    const local = env?.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
    return join(local, REPO_NAME);
  }
  if (platform === 'darwin') {
    return join(os.homedir(), 'Library', 'Application Support', REPO_NAME);
  }
  return join(env?.XDG_CONFIG_HOME || join(os.homedir(), '.config'), REPO_NAME);
}

export function cleanupLegacyExternalArtifacts({
  installDir = '',
  stateDir = '',
  env = process.env,
  platform = process.platform,
} = {}) {
  const isSandbox = Boolean(String(env?.AGY_CS_TEST_SYSTEM_ROOT || '').trim());
  const testRoot = isSandbox ? resolve(String(env.AGY_CS_TEST_SYSTEM_ROOT).trim()) : '';
  const removed = [];

  if (!isSandbox && platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/IM', 'agy-claude-style-watcher.exe'], { stdio: 'ignore', windowsHide: true });
      removed.push('process:agy-claude-style-watcher.exe');
    } catch {}
    try {
      execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AgyClaudeStyle', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      removed.push('reg:Uninstall/AgyClaudeStyle');
    } catch {}
    for (const runVal of ['AGY-Claude-Style', 'AgyClaudeStyle']) {
      try {
        execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', runVal, '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        removed.push(`reg:Run/${runVal}`);
      } catch {}
    }
  }

  if (platform === 'win32') {
    const shortcuts = isSandbox
      ? [
          join(testRoot, 'Startup', 'AGY-Claude-Style.lnk'),
          join(testRoot, 'StartMenu', 'Antigravity (AGY Claude Style).lnk'),
          join(testRoot, 'Desktop', 'Antigravity (AGY Claude Style).lnk'),
        ]
      : [
          env.APPDATA ? join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'AGY-Claude-Style.lnk') : '',
          env.APPDATA ? join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Antigravity', 'Antigravity (AGY Claude Style).lnk') : '',
          env.APPDATA ? join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Antigravity (AGY Claude Style).lnk') : '',
          env.USERPROFILE ? join(env.USERPROFILE, 'Desktop', 'Antigravity (AGY Claude Style).lnk') : '',
        ].filter(Boolean);
    for (const lnk of shortcuts) {
      if (lnk && existsSync(lnk)) {
        try { unlinkSync(lnk); removed.push(lnk); } catch {}
      }
    }
  } else if (platform === 'darwin') {
    const plist = isSandbox
      ? join(testRoot, 'LaunchAgents', 'io.github.0dnancy.agy-claude-style.plist')
      : join(os.homedir(), 'Library', 'LaunchAgents', 'io.github.0dnancy.agy-claude-style.plist');
    if (existsSync(plist)) {
      if (!isSandbox) {
        try { execFileSync('launchctl', ['unload', '-w', plist], { stdio: 'ignore' }); } catch {}
      }
      try { unlinkSync(plist); removed.push(plist); } catch {}
    }
    const launcherApp = isSandbox
      ? join(testRoot, 'Applications', 'Antigravity (AGY Claude Style).app')
      : join(os.homedir(), 'Applications', 'Antigravity (AGY Claude Style).app');
    if (existsSync(launcherApp)) {
      try { rmSync(launcherApp, { recursive: true, force: true }); removed.push(launcherApp); } catch {}
    }
  }

  const legacyDir = getLegacyInstallDirForCleanup(env, platform);
  if (legacyDir && existsSync(legacyDir) && (!installDir || resolve(legacyDir) !== resolve(installDir))) {
    if (stateDir) {
      const legacyCfg = join(legacyDir, 'config.json');
      const activeCfg = join(stateDir, 'config.json');
      if (existsSync(legacyCfg) && !existsSync(activeCfg)) {
        try {
          const parsed = JSON.parse(readFileSync(legacyCfg, 'utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            delete parsed.exitOnHostClose;
            writeAtomicJson(activeCfg, parsed);
          }
        } catch {}
      }
    }
    try { rmSync(legacyDir, { recursive: true, force: true }); removed.push(legacyDir); } catch {}
  }

  if (stateDir && existsSync(stateDir)) {
    for (const oldBin of [
      'agy-claude-style-uninstaller.exe',
      'agy-claude-style-watcher.exe',
      'agy-claude-style-installer.exe',
    ]) {
      const p = join(stateDir, oldBin);
      if (existsSync(p)) {
        try { unlinkSync(p); removed.push(p); } catch {}
      }
    }
  }

  if (installDir && existsSync(installDir)) {
    for (const legacyFile of [
      'agy-claude-style-watcher.exe',
      'agy-claude-style-watcher',
      'agy-claude-style-installer.exe',
      'manifest.json',
      '.install-mode',
      '.watch.pid',
      'Antigravity (AGY Claude Style).lnk',
      'launch-antigravity.command',
      'launch.bat',
      'launch.sh',
      'watch.bat',
      'watch.sh',
      'watch-hidden.vbs',
      'remove.js',
      'remove.bat',
      'remove.sh',
      'inject.bat',
      'inject.sh',
      'autostart-on.bat',
      'autostart-off.bat',
    ]) {
      const p = join(installDir, legacyFile);
      if (existsSync(p)) {
        try { unlinkSync(p); removed.push(p); } catch {}
      }
    }
    const legacyInstallerSubdir = join(installDir, 'installer');
    if (existsSync(legacyInstallerSubdir)) {
      try { rmSync(legacyInstallerSubdir, { recursive: true, force: true }); removed.push(legacyInstallerSubdir); } catch {}
    }
  }

  return { cleaned: removed.length > 0, count: removed.length, removed };
}

export function pruneStalePluginFiles(installDir, validRelativePaths) {
  const resolvedRoot = resolve(installDir || '');
  if (!resolvedRoot || !existsSync(resolvedRoot) || isGitCheckoutDir(resolvedRoot)) {
    return { prunedCount: 0, prunedFiles: [] };
  }
  const validSet = validRelativePaths instanceof Set ? validRelativePaths : new Set(validRelativePaths || []);
  if (validSet.size === 0) return { prunedCount: 0, prunedFiles: [] };

  const prunedFiles = [];
  const walk = (absDir, relPrefix) => {
    const entries = readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'wallpapers' || entry.name === '.git') continue;
        walk(abs, rel);
        try {
          if (readdirSync(abs).length === 0) {
            rmSync(abs, { recursive: true, force: true });
          }
        } catch {}
      } else if (entry.isFile()) {
        if (entry.name === 'config.json') continue;
        if (!validSet.has(rel)) {
          try {
            unlinkSync(abs);
            prunedFiles.push(rel);
          } catch {}
        }
      }
    }
  };
  walk(resolvedRoot, '');
  return { prunedCount: prunedFiles.length, prunedFiles };
}

export function terminateStaleOwnedMcpHosts({
  installDir = '',
  stateDir = '',
  excludePid = process.pid,
  cdpModule = null,
} = {}) {
  const killedPids = [];
  if (!stateDir || !existsSync(stateDir)) return { killedCount: 0, killedPids };
  const resolvedInstall = installDir ? resolve(installDir) : '';
  const candidatePids = new Set();

  const hostsDir = join(stateDir, '.mcp-hosts');
  if (existsSync(hostsDir)) {
    try {
      for (const name of readdirSync(hostsDir)) {
        if (!name.endsWith('.json')) continue;
        const pid = parseInt(name.slice(0, -5), 10);
        if (Number.isInteger(pid) && pid > 0 && pid !== excludePid) {
          candidatePids.add(pid);
        }
      }
    } catch {}
  }

  const pidFile = join(stateDir, '.watch.pid');
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isInteger(pid) && pid > 0 && pid !== excludePid) {
        candidatePids.add(pid);
      }
    } catch {}
  }

  for (const pid of candidatePids) {
    if (!isPidAlive(pid)) continue;
    let isOwnedMcpHost = false;
    try {
      if (cdpModule && typeof cdpModule.inspectProcessCommand === 'function' && typeof cdpModule.evaluateWatcherOwnership === 'function') {
        const info = cdpModule.inspectProcessCommand(pid);
        const status = resolvedInstall ? cdpModule.evaluateWatcherOwnership(info, resolvedInstall) : 'unknown';
        const cmd = String(typeof info === 'string' ? info : info?.cmd || '').toLowerCase();
        if (status === 'owned' && cmd.includes('mcp-host.js')) {
          isOwnedMcpHost = true;
        }
      }
    } catch {}
    if (!isOwnedMcpHost) continue;
    try {
      process.kill(pid, 'SIGTERM');
      killedPids.push(pid);
    } catch {}
  }

  if (killedPids.length > 0 && existsSync(pidFile)) {
    try {
      const lockPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (killedPids.includes(lockPid)) {
        unlinkSync(pidFile);
      }
    } catch {}
  }

  return { killedCount: killedPids.length, killedPids };
}

export async function applyPluginUpdate({
  installDir,
  stateDir = '',
  downloadUrl = '',
  targetVersion = '',
  allowGitOverwrite = false,
  fetchFn = globalThis.fetch,
  proxyConfig = null,
  allowCustomUrlForTest = false,
  timeoutMs = 45000,
  env = process.env,
} = {}) {
  const resolvedInstallDir = resolve(installDir || '');
  if (!resolvedInstallDir) throw new Error('Missing plugin install directory');

  if (isGitCheckoutDir(resolvedInstallDir) && !allowGitOverwrite) {
    return {
      ok: false,
      isGitRepo: true,
      error: '当前插件目录为 Git 开发仓库，为保护本地源码修改，请使用 git pull && npm run setup 更新。',
    };
  }

  const previousVersion = resolveInstalledVersion(resolvedInstallDir);
  let resolvedUrl = String(downloadUrl || '').trim();
  let checkInfo = null;

  if (!resolvedUrl) {
    checkInfo = await checkForUpdates({
      currentVersion: previousVersion,
      installDir: resolvedInstallDir,
      stateDir,
      force: true,
      fetchFn,
      proxyConfig,
      allowCustomUrlForTest,
    });
    if (!checkInfo.ok) {
      return { ok: false, error: checkInfo.error || '无法获取最新版本下载地址' };
    }
    if (!checkInfo.hasUpdate && !targetVersion) {
      return {
        ok: true,
        alreadyLatest: true,
        previousVersion,
        updatedVersion: checkInfo.currentVersion,
        fileCount: 0,
        prunedCount: 0,
        legacyCleaned: 0,
      };
    }
    resolvedUrl = targetVersion ? buildDeterministicZipUrl(targetVersion) : checkInfo.downloadUrl;
  }

  const res = await fetchRemote(
    resolvedUrl,
    { headers: { Accept: 'application/octet-stream, application/zip, */*' } },
    { fetchFn, proxyConfig, allowCustomUrlForTest, timeoutMs }
  );
  if (!res || !res.ok) {
    throw new Error(`下载更新包失败: HTTP ${res?.status || 'ERR'}`);
  }
  const arrBuf = await res.arrayBuffer();
  const zipBuf = Buffer.from(arrBuf);
  const { manifest, files } = extractZipBufferSafe(zipBuf);

  mkdirSync(resolvedInstallDir, { recursive: true });
  const installRootPrefix = resolvedInstallDir.endsWith(sep) ? resolvedInstallDir : `${resolvedInstallDir}${sep}`;
  const validRelPaths = new Set();
  for (const entry of files) {
    const destPath = resolve(resolvedInstallDir, entry.name);
    if (!destPath.startsWith(installRootPrefix)) {
      throw new Error(`Unsafe target path rejected: ${entry.name}`);
    }
    writeBinaryAtomic(destPath, entry.data);
    validRelPaths.add(entry.name);
  }

  const legacyRes = cleanupLegacyExternalArtifacts({
    installDir: resolvedInstallDir,
    stateDir,
    env,
  });
  const pruneRes = pruneStalePluginFiles(resolvedInstallDir, validRelPaths);

  if (stateDir) {
    mkdirSync(stateDir, { recursive: true });
    const activeCfgPath = join(stateDir, 'config.json');
    const exampleCfgPath = join(resolvedInstallDir, 'config.example.json');
    if (!existsSync(activeCfgPath) && existsSync(exampleCfgPath)) {
      try { copyFileSync(exampleCfgPath, activeCfgPath); } catch {}
    }
    try {
      writeAtomicJson(join(stateDir, 'update-cache.json'), {
        checkedAtMs: Date.now(),
        latestVersion: String(manifest.version),
        releaseUrl: `${REPO_URL}/releases/tag/v${String(manifest.version).replace(/^v/i, '')}`,
        downloadUrl: resolvedUrl,
        releaseNotes: checkInfo?.releaseNotes || '',
        publishedAt: checkInfo?.publishedAt || '',
        source: 'applied',
        updatedAtMs: Date.now(),
      });
    } catch {}
  }

  return {
    ok: true,
    alreadyLatest: false,
    previousVersion,
    updatedVersion: String(manifest.version),
    fileCount: files.length,
    prunedCount: pruneRes.prunedCount,
    legacyCleanedCount: legacyRes.count,
    installDir: resolvedInstallDir,
  };
}

function callDaemonRpcLoopback(daemon, method, body, timeoutMs = 2500) {
  return new Promise((resolvePromise) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(daemon.httpPort),
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        agent: false,
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': daemon.csrfToken,
          'x-antigravity-csrf-token': daemon.csrfToken,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        try { res.resume(); } catch {}
        resolvePromise(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on('timeout', () => {
      try { req.destroy(); } catch {}
      resolvePromise(false);
    });
    req.on('error', () => resolvePromise(false));
    req.end(payload);
  });
}

function discoverDaemonRecords(env = process.env) {
  const testRoot = String(env.AGY_CS_TEST_SYSTEM_ROOT || '').trim();
  if (testRoot) return [];
  const geminiDir = String(env.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(os.homedir(), '.gemini');
  const daemonDir = join(geminiDir, 'antigravity', 'daemon');
  if (!existsSync(daemonDir)) return [];
  const out = [];
  for (const name of readdirSync(daemonDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const doc = JSON.parse(readFileSync(join(daemonDir, name), 'utf8'));
      const pid = Number(doc?.pid);
      const httpPort = Number(doc?.httpPort);
      const csrfToken = String(doc?.csrfToken || '').trim();
      if (Number.isInteger(pid) && pid > 0 && Number.isInteger(httpPort) && httpPort > 0 && csrfToken && isPidAlive(pid)) {
        out.push({ pid, httpPort, csrfToken });
      }
    } catch {}
  }
  return out;
}

export async function triggerHotReloadAfterUpdate({
  env = process.env,
  injectOnceFn = null,
  installDir = '',
  stateDir = '',
  cdpModule = null,
} = {}) {
  const staleRes = terminateStaleOwnedMcpHosts({
    installDir,
    stateDir,
    excludePid: process.pid,
    cdpModule,
  });

  let lsReloaded = false;
  const disableBody = {
    plugins: { [REPO_NAME]: { enabled: false } },
    sidecars: { [`${REPO_NAME}/panel`]: { enabled: false } },
  };
  const enableBody = {
    plugins: { [REPO_NAME]: { enabled: true } },
    sidecars: { [`${REPO_NAME}/panel`]: { enabled: true } },
  };

  const daemons = discoverDaemonRecords(env);
  if (daemons.length > 0) {
    let disabledAny = false;
    for (const d of daemons) {
      if (await callDaemonRpcLoopback(d, 'JetboxWriteState', disableBody)) disabledAny = true;
    }
    if (disabledAny) await new Promise((r) => setTimeout(r, 350));
    for (const d of daemons) {
      if (await callDaemonRpcLoopback(d, 'JetboxWriteState', enableBody)) lsReloaded = true;
    }
  }

  if (!lsReloaded && String(env.ANTIGRAVITY_LS_ADDRESS || '').trim() !== 'test.invalid') {
    try {
      const dis = await callLsRpcWithRecovery('exa.language_server_pb.LanguageServerService', 'JetboxWriteState', disableBody, {
        timeoutMs: 2000,
      });
      if (dis?.ok) await new Promise((r) => setTimeout(r, 350));
      const en = await callLsRpcWithRecovery('exa.language_server_pb.LanguageServerService', 'JetboxWriteState', enableBody, {
        timeoutMs: 2000,
      });
      if (en?.ok) lsReloaded = true;
    } catch {}
  }

  let reinjected = false;
  if (typeof injectOnceFn === 'function') {
    try {
      await injectOnceFn();
      reinjected = true;
    } catch {}
  }

  return {
    ok: lsReloaded || reinjected,
    lsReloaded,
    reinjected,
    killedStaleHosts: staleRes.killedCount,
  };
}

export async function openExternalReleaseUrl(
  rawUrl,
  { platform = process.platform, execFn = execFileAsync, spawnFn = spawn } = {}
) {
  const input = String(rawUrl || '').trim() || RELEASES_PAGE_URL;
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Invalid release URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== 'github.com' ||
    !parsed.pathname.startsWith(`/${REPO_OWNER}/${REPO_NAME}`)
  ) {
    throw new Error(`Disallowed release URL: ${input}`);
  }
  const safeUrl = parsed.toString();
  if (platform === 'darwin') {
    await execFn('/usr/bin/open', [safeUrl], { timeout: 5000 });
  } else if (platform === 'win32') {
    await execFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:AGY_OPEN_URL'],
      { timeout: 5000, windowsHide: true, env: { ...process.env, AGY_OPEN_URL: safeUrl } }
    );
  } else {
    const child = spawnFn('xdg-open', [safeUrl], { detached: true, stdio: 'ignore' });
    child?.on?.('error', () => {});
    child?.unref?.();
  }
  return { ok: true, url: safeUrl };
}

export function createUpdateManager({
  getCurrentVersion,
  installDir,
  stateDir,
  readConfigFn = null,
  fetchFn = globalThis.fetch,
  ttlMs = DEFAULT_UPDATE_TTL_MS,
  platform = process.platform,
} = {}) {
  const cachePath = stateDir ? join(stateDir, 'update-cache.json') : '';
  let inflightCheck = null;
  let inflightApply = null;
  let lastSnapshot = null;

  const readCurrentVer = () => {
    try {
      const v = typeof getCurrentVersion === 'function' ? getCurrentVersion() : '';
      if (v) return String(v);
    } catch {}
    return resolveInstalledVersion(installDir);
  };

  function getStatusSnapshot() {
    const curVer = readCurrentVer();
    const isGitRepo = isGitCheckoutDir(installDir);
    const installCommand = getPlatformInstallCommand(platform);
    const cached = readUpdateCache(cachePath);
    const base = lastSnapshot || cached;
    if (!base) {
      return {
        ok: true,
        checking: Boolean(inflightCheck),
        updating: Boolean(inflightApply),
        currentVersion: curVer,
        latestVersion: '',
        hasUpdate: false,
        isGitRepo,
        checkedAtMs: 0,
        releaseUrl: RELEASES_PAGE_URL,
        downloadUrl: '',
        releaseNotes: '',
        publishedAt: '',
        source: 'none',
        installCommand,
        lastError: '',
      };
    }
    const latestVersion = String(base.latestVersion || '');
    return {
      ok: base.ok !== false,
      checking: Boolean(inflightCheck),
      updating: Boolean(inflightApply),
      currentVersion: curVer,
      latestVersion,
      hasUpdate: latestVersion ? compareSemver(latestVersion, curVer) > 0 : false,
      isGitRepo,
      checkedAtMs: Number(base.checkedAtMs || 0),
      releaseUrl: String(base.releaseUrl || RELEASES_PAGE_URL),
      downloadUrl: String(base.downloadUrl || (latestVersion ? buildDeterministicZipUrl(latestVersion) : '')),
      releaseNotes: String(base.releaseNotes || ''),
      publishedAt: String(base.publishedAt || ''),
      source: String(base.source || 'cache'),
      installCommand,
      lastError: String(base.lastError || ''),
    };
  }

  async function check({ force = false } = {}) {
    if (inflightCheck) return inflightCheck;
    inflightCheck = (async () => {
      const cfg = typeof readConfigFn === 'function' ? readConfigFn() : null;
      const res = await checkForUpdates({
        currentVersion: readCurrentVer(),
        installDir,
        stateDir,
        cachePath,
        force,
        ttlMs,
        fetchFn,
        proxyConfig: cfg,
        platform,
      });
      lastSnapshot = res;
      return { ...res, checking: false, updating: Boolean(inflightApply) };
    })();
    try {
      return await inflightCheck;
    } finally {
      inflightCheck = null;
    }
  }

  async function apply({ targetVersion = '', downloadUrl = '' } = {}) {
    if (inflightApply) return inflightApply;
    inflightApply = (async () => {
      const cfg = typeof readConfigFn === 'function' ? readConfigFn() : null;
      const snap = getStatusSnapshot();
      const chosenUrl = String(downloadUrl || (targetVersion ? buildDeterministicZipUrl(targetVersion) : snap.downloadUrl) || '');
      const res = await applyPluginUpdate({
        installDir,
        stateDir,
        downloadUrl: chosenUrl,
        targetVersion: targetVersion || snap.latestVersion,
        fetchFn,
        proxyConfig: cfg,
      });
      if (res.ok && res.updatedVersion) {
        lastSnapshot = {
          ...snap,
          ok: true,
          currentVersion: res.updatedVersion,
          latestVersion: res.updatedVersion,
          hasUpdate: false,
          checkedAtMs: Date.now(),
          lastError: '',
        };
      }
      return res;
    })();
    try {
      return await inflightApply;
    } finally {
      inflightApply = null;
    }
  }

  return {
    getStatusSnapshot,
    check,
    apply,
  };
}
