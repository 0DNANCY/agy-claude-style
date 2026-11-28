// Loopback Range-streaming media server & magic-byte validator for AGY Claude Style dynamic wallpapers.
// Zero external dependencies (Node built-ins only).
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const MAX_WALLPAPER_BYTES = 128 * 1024 * 1024; // 128 MB

const WALLPAPER_MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const WALLPAPER_KIND_BY_EXT = {
  '.mp4': 'video',
  '.webm': 'video',
  '.gif': 'image',
  '.webp': 'image',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
};

const SAFE_WALLPAPER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function isSafeWallpaperFileName(name) {
  const s = String(name || '').trim();
  if (!s || s.includes('..') || s.includes('/') || s.includes('\\')) return false;
  if (!SAFE_WALLPAPER_NAME_RE.test(s)) return false;
  const ext = path.extname(s).toLowerCase();
  return Boolean(WALLPAPER_MIME_BY_EXT[ext]);
}

function detectWallpaperMedia(headBuf, extInput) {
  const ext = String(extInput || '').toLowerCase();
  const mime = WALLPAPER_MIME_BY_EXT[ext];
  const kind = WALLPAPER_KIND_BY_EXT[ext];
  if (!mime || !kind) {
    return { ok: false, error: `Unsupported media extension: ${ext || '(none)'}` };
  }
  const buf = Buffer.isBuffer(headBuf) ? headBuf : Buffer.from(headBuf || '');
  if (buf.length < 4) {
    return { ok: false, error: 'File is too small to be a valid media asset' };
  }

  let matched = false;
  if (ext === '.mp4') {
    // ISO Base Media File Format: [4-byte size]['ftyp']
    matched = buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp';
  } else if (ext === '.webm') {
    // EBML header: 1A 45 DF A3
    matched = buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  } else if (ext === '.gif') {
    const hdr = buf.subarray(0, 6).toString('ascii');
    matched = hdr === 'GIF87a' || hdr === 'GIF89a';
  } else if (ext === '.webp') {
    matched = buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
  } else if (ext === '.png') {
    matched =
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a;
  } else if (ext === '.jpg' || ext === '.jpeg') {
    matched = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }

  if (!matched) {
    return { ok: false, error: `File header does not match ${ext} signature` };
  }
  return { ok: true, ext, mime, kind };
}

function toVscodeFileUri(absPath) {
  const normalized = String(absPath || '').replace(/\\/g, '/');
  if (!normalized) return '';
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `vscode-file://vscode-app${encodeURI(withLeadingSlash).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

function parseByteRange(rangeHeader, totalSize) {
  const raw = String(rangeHeader || '').trim();
  if (!raw) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(raw);
  if (!m) return { invalid: true };
  if (totalSize <= 0) return { invalid: true };
  const startStr = m[1];
  const endStr = m[2];
  let start = 0;
  let end = totalSize - 1;
  if (startStr === '' && endStr === '') return { invalid: true };
  if (startStr === '') {
    const suffix = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    if (!Number.isFinite(start) || start < 0 || start >= totalSize) return { invalid: true };
    if (endStr !== '') {
      end = Number.parseInt(endStr, 10);
      if (!Number.isFinite(end) || end < start) return { invalid: true };
      end = Math.min(end, totalSize - 1);
    }
  }
  return { start, end };
}

function safeTokenEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createWallpaperMediaServer({ wallpapersDir }) {
  const rootDir = path.resolve(wallpapersDir);
  const token = crypto.randomBytes(16).toString('hex');
  const tokenBuf = Buffer.from(token, 'utf8');
  let server = null;
  let listenPromise = null;
  let port = 0;

  function resolveSafeFilePath(fileName) {
    if (!isSafeWallpaperFileName(fileName)) return null;
    if (!fs.existsSync(rootDir)) return null;
    try {
      const realRoot = fs.realpathSync(rootDir);
      const absPath = path.resolve(realRoot, fileName);
      if (!absPath.startsWith(realRoot + path.sep)) return null;
      const realFile = fs.realpathSync(absPath);
      if (!realFile.startsWith(realRoot + path.sep)) return null;
      const st = fs.statSync(realFile);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_WALLPAPER_BYTES) return null;
      const ext = path.extname(fileName).toLowerCase();
      return {
        absPath: realFile,
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs || 0),
        ext,
        mime: WALLPAPER_MIME_BY_EXT[ext],
        kind: WALLPAPER_KIND_BY_EXT[ext],
      };
    } catch {
      return null;
    }
  }

  function handleRequest(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }
    const urlPath = String(req.url || '').split('?')[0];
    const parts = urlPath.split('/').filter(Boolean);
    if (parts.length !== 3 || parts[0] !== 'ag-cs-wp') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const reqToken = parts[1];
    const reqTokenBuf = Buffer.from(reqToken, 'utf8');
    if (reqTokenBuf.length !== tokenBuf.length || !crypto.timingSafeEqual(reqTokenBuf, tokenBuf)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    let fileName = '';
    try {
      fileName = decodeURIComponent(parts[2]);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }
    const info = resolveSafeFilePath(fileName);
    if (!info) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const commonHeaders = {
      'Content-Type': info.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };

    const parsedRange = req.headers.range ? parseByteRange(req.headers.range, info.size) : null;
    if (parsedRange && parsedRange.invalid) {
      res.writeHead(416, { ...commonHeaders, 'Content-Range': `bytes */${info.size}` });
      res.end();
      return;
    }

    if (parsedRange) {
      const { start, end } = parsedRange;
      const chunkLen = end - start + 1;
      res.writeHead(206, {
        ...commonHeaders,
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Content-Length': String(chunkLen),
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(info.absPath, { start, end });
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      stream.pipe(res);
      return;
    }

    res.writeHead(200, {
      ...commonHeaders,
      'Content-Length': String(info.size),
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(info.absPath);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.pipe(res);
  }

  async function ensureStarted() {
    if (port > 0 && server) return { port, token, baseUrl: `http://127.0.0.1:${port}` };
    if (listenPromise) return listenPromise;
    listenPromise = new Promise((resolveStart, rejectStart) => {
      const srv = http.createServer(handleRequest);
      srv.once('error', (err) => {
        listenPromise = null;
        rejectStart(err);
      });
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        port = addr && typeof addr === 'object' ? addr.port : 0;
        server = srv;
        if (typeof srv.unref === 'function') srv.unref();
        resolveStart({ port, token, baseUrl: `http://127.0.0.1:${port}` });
      });
    });
    return listenPromise;
  }

  function resolveActiveMeta(wpFile) {
    const info = resolveSafeFilePath(wpFile);
    if (!info) return null;
    const httpUrl = port > 0 ? `http://127.0.0.1:${port}/ag-cs-wp/${token}/${encodeURIComponent(wpFile)}` : '';
    return {
      file: wpFile,
      kind: info.kind,
      mime: info.mime,
      size: info.size,
      mtimeMs: info.mtimeMs,
      httpUrl,
      vscodeUri: toVscodeFileUri(info.absPath),
    };
  }

  function close() {
    const srv = server;
    server = null;
    port = 0;
    listenPromise = null;
    if (!srv) return Promise.resolve();
    return new Promise((resolveClose) => {
      try {
        srv.close(() => resolveClose());
      } catch {
        resolveClose();
      }
    });
  }

  return {
    token,
    getPort: () => port,
    ensureStarted,
    resolveSafeFilePath,
    resolveActiveMeta,
    safeTokenEqual,
    close,
  };
}

module.exports = {
  MAX_WALLPAPER_BYTES,
  WALLPAPER_MIME_BY_EXT,
  WALLPAPER_KIND_BY_EXT,
  isSafeWallpaperFileName,
  detectWallpaperMedia,
  toVscodeFileUri,
  parseByteRange,
  createWallpaperMediaServer,
};
