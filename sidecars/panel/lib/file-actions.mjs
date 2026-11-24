// Local file actions helper for AGY Claude Style file context menu.
// Strictly validates file:// URIs and local filesystem paths (no shell interpolation).
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function resolveLocalFilePath(rawUri = '') {
  const input = String(rawUri || '').trim();
  if (!input) throw new Error('Empty file URI');
  let fsPath = '';
  if (/^file:\/\//i.test(input)) {
    const clean = input.split('#')[0].split('?')[0];
    fsPath = fileURLToPath(clean);
  } else if (isAbsolute(input)) {
    fsPath = input.split('#')[0];
  } else {
    throw new Error('Only local file:// URIs or absolute paths are supported');
  }
  const normalized = resolve(fsPath);
  if (/[\x00-\x1f\x7f]/.test(normalized)) {
    throw new Error('Invalid control character in path');
  }
  return normalized;
}

export function inspectLocalPath(rawUri = '') {
  const localPath = resolveLocalFilePath(rawUri);
  const exists = existsSync(localPath);
  let isDirectory = false;
  if (exists) {
    try {
      isDirectory = statSync(localPath).isDirectory();
    } catch {}
  }
  return { path: localPath, exists, isDirectory };
}

export async function openLocalFile(rawUri, { platform = process.platform, execFn = execFileAsync } = {}) {
  const info = inspectLocalPath(rawUri);
  if (!info.exists) throw new Error(`File not found: ${info.path}`);
  if (platform === 'darwin') {
    await execFn('/usr/bin/open', [info.path], { timeout: 5000 });
  } else if (platform === 'win32') {
    await execFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:AGY_FILE_PATH'],
      { timeout: 5000, windowsHide: true, env: { ...process.env, AGY_FILE_PATH: info.path } }
    );
  } else {
    await execFn('xdg-open', [info.path], { timeout: 5000 });
  }
  return { ok: true, path: info.path };
}

export async function revealLocalFile(rawUri, { platform = process.platform, execFn = execFileAsync } = {}) {
  const info = inspectLocalPath(rawUri);
  if (!info.exists) throw new Error(`File not found: ${info.path}`);
  if (platform === 'darwin') {
    await execFn('/usr/bin/open', ['-R', info.path], { timeout: 5000 });
  } else if (platform === 'win32') {
    await execFn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Start-Process -FilePath explorer.exe -ArgumentList ("/select,`"" + $env:AGY_FILE_PATH + "`"")',
      ],
      { timeout: 5000, windowsHide: true, env: { ...process.env, AGY_FILE_PATH: info.path } }
    );
  } else {
    const dir = info.isDirectory ? info.path : dirname(info.path);
    await execFn('xdg-open', [dir], { timeout: 5000 });
  }
  return { ok: true, path: info.path };
}

export async function copyLocalFileToClipboard(rawUri, { platform = process.platform, execFn = execFileAsync } = {}) {
  const info = inspectLocalPath(rawUri);
  if (!info.exists) throw new Error(`File not found: ${info.path}`);
  if (platform === 'darwin') {
    const script = 'on run argv\nset the clipboard to (POSIX file (item 1 of argv))\nend run';
    await execFn('/usr/bin/osascript', ['-e', script, '--', info.path], { timeout: 5000 });
  } else if (platform === 'win32') {
    await execFn(
      'powershell.exe',
      ['-STA', '-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -LiteralPath $env:AGY_FILE_PATH'],
      { timeout: 5000, windowsHide: true, env: { ...process.env, AGY_FILE_PATH: info.path } }
    );
  } else {
    throw new Error('Copy file object to clipboard is supported on macOS and Windows');
  }
  return { ok: true, path: info.path };
}

export async function dispatchFileAction(action = {}, opts = {}) {
  const type = String(action?.type || '');
  const uri = String(action?.uri || '');
  if (type === 'file.open') return openLocalFile(uri, opts);
  if (type === 'file.reveal') return revealLocalFile(uri, opts);
  if (type === 'file.copy') return copyLocalFileToClipboard(uri, opts);
  if (type === 'file.path') return { ok: true, ...inspectLocalPath(uri) };
  throw new Error(`Unsupported file action: ${type}`);
}
