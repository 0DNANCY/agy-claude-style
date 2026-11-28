// Builds the lightweight cross-platform plugin package zip (dist/agy-claude-style-v<version>.zip).
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT_DIR,
  buildZip,
  collectPluginPayloadFiles,
  getArtifactNames,
  normalizeVersion,
} from './build-common.mjs';

function buildPackage({ rootDir = ROOT_DIR, outputPath, version } = {}) {
  const cleanVersion = normalizeVersion(version);
  const names = getArtifactNames(cleanVersion);
  const outZip = path.resolve(rootDir, outputPath || path.join('dist', names.pluginZip));
  fs.mkdirSync(path.dirname(outZip), { recursive: true });

  const entries = collectPluginPayloadFiles(rootDir);
  const zipBuf = buildZip(entries);
  fs.writeFileSync(outZip, zipBuf);

  return {
    version: cleanVersion,
    outputPath: outZip,
    fileCount: entries.length,
    sizeBytes: zipBuf.length,
  };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version' && argv[i + 1]) {
      opts.version = argv[++i];
    } else if (arg === '--out' && argv[i + 1]) {
      opts.outputPath = argv[++i];
    } else if (arg === '--root' && argv[i + 1]) {
      opts.rootDir = path.resolve(argv[++i]);
    }
  }
  return opts;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const res = buildPackage(parseArgs(process.argv.slice(2)));
  console.log(`[✓] Built plugin package: ${res.outputPath} (${res.fileCount} files, ${(res.sizeBytes / 1024).toFixed(1)} KB)`);
}

export { buildPackage };
