#!/usr/bin/env node
// Build standalone Windows installer.exe for AGY Claude Style (agy-claude-style).
// Zero external npm dependencies: uses built-in Node zlib + Windows .NET Framework csc.exe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const cdp = require(path.join(ROOT_DIR, 'cdp.js'));

const VALIDATORS = {
  language: ['zh-CN', 'zh-TW', 'yue', 'en', 'ja'],
  palette: ['obsidian', 'claude', 'host'],
  homeLayout: ['studio', 'classic', 'off'],
  homeRipple: 'boolean',
  composerRestyle: 'boolean',
  mascot: ['crab', 'off'],
  logoInk: ['accent', 'foreground'],
  inlineStats: 'boolean',
  ringMode: ['context', 'quota'],
  turnBadges: 'boolean',
  hudTopBar: 'boolean',
  hudBottomBar: 'boolean',
  hudRimProgress: 'boolean',
  hudFooterChip: 'boolean',
  hudCompact: 'boolean',
  effortSliderStyle: ['claude', 'chatgpt', 'liangwufeng'],
  effortAccent: 'boolean',
  performanceBackdrop: ['off', 'card', 'page'],
  smoothCaret: 'boolean',
  sidebarRestyle: 'boolean',
  sidebarCompact: 'boolean',
  placeholderStyle: ['studio', 'host'],
};

function findCsc() {
  const winDir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(winDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('csc.exe (.NET Framework 4.x) not found');
}

// --- Pure Node PNG + Multi-Size ICO generator (Pixel Crab on Obsidian Badge) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([len, combined, crcBuf]);
}

function encodePngRgba(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: None
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// 16x16 pixel crab silhouette (0=transparent, 1=terracotta, 2=eye)
const CRAB_GRID = [
  '................',
  '..11........11..',
  '.111........111.',
  '.11..111111..11.',
  '..111111111111..',
  '...1111111111...',
  '..111211112111..',
  '..111211112111..',
  '..111111111111..',
  '.11111111111111.',
  '.1.1111111111.1.',
  '1..11......11..1',
  '...1.1....1.1...',
  '..1...1..1...1..',
  '................',
  '................',
];

function renderCrabIconPng(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const pad = Math.max(1, Math.round(size * 0.06));
  const radius = Math.max(2, size * 0.22);
  const innerMin = pad;
  const innerMax = size - pad - 1;

  function distToRoundedRect(x, y) {
    const cx = Math.max(innerMin + radius, Math.min(innerMax - radius, x));
    const cy = Math.max(innerMin + radius, Math.min(innerMax - radius, y));
    if (x >= innerMin + radius && x <= innerMax - radius && y >= innerMin && y <= innerMax) return 0;
    if (y >= innerMin + radius && y <= innerMax - radius && x >= innerMin && x <= innerMax) return 0;
    if (x >= innerMin && x <= innerMax && y >= innerMin && y <= innerMax) {
      return Math.hypot(x - cx, y - cy) - radius;
    }
    return Math.hypot(x - cx, y - cy) - radius;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const d = distToRoundedRect(x + 0.5, y + 0.5);
      if (d <= 0.5) {
        const edgeAlpha = d <= -0.5 ? 255 : Math.max(0, Math.min(255, Math.round((0.5 - d) * 255)));
        // Obsidian background (#1B1918) with subtle terracotta border (#D97757)
        const isBorder = d > -Math.max(1.2, size * 0.055);
        let r = isBorder ? 217 : 27;
        let g = isBorder ? 119 : 25;
        let b = isBorder ? 87 : 24;

        // Map into 16x16 crab grid inside padded central box
        const boxPad = size * 0.19;
        const boxSpan = size - boxPad * 2;
        const gx = Math.floor(((x + 0.5 - boxPad) / boxSpan) * 16);
        const gy = Math.floor(((y + 0.5 - boxPad) / boxSpan) * 16);
        if (gx >= 0 && gx < 16 && gy >= 0 && gy < 16) {
          const cell = CRAB_GRID[gy][gx];
          if (cell === '1') {
            r = 224; g = 122; b = 88;
          } else if (cell === '2') {
            r = 26; g = 24; b = 23;
          }
        }
        rgba[idx] = r;
        rgba[idx + 1] = g;
        rgba[idx + 2] = b;
        rgba[idx + 3] = edgeAlpha;
      }
    }
  }
  return encodePngRgba(size, size, rgba);
}

function buildMultiResIco(sizes = [16, 32, 48, 256]) {
  const pngs = sizes.map((s) => ({ size: s, data: renderCrabIconPng(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // ICON
  header.writeUInt16LE(pngs.length, 4);

  const dirEntries = [];
  let offset = 6 + pngs.length * 16;
  for (const item of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = item.size >= 256 ? 0 : item.size;
    entry[1] = item.size >= 256 ? 0 : item.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(item.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += item.data.length;
  }
  return Buffer.concat([header, ...dirEntries, ...pngs.map((p) => p.data)]);
}

// --- Pure Node ZIP builder (PKZIP Deflate, UTF-8 names) ---
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compBuf = zlib.deflateRawSync(rawBuf, { level: 9 });
    const crc = crc32(rawBuf);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x596f, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compBuf.length, 18);
    local.writeUInt32LE(rawBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuf, compBuf);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x596f, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compBuf.length, 20);
    central.writeUInt32LE(rawBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + compBuf.length;
  }

  const centralSize = centralParts.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function buildInstaller({ outputPath = path.join(ROOT_DIR, 'installer.exe'), configPath } = {}) {
  const csc = findCsc();
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-build-'));

  try {
    const icoPath = path.join(stageDir, 'app.ico');
    fs.writeFileSync(icoPath, buildMultiResIco());

    const manifest = {
      version: cdp.PLUGIN_VERSION,
      styleId: cdp.STYLE_ID,
      settingBinding: cdp.SETTING_BINDING,
      parts: cdp.RUNTIME_PARTS,
      defaultConfig: cdp.DEFAULT_CONFIG,
      validators: VALIDATORS,
      removeExpression: cdp.REMOVE_EXPRESSION,
    };
    const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
    fs.writeFileSync(path.join(stageDir, 'manifest.json'), manifestJson, 'utf8');

    const watcherOut = path.join(stageDir, 'agy-claude-style-watcher.exe');
    const commonMiniJson = path.join(ROOT_DIR, 'installer', 'common', 'MiniJson.cs');
    const commonCdpClient = path.join(ROOT_DIR, 'installer', 'common', 'CdpClient.cs');
    const watcherMain = path.join(ROOT_DIR, 'installer', 'watcher', 'Program.cs');

    execFileSync(csc, [
      '/nologo',
      '/utf8output',
      '/codepage:65001',
      '/target:winexe',
      '/optimize+',
      `/win32icon:${icoPath}`,
      `/out:${watcherOut}`,
      '/r:System.dll',
      '/r:System.Core.dll',
      '/r:System.Net.Http.dll',
      commonMiniJson,
      commonCdpClient,
      watcherMain,
    ], { stdio: 'inherit' });

    const activeConfigFile = configPath ||
      (fs.existsSync(path.join(ROOT_DIR, 'config.json'))
        ? path.join(ROOT_DIR, 'config.json')
        : path.join(ROOT_DIR, 'config.example.json'));

    const payloadFiles = [
      { name: 'agy-claude-style-watcher.exe', data: fs.readFileSync(watcherOut) },
      { name: 'manifest.json', data: Buffer.from(manifestJson, 'utf8') },
      { name: 'style.css', data: fs.readFileSync(path.join(ROOT_DIR, 'style.css')) },
      { name: 'config.json', data: fs.readFileSync(activeConfigFile) },
      { name: 'config.example.json', data: fs.readFileSync(path.join(ROOT_DIR, 'config.example.json')) },
      ...cdp.RUNTIME_PARTS.map((part) => ({
        name: part,
        data: fs.readFileSync(path.join(ROOT_DIR, part)),
      })),
    ];

    const payloadZip = path.join(stageDir, 'payload.zip');
    fs.writeFileSync(payloadZip, buildZip(payloadFiles));

    const setupManifest = path.join(ROOT_DIR, 'installer', 'setup', 'app.manifest');
    const setupMain = path.join(ROOT_DIR, 'installer', 'setup', 'Program.cs');
    const tempOut = path.join(stageDir, 'installer.exe');

    execFileSync(csc, [
      '/nologo',
      '/utf8output',
      '/codepage:65001',
      '/target:winexe',
      '/optimize+',
      `/win32icon:${icoPath}`,
      `/win32manifest:${setupManifest}`,
      `/resource:${payloadZip},AGY_PAYLOAD.zip`,
      `/out:${tempOut}`,
      '/r:System.dll',
      '/r:System.Core.dll',
      '/r:System.Drawing.dll',
      '/r:System.IO.Compression.dll',
      '/r:System.IO.Compression.FileSystem.dll',
      '/r:System.Management.dll',
      '/r:System.Net.Http.dll',
      '/r:System.Windows.Forms.dll',
      commonMiniJson,
      commonCdpClient,
      setupMain,
    ], { stdio: 'inherit' });

    fs.copyFileSync(tempOut, outputPath);
    const stat = fs.statSync(outputPath);
    return {
      outputPath,
      sizeBytes: stat.size,
      watcherSizeBytes: fs.statSync(watcherOut).size,
      payloadZipBytes: fs.statSync(payloadZip).size,
      fileCount: payloadFiles.length,
    };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2);
  let outputPath = path.join(ROOT_DIR, 'installer.exe');
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--out' || args[i] === '-o') && i + 1 < args.length) {
      outputPath = path.resolve(args[++i]);
    }
  }
  const res = buildInstaller({ outputPath });
  console.log(
    `[✓] Built ${res.outputPath} (${(res.sizeBytes / 1024).toFixed(1)} KB; ` +
    `payload ${(res.payloadZipBytes / 1024).toFixed(1)} KB, ${res.fileCount} files)`
  );
}

export {
  VALIDATORS,
  buildInstaller,
  buildZip,
  buildMultiResIco,
};
