import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createWallpaperStore } from '../sidecars/panel/lib/wallpaper-store.mjs';

const require = createRequire(import.meta.url);
const cdp = require('../cdp.js');
const themeEngine = require('../features/theme-engine.js');
const wpServer = require('../wallpaper-server.js');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const MP4_MAGIC = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x01, 0x02, 0x03, 0x04]);
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const GIF_MAGIC = Buffer.from('GIF89a\x01\x00\x01\x00', 'ascii');
const WEBP_MAGIC = Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'ascii');
const JPG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

test('cdp.js validates all new palettes, customTheme hex tokens, wallpaper settings, and keeps refresh < 2048 chars', () => {
  for (const p of ['obsidian', 'claude', 'nord', 'catppuccin', 'rosepine', 'tokyo', 'dracula', 'emerald', 'custom', 'host']) {
    assert.equal(cdp.validateConfigSetting('palette', p), true, `Expected valid palette ${p}`);
  }
  assert.equal(cdp.validateConfigSetting('palette', 'bad-theme'), false);

  assert.equal(
    cdp.validateConfigSetting('customTheme', {
      base: 'tokyo',
      mode: 'dark',
      accent: '#ff66aa',
      canvas: '#10121a',
      sidebar: '#0d0f15',
      composer: '#161925',
      bubble: '#22273a',
      fg: '#f5f7ff',
      mutedFg: '#8c94b0',
      border: '#272c3f',
    }),
    true
  );

  // Reject CSS injection attempts, non-hex colors, arrays, and unknown keys
  assert.equal(cdp.validateConfigSetting('customTheme', { accent: '#fff; body{display:none}' }), false);
  assert.equal(cdp.validateConfigSetting('customTheme', { accent: 'red' }), false);
  assert.equal(cdp.validateConfigSetting('customTheme', { unknownKey: '#112233' }), false);
  assert.equal(cdp.validateConfigSetting('customTheme', ['#112233']), false);

  assert.equal(cdp.validateConfigSetting('wpMode', 'global'), true);
  assert.equal(cdp.validateConfigSetting('wpMode', 'home'), true);
  assert.equal(cdp.validateConfigSetting('wpMode', 'off'), true);
  assert.equal(cdp.validateConfigSetting('wpMode', 'fullscreen'), false);

  assert.equal(cdp.validateConfigSetting('wpFile', 'wp-abc123-demo.mp4'), true);
  assert.equal(cdp.validateConfigSetting('wpFile', '../secret.mp4'), false);
  assert.equal(cdp.validateConfigSetting('wpFile', 'sub/demo.mp4'), false);

  assert.equal(cdp.validateConfigSetting('wpOpacity', 50), true);
  assert.equal(cdp.validateConfigSetting('wpOpacity', 200), false);
  assert.equal(cdp.validateConfigSetting('wpBlur', 16), true);
  assert.equal(cdp.validateConfigSetting('wpDim', -20), true);
  assert.equal(cdp.validateConfigSetting('wpSurfaceAlpha', 72), true);
  assert.equal(cdp.validateConfigSetting('wpRate', 125), true);
  assert.equal(cdp.validateConfigSetting('wpPauseBlur', false), true);

  const hash = cdp.computeHash(cdp.readRuntimeBundle());
  const defaultRefresh = cdp.buildRefreshExpression(cdp.DEFAULT_CONFIG, hash);
  assert.ok(defaultRefresh.length < 2048, `Default refresh payload too large: ${defaultRefresh.length}`);

  const populatedRefresh = cdp.buildRefreshExpression(
    {
      ...cdp.DEFAULT_CONFIG,
      palette: 'custom',
      customTheme: {
        base: 'catppuccin',
        mode: 'dark',
        accent: '#cba6f7',
        canvas: '#1e1e2e',
        sidebar: '#181825',
        composer: '#11111b',
        bubble: '#313244',
        fg: '#cdd6f4',
        mutedFg: '#a6adc8',
        border: '#313244',
      },
      wpMode: 'global',
      wpFile: 'wp-sample-loop.mp4',
      wpOpacity: 42,
      wpBlur: 8,
      wpDim: 30,
      wpSurfaceAlpha: 72,
      wpRate: 110,
      wpPauseBlur: true,
    },
    hash
  );
  assert.ok(populatedRefresh.length < 2048, `Populated refresh payload exceeded 2KB: ${populatedRefresh.length}`);
});

test('theme-engine builds valid CSS variables for presets and custom tokens', () => {
  const nordCss = themeEngine.buildThemeCss('nord', {}, true);
  assert.ok(nordCss.includes('--primary: #88c0d0 !important;'));
  assert.ok(nordCss.includes('--ag-cs-canvas: #242933;'));

  const customCss = themeEngine.buildThemeCss(
    'custom',
    { base: 'tokyo', mode: 'light', accent: '#ff3366', canvas: '#fefefe', fg: '#111111' },
    false
  );
  assert.ok(customCss.includes('color-scheme: light !important;'));
  assert.ok(customCss.includes('--primary: #ff3366 !important;'));
  assert.ok(customCss.includes('--ag-cs-canvas: #fefefe;'));
  assert.ok(customCss.includes('--foreground: #111111 !important;'));
  assert.equal(themeEngine.buildThemeCss('obsidian', {}, true), '');
  assert.equal(themeEngine.buildThemeCss('host', {}, true), '');
});

test('wallpaper-server validates magic bytes and serves HTTP 206 Range streams with token auth', async () => {
  assert.equal(wpServer.detectWallpaperMedia(MP4_MAGIC, '.mp4').kind, 'video');
  assert.equal(wpServer.detectWallpaperMedia(WEBM_MAGIC, '.webm').kind, 'video');
  assert.equal(wpServer.detectWallpaperMedia(GIF_MAGIC, '.gif').kind, 'image');
  assert.equal(wpServer.detectWallpaperMedia(WEBP_MAGIC, '.webp').kind, 'image');
  assert.equal(wpServer.detectWallpaperMedia(PNG_MAGIC, '.png').kind, 'image');
  assert.equal(wpServer.detectWallpaperMedia(JPG_MAGIC, '.jpg').kind, 'image');

  // Spoofed extension must fail
  assert.equal(wpServer.detectWallpaperMedia(Buffer.from('<html>not a video</html>'), '.mp4').ok, false);
  assert.equal(wpServer.detectWallpaperMedia(PNG_MAGIC, '.mp4').ok, false);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-wp-srv-'));
  const srv = wpServer.createWallpaperMediaServer({ wallpapersDir: tmpDir });
  try {
    const payload = Buffer.concat([MP4_MAGIC, Buffer.alloc(4096, 0x41)]);
    fs.writeFileSync(path.join(tmpDir, 'wp-demo.mp4'), payload);
    const info = await srv.ensureStarted();
    const meta = srv.resolveActiveMeta('wp-demo.mp4');
    assert.ok(meta.httpUrl.startsWith(`http://127.0.0.1:${info.port}/ag-cs-wp/${info.token}/`));
    assert.equal(meta.kind, 'video');

    const forbidden = await fetch(`http://127.0.0.1:${info.port}/ag-cs-wp/wrongtoken/wp-demo.mp4`);
    assert.equal(forbidden.status, 403);

    const partial = await fetch(meta.httpUrl, { headers: { Range: 'bytes=0-15' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 0-15/${payload.length}`);
    const bodyBuf = Buffer.from(await partial.arrayBuffer());
    assert.deepEqual(bodyBuf, payload.subarray(0, 16));
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('wallpaper-store supports chunked upload, path import, listing, and deletion', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-wp-store-'));
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-wp-src-'));
  try {
    const store = createWallpaperStore({ wallpapersDir: tmpDir });
    const fullVideo = Buffer.concat([MP4_MAGIC, Buffer.alloc(1024, 0x55)]);
    const half = Math.floor(fullVideo.length / 2);

    const r1 = store.uploadChunk({
      uploadId: 'up_test_01',
      index: 0,
      total: 2,
      fileName: 'loop video.mp4',
      chunkBase64: fullVideo.subarray(0, half).toString('base64'),
    });
    assert.equal(r1.done, false);

    const r2 = store.uploadChunk({
      uploadId: 'up_test_01',
      index: 1,
      total: 2,
      fileName: 'loop video.mp4',
      chunkBase64: fullVideo.subarray(half).toString('base64'),
    });
    assert.equal(r2.done, true);
    assert.equal(r2.item.kind, 'video');
    assert.equal(fs.readFileSync(path.join(tmpDir, r2.item.name)).equals(fullVideo), true);

    const extPng = path.join(srcDir, 'bg.png');
    fs.writeFileSync(extPng, PNG_MAGIC);
    const imp = store.importFromPath(extPng);
    assert.equal(imp.item.kind, 'image');

    assert.throws(() => store.uploadChunk({
      uploadId: 'up_bad_01',
      index: 0,
      total: 1,
      fileName: 'evil.mp4',
      chunkBase64: Buffer.from('alert(1)').toString('base64'),
    }));

    const items = store.list();
    assert.equal(items.length, 2);

    const del = store.remove(r2.item.name);
    assert.equal(del.deleted, true);
    assert.equal(store.list().length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
});

test('wallpaper feature mounts global/home scopes, pauses video on blur, resumes on focus, and cleans up on destroy', () => {
  const src = fs.readFileSync(new URL('../features/wallpaper.js', import.meta.url), 'utf8');
  const docListeners = new Map();
  const winListeners = new Map();

  function makeEl(tag) {
    const attrs = new Map();
    const children = [];
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      attributes: attrs,
      children,
      get firstChild() { return children[0] || null; },
      parentElement: null,
      isConnected: true,
      paused: true,
      muted: false,
      loop: false,
      playsInline: false,
      autoplay: false,
      playbackRate: 1,
      src: '',
      style: {
        _p: {},
        setProperty(k, v) { this._p[k] = String(v); },
        removeProperty(k) { delete this._p[k]; },
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) { attrs.delete(k); },
      appendChild(c) { c.parentElement = this; children.push(c); return c; },
      insertBefore(c, ref) {
        c.parentElement = this;
        const idx = ref ? children.indexOf(ref) : -1;
        if (idx >= 0) children.splice(idx, 0, c);
        else children.push(c);
        return c;
      },
      removeChild(c) {
        const i = children.indexOf(c);
        if (i >= 0) children.splice(i, 1);
        c.parentElement = null;
        return c;
      },
      remove() { if (this.parentElement) this.parentElement.removeChild(this); },
      play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; },
      load() {},
    };
    return el;
  }

  const html = makeEl('html');
  const body = makeEl('body');
  const home = makeEl('div');
  home.className = 'agy-home';
  body.appendChild(home);
  html.appendChild(body);

  let focused = true;
  let hidden = false;

  const sandbox = {
    URL: { revokeObjectURL() {} },
    location: { protocol: 'http:' },
    document: {
      documentElement: html,
      body,
      get hidden() { return hidden; },
      hasFocus: () => focused,
      createElement: (t) => makeEl(t),
      querySelector: (s) => (s === '.agy-home' ? home : null),
      addEventListener: (ev, cb) => docListeners.set(ev, cb),
      removeEventListener: (ev) => docListeners.delete(ev),
    },
    window: {
      matchMedia: () => ({ matches: false }),
      addEventListener: (ev, cb) => winListeners.set(ev, cb),
      removeEventListener: (ev) => winListeners.delete(ev),
    },
    globalThis: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox);

  const cfg = {
    wpMode: 'global',
    wpFile: 'wp-demo.mp4',
    wpOpacity: 40,
    wpBlur: 6,
    wpDim: 20,
    wpSurfaceAlpha: 72,
    wpRate: 150,
    wpPauseBlur: true,
  };
  sandbox.globalThis.__agCsWallpaperMeta = {
    file: 'wp-demo.mp4',
    kind: 'video',
    mime: 'video/mp4',
    mtimeMs: 123,
    httpUrl: 'http://127.0.0.1:45678/ag-cs-wp/tok/wp-demo.mp4',
  };

  const inst = sandbox.globalThis.__agCsFeatures.wallpaper.create({
    getCfg: () => cfg,
    isDestroyed: () => false,
  });

  inst.sync();
  assert.equal(html.getAttribute('data-ag-cs-wp'), 'global');
  assert.equal(html.style._p['--ag-cs-wp-surface-alpha'], '72%');
  assert.equal(body.children[0].className, 'ag-cs-wallpaper-host');
  const videoEl = body.children[0].children[0];
  assert.equal(videoEl.tagName, 'VIDEO');
  assert.equal(videoEl.paused, false);
  assert.equal(videoEl.playbackRate, 1.5);

  // Blur pauses video
  focused = false;
  winListeners.get('blur')();
  assert.equal(videoEl.paused, true);

  // Focus resumes video
  focused = true;
  winListeners.get('focus')();
  assert.equal(videoEl.paused, false);

  // Switch to home scope
  cfg.wpMode = 'home';
  inst.sync();
  assert.equal(html.getAttribute('data-ag-cs-wp'), 'home');
  assert.equal(home.children[0].className, 'ag-cs-wallpaper-host');

  // Destroy cleans DOM & attributes
  inst.destroy();
  assert.equal(html.hasAttribute('data-ag-cs-wp'), false);
  assert.equal(home.children.length, 0);
});
