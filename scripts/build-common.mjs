// Shared build helpers for AGY Claude Style (agy-claude-style) plugin package & CLI.
// Zero external npm dependencies: uses built-in Node zlib only.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const cdp = require(path.join(ROOT_DIR, 'cdp.js'));

// Single source of truth imported from cdp.js so CLI, package builder & inject.js stay aligned.
const VALIDATORS = cdp.CONFIG_VALIDATORS;

function normalizeVersion(version = cdp.PLUGIN_VERSION) {
  const raw = String(version || cdp.PLUGIN_VERSION).trim().replace(/^v/i, '');
  return raw || cdp.PLUGIN_VERSION;
}

function getArtifactNames(version = cdp.PLUGIN_VERSION) {
  const cleanVersion = normalizeVersion(version);
  return {
    version: cleanVersion,
    pluginZip: `agy-claude-style-v${cleanVersion}.zip`,
  };
}

const PAYLOAD_ROOT_FILES = [
  'plugin.json',
  'mcp_config.json',
  'package.json',
  'LICENSE',
  'README.md',
  'config.example.json',
  'style.css',
  'cdp.js',
  'inject.js',
  'wallpaper-server.js',
  'install.ps1',
  'install.sh',
];

const PAYLOAD_DIRS = ['assets', 'plugin', 'sidecars', 'features', 'scripts'];
const PAYLOAD_SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'node_modules', '.watch.pid', 'watch.log', 'config.json', 'wallpapers']);

function collectDirFiles(rootDir, relDir, outMap) {
  const absDir = path.join(rootDir, relDir);
  if (!fs.existsSync(absDir)) return;
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (PAYLOAD_SKIP_NAMES.has(entry.name)) continue;
    const relPath = `${relDir}/${entry.name}`.replace(/\\/g, '/');
    const absPath = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      collectDirFiles(rootDir, relPath, outMap);
    } else if (entry.isFile()) {
      outMap.set(relPath, fs.readFileSync(absPath));
    }
  }
}

function collectPluginPayloadFiles(rootDir = ROOT_DIR) {
  const files = new Map();
  const rootCandidates = [...PAYLOAD_ROOT_FILES, ...cdp.RUNTIME_PARTS];
  for (const rawRel of rootCandidates) {
    const rel = String(rawRel || '').replace(/\\/g, '/');
    if (!rel || files.has(rel)) continue;
    const abs = path.join(rootDir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      files.set(rel, fs.readFileSync(abs));
    }
  }
  for (const dir of PAYLOAD_DIRS) {
    collectDirFiles(rootDir, dir, files);
  }
  return Array.from(files.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, data]) => ({ name, data }));
}

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

export {
  ROOT_DIR,
  cdp,
  VALIDATORS,
  normalizeVersion,
  getArtifactNames,
  collectPluginPayloadFiles,
  buildZip,
};
