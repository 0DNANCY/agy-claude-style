import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import * as fileActions from '../sidecars/panel/lib/file-actions.mjs';

const require = createRequire(import.meta.url);
const branchEdit = require('../features/branch-edit.js');
const fileMenu = require('../features/file-menu.js');

test('file-actions resolves file:// URIs and dispatches open/reveal/copy safely', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-fa-'));
  const sampleFile = path.join(tmpDir, 'hello world.txt');
  fs.writeFileSync(sampleFile, 'hi\n', 'utf8');
  try {
    const uri = pathToFileURL(sampleFile).href + '#L10';
    assert.equal(fileActions.resolveLocalFilePath(uri), sampleFile);
    assert.throws(() => fileActions.resolveLocalFilePath('relative/path.txt'));

    const calls = [];
    const mockExec = async (bin, args) => {
      calls.push([bin, args]);
      return { stdout: '', stderr: '' };
    };
    await fileActions.dispatchFileAction({ type: 'file.open', uri }, { platform: 'darwin', execFn: mockExec });
    await fileActions.dispatchFileAction({ type: 'file.reveal', uri }, { platform: 'darwin', execFn: mockExec });
    await fileActions.dispatchFileAction({ type: 'file.copy', uri }, { platform: 'darwin', execFn: mockExec });
    assert.deepEqual(calls[0], ['/usr/bin/open', [sampleFile]]);
    assert.deepEqual(calls[1], ['/usr/bin/open', ['-R', sampleFile]]);
    assert.equal(calls[2][0], '/usr/bin/osascript');
    assert.equal(calls[2][1].at(-1), sampleFile);

    const winCalls = [];
    const mockWinExec = async (bin, args, opts) => {
      winCalls.push({ bin, args, opts });
      return { stdout: '', stderr: '' };
    };
    await fileActions.dispatchFileAction({ type: 'file.open', uri }, { platform: 'win32', execFn: mockWinExec });
    await fileActions.dispatchFileAction({ type: 'file.reveal', uri }, { platform: 'win32', execFn: mockWinExec });
    await fileActions.dispatchFileAction({ type: 'file.copy', uri }, { platform: 'win32', execFn: mockWinExec });
    assert.equal(winCalls[0].bin, 'powershell.exe');
    assert.equal(winCalls[0].opts.windowsHide, true);
    assert.equal(winCalls[0].opts.env.AGY_FILE_PATH, sampleFile);
    assert.ok(winCalls[0].args.includes('Start-Process -FilePath $env:AGY_FILE_PATH'));
    assert.equal(winCalls[1].bin, 'explorer.exe');
    assert.equal(winCalls[1].opts.windowsHide, true);
    assert.equal(winCalls[1].opts.windowsVerbatimArguments, true);
    assert.deepEqual(winCalls[1].args, [`/select,"${sampleFile}"`]);
    assert.equal(winCalls[2].bin, 'powershell.exe');
    assert.equal(winCalls[2].opts.windowsHide, true);
    assert.equal(winCalls[2].opts.env.AGY_FILE_PATH, sampleFile);
    assert.ok(winCalls[2].args.includes('-STA'));
    assert.ok(winCalls[2].args.includes('Set-Clipboard -LiteralPath $env:AGY_FILE_PATH'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ui-branch-edit matches duplicate turns cleanly and preserves multiline prompt text', () => {
  const turns = [
    { stepIndex: 1, text: 'hello' },
    { stepIndex: 5, text: 'line1\n  line2' },
    { stepIndex: 9, text: 'hello' },
  ];
  const dom1 = { tagName: 'DIV', textContent: 'hello 2m ago', childNodes: [] };
  const dom2 = { tagName: 'DIV', textContent: 'line1\n  line2', childNodes: [] };
  const dom3 = { tagName: 'DIV', textContent: 'hello just now', childNodes: [] };
  const matchedLast = branchEdit.matchTurnIndex(turns, [dom1, dom2, dom3], dom3);
  assert.equal(matchedLast.stepIndex, 9);
  const matchedFirst = branchEdit.matchTurnIndex(turns, [dom1, dom2, dom3], dom1);
  assert.equal(matchedFirst.stepIndex, 1);
  assert.equal(branchEdit.preserveText('  a\r\n  b  '), 'a\n  b');
});

test('ui-file-menu decodes file URIs with spaces, percent-encoded Windows drives, and converts Windows paths', () => {
  assert.equal(fileMenu.decodeFileUri('file:///Users/test/my%20file.js#L12-L20'), '/Users/test/my file.js');
  assert.equal(fileMenu.decodeFileUri('file:///C:/repo/a.ts?foo=1'), 'C:/repo/a.ts');
  assert.equal(fileMenu.decodeFileUri('file:///c%3A/repo/my%20file.ts#L5'), 'c:/repo/my file.ts');
  assert.equal(fileMenu.toFileUri('C:\\Users\\dev\\my file.ts'), 'file:///C:/Users/dev/my%20file.ts');
  assert.equal(fileMenu.toFileUri('\\\\server\\share\\notes.md'), 'file://server/share/notes.md');
  assert.equal(fileMenu.toFileUri('/tmp/demo.js'), 'file:///tmp/demo.js');
});

test('file-actions parses line/column anchors and discovers/launches open-with apps with line jump', async () => {
  assert.deepEqual(fileActions.parseFileUriAnchor('file:///C:/repo/app.js#L42:C7'), { line: 42, column: 7 });
  assert.deepEqual(fileActions.parseFileUriAnchor('file:///C:/repo/app.js#L12-L20'), { line: 12, column: null });
  assert.deepEqual(fileActions.parseFileUriAnchor('file:///C:/repo/app.js'), { line: null, column: null });

  const mockEnv = {
    LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    PROGRAMFILES: 'C:\\Program Files',
    SystemRoot: 'C:\\Windows',
    PATH: '',
  };
  const vscodeExe = path.join(mockEnv.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
  const wtExe = path.join(mockEnv.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe');
  const existing = new Set([vscodeExe, wtExe]);
  const apps = fileActions.discoverOpenWithApps({
    platform: 'win32',
    env: mockEnv,
    exists: (p) => existing.has(p),
    readdir: () => [],
  });
  assert.ok(apps.some((a) => a.id === 'vscode' && a.kind === 'editor'));
  assert.ok(apps.some((a) => a.id === 'terminal' && a.kind === 'terminal'));
  assert.ok(apps.some((a) => a.id === 'default' && a.kind === 'system'));
  assert.ok(apps.some((a) => a.id === 'explorer' && a.kind === 'system'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-ow-'));
  const sampleFile = path.join(tmpDir, 'demo.ts');
  fs.writeFileSync(sampleFile, 'export const x = 1;\n', 'utf8');
  try {
    const uri = pathToFileURL(sampleFile).href + '#L18:C4';
    const spawned = [];
    const mockSpawn = (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      return { on() {}, unref() {} };
    };
    const res = await fileActions.dispatchFileAction(
      { type: 'file.openWith', uri, appId: 'vscode' },
      {
        platform: 'win32',
        env: mockEnv,
        exists: (p) => p === sampleFile || existing.has(p),
        readdir: () => [],
        stat: () => ({ isDirectory: () => false }),
        spawnProcess: mockSpawn,
      }
    );
    assert.equal(res.ok, true);
    assert.equal(res.line, 18);
    assert.equal(res.column, 4);
    assert.equal(spawned[0].cmd, vscodeExe);
    assert.deepEqual(spawned[0].args, ['-g', `${sampleFile}:18:4`]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ui-file-menu extracts installed plugin card fiber props and local directory path', () => {
  let toggled = null;
  let uninstalled = false;
  const mockCard = {
    getAttribute(attr) {
      if (attr === 'data-card-name') return 'AGY Claude Style';
      return null;
    },
    closest(sel) {
      if (sel.includes('customizations-installed')) return {};
      if (sel.includes('customization-card')) return mockCard;
      return null;
    },
    querySelector() {
      return { click() {} };
    },
    __reactFiber$test: {
      return: {
        key: 'C:\\Users\\dev\\.gemini\\config\\plugins\\agy-claude-style',
        memoizedProps: {
          name: 'AGY Claude Style',
          action: {
            props: {
              pluginDisabled: false,
              onToggle: (v) => { toggled = v; },
              canUninstall: true,
              onUninstall: () => { uninstalled = true; },
              disabled: false,
            },
          },
        },
        return: null,
      },
    },
  };
  const info = fileMenu.extractCustomizationCardFromTarget(mockCard);
  assert.ok(info);
  assert.equal(info.name, 'AGY Claude Style');
  assert.equal(info.uri, 'file:///C:/Users/dev/.gemini/config/plugins/agy-claude-style');
  assert.equal(info.localPath, 'C:/Users/dev/.gemini/config/plugins/agy-claude-style');
  assert.equal(info.pluginDisabled, false);
  assert.equal(info.canUninstall, true);
  info.onToggle(false);
  info.onUninstall();
  assert.equal(toggled, false);
  assert.equal(uninstalled, true);
});
