// Persistent local wallpaper storage manager for AGY Claude Style (v4.0.0).
// Validates extensions + header magic bytes, supports 512KB chunked uploads & local file import.
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, extname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const wpServer = require('../../../wallpaper-server.js');

const {
  MAX_WALLPAPER_BYTES,
  WALLPAPER_MIME_BY_EXT,
  WALLPAPER_KIND_BY_EXT,
  isSafeWallpaperFileName,
  detectWallpaperMedia,
} = wpServer;

const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const STALE_PART_AGE_MS = 30 * 60 * 1000;

function sanitizeStem(rawName) {
  const base = basename(String(rawName || ''), extname(String(rawName || '')));
  const clean = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return clean || 'wallpaper';
}

function buildStoredFileName(rawName, now = Date.now()) {
  const ext = extname(String(rawName || '')).toLowerCase();
  const stem = sanitizeStem(rawName);
  const ts = Number(now).toString(36);
  const rand = Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
  const candidate = `wp-${ts}-${rand}-${stem}${ext}`;
  return candidate.length <= 120 ? candidate : `wp-${ts}-${rand}${ext}`;
}

function cleanupStalePartFiles(dir) {
  if (!existsSync(dir)) return;
  const now = Date.now();
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.part')) continue;
      const p = join(dir, entry);
      try {
        const st = statSync(p);
        if (now - (st.mtimeMs || 0) > STALE_PART_AGE_MS) {
          unlinkSync(p);
        }
      } catch {}
    }
  } catch {}
}

function readHeadBytes(filePath, count = 64) {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(count);
    const bytesRead = readSync(fd, buf, 0, count, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

export function createWallpaperStore({ wallpapersDir }) {
  const rootDir = resolve(wallpapersDir);

  function ensureDir() {
    mkdirSync(rootDir, { recursive: true });
    cleanupStalePartFiles(rootDir);
  }

  function list() {
    if (!existsSync(rootDir)) return [];
    const items = [];
    for (const name of readdirSync(rootDir)) {
      if (!isSafeWallpaperFileName(name)) continue;
      const abs = join(rootDir, name);
      try {
        const st = statSync(abs);
        if (!st.isFile() || st.size <= 0) continue;
        const ext = extname(name).toLowerCase();
        items.push({
          name,
          kind: WALLPAPER_KIND_BY_EXT[ext] || 'image',
          mime: WALLPAPER_MIME_BY_EXT[ext] || 'application/octet-stream',
          size: st.size,
          mtimeMs: Math.round(st.mtimeMs || 0),
        });
      } catch {}
    }
    items.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
    return items;
  }

  function uploadChunk({ uploadId, index, total, fileName, chunkBase64 }) {
    const uid = String(uploadId || '').trim();
    if (!UPLOAD_ID_RE.test(uid)) {
      throw new Error('Invalid uploadId');
    }
    const idx = Number(index);
    const tot = Number(total);
    if (!Number.isInteger(idx) || !Number.isInteger(tot) || idx < 0 || tot <= 0 || idx >= tot || tot > 512) {
      throw new Error('Invalid chunk index or total');
    }
    const ext = extname(String(fileName || '')).toLowerCase();
    if (!WALLPAPER_MIME_BY_EXT[ext]) {
      throw new Error(`Unsupported file extension: ${ext || '(none)'}`);
    }
    const rawB64 = String(chunkBase64 || '').replace(/^data:[^;]+;base64,/i, '');
    const chunkBuf = Buffer.from(rawB64, 'base64');
    if (chunkBuf.length === 0 && tot === 1) {
      throw new Error('Empty media upload');
    }
    if (chunkBuf.length > 2 * 1024 * 1024) {
      throw new Error('Chunk exceeds 2MB limit');
    }

    ensureDir();
    const partPath = join(rootDir, `.upload-${uid}.part`);
    if (idx === 0) {
      writeFileSync(partPath, chunkBuf);
    } else {
      if (!existsSync(partPath)) {
        throw new Error('Upload session expired or missing initial chunk');
      }
      const st = statSync(partPath);
      if (st.size + chunkBuf.length > MAX_WALLPAPER_BYTES) {
        try { unlinkSync(partPath); } catch {}
        throw new Error('Wallpaper file exceeds 128MB limit');
      }
      appendFileSync(partPath, chunkBuf);
    }

    if (idx + 1 < tot) {
      return { ok: true, done: false, index: idx, total: tot };
    }

    const finalSt = statSync(partPath);
    if (finalSt.size <= 0 || finalSt.size > MAX_WALLPAPER_BYTES) {
      try { unlinkSync(partPath); } catch {}
      throw new Error('Invalid final file size');
    }
    const head = readHeadBytes(partPath, 64);
    const detected = detectWallpaperMedia(head, ext);
    if (!detected.ok) {
      try { unlinkSync(partPath); } catch {}
      throw new Error(detected.error);
    }

    const finalName = buildStoredFileName(fileName);
    const finalPath = join(rootDir, finalName);
    renameSync(partPath, finalPath);
    return {
      ok: true,
      done: true,
      item: {
        name: finalName,
        kind: detected.kind,
        mime: detected.mime,
        size: finalSt.size,
        mtimeMs: Date.now(),
      },
    };
  }

  function importFromPath(rawFilePath) {
    let input = String(rawFilePath || '').trim();
    if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) {
      input = input.slice(1, -1).trim();
    }
    if (!input) throw new Error('Empty file path');
    const resolved = resolve(input);
    if (!existsSync(resolved)) throw new Error('File does not exist');
    const real = realpathSync(resolved);
    const st = statSync(real);
    if (!st.isFile()) throw new Error('Path is not a file');
    if (st.size <= 0 || st.size > MAX_WALLPAPER_BYTES) {
      throw new Error('File size must be between 1 byte and 128MB');
    }
    const ext = extname(real).toLowerCase();
    const head = readHeadBytes(real, 64);
    const detected = detectWallpaperMedia(head, ext);
    if (!detected.ok) {
      throw new Error(detected.error);
    }

    ensureDir();
    const finalName = buildStoredFileName(basename(real));
    const destPath = join(rootDir, finalName);
    copyFileSync(real, destPath);
    return {
      ok: true,
      item: {
        name: finalName,
        kind: detected.kind,
        mime: detected.mime,
        size: st.size,
        mtimeMs: Date.now(),
      },
    };
  }

  function remove(fileName) {
    if (!isSafeWallpaperFileName(fileName)) {
      throw new Error('Invalid wallpaper filename');
    }
    if (!existsSync(rootDir)) return { ok: true, deleted: false };
    const realRoot = realpathSync(rootDir);
    const abs = resolve(realRoot, fileName);
    if (!abs.startsWith(realRoot + (process.platform === 'win32' ? '\\' : '/')) && !abs.startsWith(realRoot + '/')) {
      throw new Error('Invalid wallpaper path');
    }
    if (!existsSync(abs)) return { ok: true, deleted: false };
    unlinkSync(abs);
    return { ok: true, deleted: true, remaining: list() };
  }

  function readChunkBase64(fileName, offset = 0, length = 524288) {
    if (!isSafeWallpaperFileName(fileName)) {
      throw new Error('Invalid wallpaper filename');
    }
    if (!existsSync(rootDir)) throw new Error('Wallpaper not found');
    const realRoot = realpathSync(rootDir);
    const abs = resolve(realRoot, fileName);
    const sep = abs.indexOf(realRoot) === 0 && (abs[realRoot.length] === '/' || abs[realRoot.length] === '\\');
    if (!sep || !existsSync(abs)) throw new Error('Wallpaper not found');
    const st = statSync(abs);
    const safeOffset = Math.max(0, Math.min(st.size, Number(offset) || 0));
    const safeLen = Math.max(1, Math.min(524288, Number(length) || 524288));
    const toRead = Math.max(0, Math.min(safeLen, st.size - safeOffset));
    const ext = extname(fileName).toLowerCase();
    const mime = WALLPAPER_MIME_BY_EXT[ext] || 'application/octet-stream';
    if (toRead === 0) {
      return { ok: true, base64: '', offset: safeOffset, totalSize: st.size, mime, eof: true };
    }
    const fd = openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(toRead);
      const readBytes = readSync(fd, buf, 0, toRead, safeOffset);
      const nextOffset = safeOffset + readBytes;
      return {
        ok: true,
        base64: buf.subarray(0, readBytes).toString('base64'),
        offset: safeOffset,
        nextOffset,
        totalSize: st.size,
        mime,
        eof: nextOffset >= st.size,
      };
    } finally {
      closeSync(fd);
    }
  }

  return {
    rootDir,
    list,
    uploadChunk,
    importFromPath,
    remove,
    readChunkBase64,
  };
}
