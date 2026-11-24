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
    assert.equal(winCalls[1].bin, 'powershell.exe');
    assert.equal(winCalls[1].opts.windowsHide, true);
    assert.equal(winCalls[1].opts.env.AGY_FILE_PATH, sampleFile);
    assert.ok(winCalls[1].args.some((a) => a.includes('explorer.exe') && a.includes('/select,')));
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
