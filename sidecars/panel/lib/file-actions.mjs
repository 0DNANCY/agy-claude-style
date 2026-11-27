// Local file actions helper for AGY Claude Style file context menu.
// Strictly validates file:// URIs and local filesystem paths (no shell interpolation).
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const LINE_COL_ANCHOR_RE = /#(?:L?\d+(?::C?\d+)?(?:-L?\d+(?::C?\d+)?)?)$/i;
const PARSE_ANCHOR_RE = /#L?(\d+)(?::C?(\d+))?(?:-L?\d+(?::C?\d+)?)?$/i;
const LOOPBACK_HOSTS = new Set(['', 'localhost', '127.0.0.1', '[::1]', '::1']);
const WIN_CMD_UNSAFE_RE = /[\r\n"&|<>^%!]/;

export function stripLineColAnchor(raw = '') {
  return String(raw || '').replace(LINE_COL_ANCHOR_RE, '');
}

export function parseFileUriAnchor(raw = '') {
  const m = PARSE_ANCHOR_RE.exec(String(raw || '').trim());
  if (!m) return { line: null, column: null };
  const line = Number.parseInt(m[1], 10);
  const column = m[2] ? Number.parseInt(m[2], 10) : null;
  return {
    line: Number.isInteger(line) && line > 0 ? line : null,
    column: Number.isInteger(column) && column > 0 ? column : null,
  };
}

export function resolveLocalFilePath(rawUri = '', { platform = process.platform } = {}) {
  const input = String(rawUri || '').trim();
  if (!input) throw new Error('Empty file URI');
  let fsPath = '';
  if (/^file:\/\//i.test(input)) {
    const withoutAnchor = stripLineColAnchor(input);
    const queryIdx = withoutAnchor.indexOf('?');
    const withoutQuery = queryIdx >= 0 ? withoutAnchor.slice(0, queryIdx) : withoutAnchor;
    // Encode any remaining literal '#' inside local path segments (e.g. C# folders) before URL parsing
    const encodedHash = withoutQuery.replace(/#/g, '%23');
    let parsed;
    try {
      parsed = new URL(encodedHash);
    } catch {
      throw new Error('Invalid file URI');
    }
    if (parsed.protocol !== 'file:') {
      throw new Error('Only local file:// URIs or absolute paths are supported');
    }
    const host = String(parsed.hostname || '').trim().toLowerCase();
    // Validate host BEFORE calling fileURLToPath so non-local SMB/host URIs are rejected cleanly
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new Error(`Non-local file URI host rejected: ${host}`);
    }
    const useWinUrl = platform === 'win32' && /^\/[a-zA-Z]:(?:\/|$)/.test(parsed.pathname || '');
    fsPath = fileURLToPath(parsed, { windows: useWinUrl });
  } else if (isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input)) {
    fsPath = stripLineColAnchor(input);
  } else {
    throw new Error('Only local file:// URIs or absolute paths are supported');
  }
  const normalized = platform === 'win32' ? fsPath : posix.resolve(fsPath);
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

export async function revealLocalFile(rawUri, { platform = process.platform, execFn = null, spawnProcess = spawn } = {}) {
  const info = inspectLocalPath(rawUri);
  if (!info.exists) throw new Error(`File not found: ${info.path}`);
  const runExec = execFn || execFileAsync;
  if (platform === 'darwin') {
    await runExec('/usr/bin/open', ['-R', info.path], { timeout: 5000 });
  } else if (platform === 'win32') {
    // Pass /select,"<path>" verbatim directly to explorer.exe so paths with spaces/Unicode highlight reliably.
    // Never pass windowsHide: true to explorer.exe (it is a GUI app and SW_HIDE suppresses/hides the window).
    const normalizedPath = info.path.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
    const isDriveRoot = /^[A-Z]:[\\/]?$/.test(normalizedPath);
    const cleanPath = isDriveRoot ? normalizedPath : normalizedPath.replace(/\\+$/, '').replace(/"/g, '');
    const args = isDriveRoot ? [cleanPath] : [`/select,"${cleanPath}"`];
    if (execFn) {
      try {
        await execFn('explorer.exe', args, {
          timeout: 5000,
          windowsVerbatimArguments: true,
          windowsHide: false,
        });
      } catch (err) {
        if (!(err && err.code === 1 && !err.killed && !String(err.stderr || '').trim())) {
          throw err;
        }
      }
    } else {
      const child = spawnProcess('explorer.exe', args, {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
        windowsHide: false,
      });
      child?.on?.('error', () => {});
      child?.unref?.();
    }
  } else {
    const dir = info.isDirectory ? info.path : dirname(info.path);
    await runExec('xdg-open', [dir], { timeout: 5000 });
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

function firstExisting(paths, exists) {
  for (const p of paths) {
    if (p && exists(p)) return p;
  }
  return '';
}

function findInPath(cliNames, { platform, env, exists, winExeName = '' }) {
  const pathSep = platform === 'win32' ? ';' : ':';
  const rawPath = String(env?.PATH || env?.Path || '');
  const pathDirs = rawPath.split(pathSep).map((s) => s.trim()).filter(Boolean);
  let cmdFallback = '';
  for (const dir of pathDirs) {
    for (const cli of cliNames) {
      if (platform === 'win32') {
        const exePath = join(dir, `${cli}.exe`);
        if (exists(exePath)) return exePath;
        const cmdPath = join(dir, `${cli}.cmd`);
        if (exists(cmdPath)) {
          const parentExe = winExeName
            ? firstExisting([join(dir, '..', winExeName), join(dir, '..', '..', '..', winExeName)], exists)
            : '';
          if (parentExe) return parentExe;
          if (!cmdFallback) cmdFallback = cmdPath;
        }
      } else {
        const p = join(dir, cli);
        if (exists(p)) return p;
      }
    }
  }
  return cmdFallback;
}

function scanWinVisualStudio(env, exists, readdir) {
  const bases = [env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean).map((p) => join(p, 'Microsoft Visual Studio'));
  for (const base of bases) {
    if (!exists(base)) continue;
    let years = [];
    try {
      years = readdir(base).sort().reverse();
    } catch {
      continue;
    }
    for (const yr of years) {
      const yrDir = join(base, yr);
      let editions = [];
      try {
        editions = readdir(yrDir);
      } catch {
        continue;
      }
      for (const ed of editions) {
        const devenv = join(yrDir, ed, 'Common7', 'IDE', 'devenv.exe');
        if (exists(devenv)) return devenv;
      }
    }
  }
  return '';
}

function scanWinJetBrains(env, exists, readdir) {
  const specs = [
    ['idea', 'IntelliJ IDEA', 'idea64.exe', /intellij\s*idea/i],
    ['pycharm', 'PyCharm', 'pycharm64.exe', /pycharm/i],
    ['webstorm', 'WebStorm', 'webstorm64.exe', /webstorm/i],
    ['goland', 'GoLand', 'goland64.exe', /goland/i],
    ['rider', 'Rider', 'rider64.exe', /rider/i],
    ['clion', 'CLion', 'clion64.exe', /clion/i],
    ['phpstorm', 'PhpStorm', 'phpstorm64.exe', /phpstorm/i],
    ['datagrip', 'DataGrip', 'datagrip64.exe', /datagrip/i],
  ];
  const roots = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'),
    env.PROGRAMFILES && join(env.PROGRAMFILES, 'JetBrains'),
  ].filter(Boolean);
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    if (!exists(root)) continue;
    let entries = [];
    try {
      entries = readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      for (const [id, label, exe, re] of specs) {
        if (seen.has(id) || !re.test(entry)) continue;
        const bin = join(root, entry, 'bin', exe);
        if (exists(bin)) {
          seen.add(id);
          found.push({ id, label, kind: 'editor', icon: 'jetbrains', style: 'jetbrains', command: bin });
        }
      }
    }
  }
  return found;
}

function scanMacApplications(home, exists, readdir) {
  const dirs = ['/Applications', join(home, 'Applications')];
  const catalog = [
    { id: 'vscode', label: 'VS Code', icon: 'vscode', kind: 'editor', re: /^Visual Studio Code\.app$/i, cli: 'Contents/Resources/app/bin/code', style: 'vscode' },
    { id: 'vscode-insiders', label: 'VS Code Insiders', icon: 'vscode', kind: 'editor', re: /^Visual Studio Code - Insiders\.app$/i, cli: 'Contents/Resources/app/bin/code', style: 'vscode' },
    { id: 'cursor', label: 'Cursor', icon: 'cursor', kind: 'editor', re: /^Cursor\.app$/i, cli: 'Contents/Resources/app/bin/cursor', style: 'vscode' },
    { id: 'windsurf', label: 'Windsurf', icon: 'windsurf', kind: 'editor', re: /^Windsurf\.app$/i, cli: 'Contents/Resources/app/bin/windsurf', style: 'vscode' },
    { id: 'trae', label: 'Trae', icon: 'editor', kind: 'editor', re: /^Trae\.app$/i, cli: 'Contents/Resources/app/bin/marscode', style: 'vscode' },
    { id: 'zed', label: 'Zed', icon: 'zed', kind: 'editor', re: /^Zed\.app$/i, cli: 'Contents/MacOS/cli', style: 'zed' },
    { id: 'antigravity', label: 'Antigravity', icon: 'antigravity', kind: 'editor', re: /^Antigravity\.app$/i, cli: 'Contents/Resources/app/bin/antigravity', style: 'vscode' },
    { id: 'xcode', label: 'Xcode', icon: 'editor', kind: 'editor', re: /^Xcode\.app$/i, cli: '', style: 'mac-app' },
    { id: 'sublime', label: 'Sublime Text', icon: 'sublime', kind: 'editor', re: /^Sublime Text\.app$/i, cli: 'Contents/SharedSupport/bin/subl', style: 'sublime' },
    { id: 'idea', label: 'IntelliJ IDEA', icon: 'jetbrains', kind: 'editor', re: /^IntelliJ IDEA.*\.app$/i, cli: 'Contents/MacOS/idea', style: 'jetbrains' },
    { id: 'pycharm', label: 'PyCharm', icon: 'jetbrains', kind: 'editor', re: /^PyCharm.*\.app$/i, cli: 'Contents/MacOS/pycharm', style: 'jetbrains' },
    { id: 'webstorm', label: 'WebStorm', icon: 'jetbrains', kind: 'editor', re: /^WebStorm.*\.app$/i, cli: 'Contents/MacOS/webstorm', style: 'jetbrains' },
    { id: 'goland', label: 'GoLand', icon: 'jetbrains', kind: 'editor', re: /^GoLand.*\.app$/i, cli: 'Contents/MacOS/goland', style: 'jetbrains' },
    { id: 'rider', label: 'Rider', icon: 'jetbrains', kind: 'editor', re: /^Rider.*\.app$/i, cli: 'Contents/MacOS/rider', style: 'jetbrains' },
    { id: 'clion', label: 'CLion', icon: 'jetbrains', kind: 'editor', re: /^CLion.*\.app$/i, cli: 'Contents/MacOS/clion', style: 'jetbrains' },
    { id: 'android-studio', label: 'Android Studio', icon: 'jetbrains', kind: 'editor', re: /^Android Studio.*\.app$/i, cli: 'Contents/MacOS/studio', style: 'jetbrains' },
    { id: 'iterm', label: 'iTerm', icon: 'terminal', kind: 'terminal', re: /^iTerm\.app$/i, cli: '', style: 'terminal-mac' },
    { id: 'ghostty', label: 'Ghostty', icon: 'terminal', kind: 'terminal', re: /^Ghostty\.app$/i, cli: '', style: 'terminal-mac' },
    { id: 'warp', label: 'Warp', icon: 'terminal', kind: 'terminal', re: /^Warp\.app$/i, cli: '', style: 'terminal-mac' },
    { id: 'wezterm', label: 'WezTerm', icon: 'terminal', kind: 'terminal', re: /^WezTerm\.app$/i, cli: '', style: 'terminal-mac' },
    { id: 'kitty', label: 'Kitty', icon: 'terminal', kind: 'terminal', re: /^kitty\.app$/i, cli: '', style: 'terminal-mac' },
    { id: 'alacritty', label: 'Alacritty', icon: 'terminal', kind: 'terminal', re: /^Alacritty\.app$/i, cli: '', style: 'terminal-mac' },
  ];
  const found = new Map();
  for (const dir of dirs) {
    if (!exists(dir)) continue;
    let items = [];
    try {
      items = readdir(dir);
    } catch {
      continue;
    }
    for (const item of items) {
      for (const spec of catalog) {
        if (found.has(spec.id) || !spec.re.test(item)) continue;
        const appPath = join(dir, item);
        const cliPath = spec.cli ? join(appPath, spec.cli) : '';
        const hasCli = Boolean(cliPath && exists(cliPath));
        found.set(spec.id, {
          id: spec.id,
          label: spec.label,
          kind: spec.kind,
          icon: spec.icon,
          style: hasCli ? spec.style : (spec.kind === 'terminal' ? 'terminal-mac' : 'mac-app'),
          command: hasCli ? cliPath : appPath,
        });
      }
    }
  }
  const ordered = catalog.map((c) => found.get(c.id)).filter(Boolean);
  const sysTerminal = '/System/Applications/Utilities/Terminal.app';
  if (exists(sysTerminal)) {
    ordered.push({ id: 'terminal', label: 'Terminal', kind: 'terminal', icon: 'terminal', style: 'terminal-mac', command: sysTerminal });
  }
  return ordered;
}

export function discoverOpenWithApps({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  exists = existsSync,
  readdir = readdirSync,
} = {}) {
  const editors = [];
  const terminals = [];
  const seen = new Set();
  const push = (list, item) => {
    if (!item || !item.id || seen.has(item.id)) return;
    seen.add(item.id);
    list.push(item);
  };

  if (platform === 'win32') {
    const e = env || {};
    const winEditors = [
      { id: 'vscode', label: 'VS Code', icon: 'vscode', style: 'vscode', winExeName: 'Code.exe', cliNames: ['code'], paths: [e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'), e.PROGRAMFILES && join(e.PROGRAMFILES, 'Microsoft VS Code', 'Code.exe')] },
      { id: 'vscode-insiders', label: 'VS Code Insiders', icon: 'vscode', style: 'vscode', winExeName: 'Code - Insiders.exe', cliNames: ['code-insiders'], paths: [e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'), e.PROGRAMFILES && join(e.PROGRAMFILES, 'Microsoft VS Code Insiders', 'Code - Insiders.exe')] },
      { id: 'cursor', label: 'Cursor', icon: 'cursor', style: 'vscode', winExeName: 'Cursor.exe', cliNames: ['cursor'], paths: [e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe'), e.PROGRAMFILES && join(e.PROGRAMFILES, 'cursor', 'Cursor.exe')] },
      { id: 'windsurf', label: 'Windsurf', icon: 'windsurf', style: 'vscode', winExeName: 'Windsurf.exe', cliNames: ['windsurf'], paths: [e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Programs', 'Windsurf', 'Windsurf.exe'), e.PROGRAMFILES && join(e.PROGRAMFILES, 'Windsurf', 'Windsurf.exe')] },
      { id: 'trae', label: 'Trae', icon: 'editor', style: 'vscode', winExeName: 'Trae.exe', cliNames: ['trae'], paths: [e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Programs', 'Trae', 'Trae.exe'), e.PROGRAMFILES && join(e.PROGRAMFILES, 'Trae', 'Trae.exe')] },
      { id: 'zed', label: 'Zed', icon: 'zed', style: 'zed', winExeName: 'Zed.exe', cliNames: ['zed'], paths: [e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Programs', 'Zed', 'Zed.exe'), e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Programs', 'Zed', 'bin', 'zed.exe')] },
      { id: 'antigravity', label: 'Antigravity', icon: 'antigravity', style: 'vscode', winExeName: 'Antigravity.exe', cliNames: ['antigravity'], paths: [e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Programs', 'Antigravity', 'Antigravity.exe'), e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Programs', 'antigravity', 'Antigravity.exe'), e.PROGRAMFILES && join(e.PROGRAMFILES, 'Antigravity', 'Antigravity.exe')] },
      { id: 'sublime', label: 'Sublime Text', icon: 'sublime', style: 'sublime', winExeName: 'sublime_text.exe', cliNames: ['subl'], paths: [e.PROGRAMFILES && join(e.PROGRAMFILES, 'Sublime Text', 'sublime_text.exe'), e.PROGRAMFILES && join(e.PROGRAMFILES, 'Sublime Text 3', 'sublime_text.exe')] },
      { id: 'notepadpp', label: 'Notepad++', icon: 'editor', style: 'notepadpp', winExeName: 'notepad++.exe', cliNames: ['notepad++'], paths: [e.PROGRAMFILES && join(e.PROGRAMFILES, 'Notepad++', 'notepad++.exe'), e['PROGRAMFILES(X86)'] && join(e['PROGRAMFILES(X86)'], 'Notepad++', 'notepad++.exe')] },
    ];
    for (const spec of winEditors) {
      const cmd = firstExisting(spec.paths, exists) || findInPath(spec.cliNames, { platform, env: e, exists, winExeName: spec.winExeName });
      if (cmd) push(editors, { id: spec.id, label: spec.label, kind: 'editor', icon: spec.icon, style: spec.style, command: cmd });
    }
    const vsCmd = scanWinVisualStudio(e, exists, readdir);
    if (vsCmd) push(editors, { id: 'visualstudio', label: 'Visual Studio', kind: 'editor', icon: 'visualstudio', style: 'vs', command: vsCmd });
    for (const jb of scanWinJetBrains(e, exists, readdir)) push(editors, jb);

    const winAppsDir = e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Microsoft', 'WindowsApps');
    let wtCmd = firstExisting([winAppsDir && join(winAppsDir, 'wt.exe')], exists) || findInPath(['wt'], { platform, env: e, exists });
    if (!wtCmd && winAppsDir) {
      try {
        if (readdir(winAppsDir).some((n) => String(n).toLowerCase() === 'wt.exe')) wtCmd = join(winAppsDir, 'wt.exe');
      } catch {}
    }
    if (wtCmd) push(terminals, { id: 'terminal', label: 'Terminal', kind: 'terminal', icon: 'terminal', style: 'terminal-wt', command: wtCmd });
    const gitBash = firstExisting([
      e.PROGRAMFILES && join(e.PROGRAMFILES, 'Git', 'git-bash.exe'),
      e['PROGRAMFILES(X86)'] && join(e['PROGRAMFILES(X86)'], 'Git', 'git-bash.exe'),
      e.LOCALAPPDATA && join(e.LOCALAPPDATA, 'Programs', 'Git', 'git-bash.exe'),
    ], exists);
    if (gitBash) push(terminals, { id: 'git-bash', label: 'Git Bash', kind: 'terminal', icon: 'gitbash', style: 'terminal-gitbash', command: gitBash });
    const wslCmd = firstExisting([join(e.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe')], exists);
    if (wslCmd) push(terminals, { id: 'wsl', label: 'WSL', kind: 'terminal', icon: 'wsl', style: 'terminal-wsl', command: wslCmd });
  } else if (platform === 'darwin') {
    for (const item of scanMacApplications(home, exists, readdir)) {
      push(item.kind === 'terminal' ? terminals : editors, item);
    }
  } else {
    const linuxEditors = [
      { id: 'vscode', label: 'VS Code', icon: 'vscode', style: 'vscode', cliNames: ['code'], paths: [join(home, '.local', 'bin', 'code'), '/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code'] },
      { id: 'vscode-insiders', label: 'VS Code Insiders', icon: 'vscode', style: 'vscode', cliNames: ['code-insiders'], paths: ['/usr/bin/code-insiders', '/snap/bin/code-insiders'] },
      { id: 'cursor', label: 'Cursor', icon: 'cursor', style: 'vscode', cliNames: ['cursor'], paths: [join(home, '.local', 'bin', 'cursor'), '/usr/local/bin/cursor', '/usr/bin/cursor'] },
      { id: 'windsurf', label: 'Windsurf', icon: 'windsurf', style: 'vscode', cliNames: ['windsurf'], paths: [join(home, '.local', 'bin', 'windsurf'), '/usr/local/bin/windsurf', '/usr/bin/windsurf'] },
      { id: 'trae', label: 'Trae', icon: 'editor', style: 'vscode', cliNames: ['trae'], paths: [join(home, '.local', 'bin', 'trae'), '/usr/local/bin/trae', '/usr/bin/trae'] },
      { id: 'zed', label: 'Zed', icon: 'zed', style: 'zed', cliNames: ['zed', 'zeditor'], paths: [join(home, '.local', 'bin', 'zed'), '/usr/local/bin/zed', '/usr/bin/zed', '/usr/bin/zeditor'] },
      { id: 'antigravity', label: 'Antigravity', icon: 'antigravity', style: 'vscode', cliNames: ['antigravity'], paths: ['/usr/bin/antigravity', '/usr/local/bin/antigravity'] },
      { id: 'sublime', label: 'Sublime Text', icon: 'sublime', style: 'sublime', cliNames: ['subl'], paths: ['/usr/bin/subl', '/usr/local/bin/subl', '/snap/bin/subl'] },
      { id: 'idea', label: 'IntelliJ IDEA', icon: 'jetbrains', style: 'jetbrains', cliNames: ['idea'], paths: [join(home, '.local', 'bin', 'idea'), '/usr/local/bin/idea'] },
      { id: 'pycharm', label: 'PyCharm', icon: 'jetbrains', style: 'jetbrains', cliNames: ['pycharm'], paths: [join(home, '.local', 'bin', 'pycharm'), '/usr/local/bin/pycharm'] },
      { id: 'webstorm', label: 'WebStorm', icon: 'jetbrains', style: 'jetbrains', cliNames: ['webstorm'], paths: [join(home, '.local', 'bin', 'webstorm'), '/usr/local/bin/webstorm'] },
      { id: 'goland', label: 'GoLand', icon: 'jetbrains', style: 'jetbrains', cliNames: ['goland'], paths: [join(home, '.local', 'bin', 'goland'), '/usr/local/bin/goland'] },
    ];
    for (const spec of linuxEditors) {
      const cmd = firstExisting(spec.paths, exists) || findInPath(spec.cliNames, { platform, env, exists });
      if (cmd) push(editors, { id: spec.id, label: spec.label, kind: 'editor', icon: spec.icon, style: spec.style, command: cmd });
    }
    const linuxTerminals = [
      { id: 'ghostty', label: 'Ghostty', cliNames: ['ghostty'] },
      { id: 'wezterm', label: 'WezTerm', cliNames: ['wezterm'] },
      { id: 'kitty', label: 'Kitty', cliNames: ['kitty'] },
      { id: 'alacritty', label: 'Alacritty', cliNames: ['alacritty'] },
      { id: 'gnome-terminal', label: 'Terminal', cliNames: ['gnome-terminal', 'konsole', 'xfce4-terminal', 'x-terminal-emulator'] },
    ];
    for (const spec of linuxTerminals) {
      const cmd = findInPath(spec.cliNames, { platform, env, exists });
      if (cmd) push(terminals, { id: spec.id, label: spec.label, kind: 'terminal', icon: 'terminal', style: 'terminal-linux', command: cmd });
    }
  }

  const systemItems = [
    { id: 'default', label: 'Default app', kind: 'system', icon: 'default', style: 'default', command: '' },
    { id: 'explorer', label: platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'File Explorer' : 'File Manager', kind: 'system', icon: 'explorer', style: 'explorer', command: '' },
  ];

  return [...editors, ...systemItems, ...terminals];
}

export async function openFileWithApp(
  rawUri,
  appId,
  {
    line = null,
    column = null,
    platform = process.platform,
    env = process.env,
    home = homedir(),
    spawnProcess = spawn,
    execFn = null,
    exists = existsSync,
    readdir = readdirSync,
    stat = statSync,
  } = {}
) {
  const id = String(appId || '').trim();
  if (!id || id === 'default') {
    const res = await openLocalFile(rawUri, { platform, execFn: execFn || execFileAsync });
    return { ...res, appId: 'default', label: 'Default app' };
  }
  if (id === 'explorer') {
    const res = await revealLocalFile(rawUri, { platform, execFn, spawnProcess });
    return { ...res, appId: 'explorer', label: platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'File Explorer' : 'File Manager' };
  }

  const apps = discoverOpenWithApps({ platform, env, home, exists, readdir });
  const app = apps.find((a) => a.id === id);
  if (!app || !app.command) throw new Error('未在本机检测到所选应用');

  const anchor = parseFileUriAnchor(rawUri);
  const targetLine = Number.isInteger(Number(line)) && Number(line) > 0 ? Number(line) : anchor.line;
  const targetCol = Number.isInteger(Number(column)) && Number(column) > 0 ? Number(column) : anchor.column;
  const filePath = resolveLocalFilePath(rawUri, { platform });
  if (!exists(filePath)) throw new Error(`File not found: ${filePath}`);
  let isDir = false;
  try {
    isDir = Boolean(stat(filePath)?.isDirectory?.());
  } catch {}
  const targetDir = isDir ? filePath : dirname(filePath);

  let command = app.command;
  let args = [filePath];
  const spawnOptions = { detached: true, stdio: 'ignore', windowsHide: app.kind !== 'terminal', env };

  if (app.style === 'vscode') {
    args = isDir ? [filePath] : (targetLine ? ['-g', `${filePath}:${targetLine}:${targetCol || 1}`] : [filePath]);
  } else if (app.style === 'zed' || app.style === 'sublime') {
    args = isDir ? [filePath] : [targetLine ? `${filePath}:${targetLine}${targetCol ? `:${targetCol}` : ''}` : filePath];
  } else if (app.style === 'notepadpp') {
    args = isDir ? [filePath] : [...(targetLine ? [`-n${targetLine}`, ...(targetCol ? [`-c${targetCol}`] : [])] : []), filePath];
  } else if (app.style === 'jetbrains') {
    args = isDir ? [filePath] : [...(targetLine ? ['--line', String(targetLine), ...(targetCol ? ['--column', String(targetCol)] : [])] : []), filePath];
  } else if (app.style === 'vs') {
    args = isDir ? [filePath] : ['/Edit', filePath];
  } else if (app.style === 'mac-app') {
    command = 'open';
    args = ['-a', app.command, filePath];
  } else if (app.style === 'terminal-wt') {
    args = ['-d', targetDir];
  } else if (app.style === 'terminal-gitbash') {
    args = [`--cd=${targetDir}`];
  } else if (app.style === 'terminal-wsl') {
    args = ['--cd', targetDir];
  } else if (app.style === 'terminal-mac') {
    command = 'open';
    args = ['-a', app.command, targetDir];
  } else if (app.style === 'terminal-linux') {
    spawnOptions.cwd = targetDir;
    args = [];
  }

  if (platform === 'win32' && /\.cmd$/i.test(command)) {
    if (WIN_CMD_UNSAFE_RE.test(command) || args.some((a) => WIN_CMD_UNSAFE_RE.test(a))) {
      throw new Error('当前文件路径包含 Windows 批处理敏感字符，已拦截 .cmd 启动');
    }
    args = ['/d', '/s', '/c', command, ...args];
    command = env?.ComSpec || 'cmd.exe';
  }

  const child = spawnProcess(command, args, spawnOptions);
  child?.on?.('error', () => {});
  child?.unref?.();
  return { ok: true, path: filePath, appId: app.id, label: app.label, line: targetLine, column: targetCol };
}

export async function dispatchFileAction(action = {}, opts = {}) {
  const type = String(action?.type || '');
  const uri = String(action?.uri || '');
  if (type === 'file.open') return openLocalFile(uri, opts);
  if (type === 'file.openWithList') {
    const apps = discoverOpenWithApps(opts).map(({ id, label, kind, icon }) => ({ id, label, kind, icon }));
    return { ok: true, apps };
  }
  if (type === 'file.openWith') {
    return openFileWithApp(uri, action?.appId, {
      line: action?.line ?? null,
      column: action?.column ?? null,
      ...opts,
    });
  }
  if (type === 'file.reveal') return revealLocalFile(uri, opts);
  if (type === 'file.copy') return copyLocalFileToClipboard(uri, opts);
  if (type === 'file.path') return { ok: true, ...inspectLocalPath(uri) };
  throw new Error(`Unsupported file action: ${type}`);
}
