import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const cdp = require(path.join(ROOT_DIR, 'cdp.js'));

function createMockCdpServer() {
  const sockets = new Set();
  let injectCount = 0;

  function encodeWsTextFrame(str) {
    const payload = Buffer.from(str, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const addr = server.address();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'PAGE_MOCK',
            type: 'page',
            title: 'Antigravity Mock',
            url: 'https://127.0.0.1:9999/',
            webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/page/PAGE_MOCK`,
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));

    let buf = Buffer.alloc(0);
    let fragChunks = [];
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (buf.length < 4) return;
          payloadLen = buf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buf.length < 10) return;
          payloadLen = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + payloadLen) return;
        let payload = buf.subarray(offset + maskLen, offset + maskLen + payloadLen);
        if (masked) {
          const mask = buf.subarray(offset, offset + 4);
          const unmasked = Buffer.allocUnsafe(payloadLen);
          for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ mask[i & 3];
          payload = unmasked;
        }
        buf = buf.subarray(offset + maskLen + payloadLen);
        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode === 0x1 || opcode === 0x0) {
          fragChunks.push(payload);
          if (fin) {
            const text = Buffer.concat(fragChunks).toString('utf8');
            fragChunks = [];
            try {
              const msg = JSON.parse(text);
              let result = {};
              if (msg.method === 'Page.addScriptToEvaluateOnNewDocument') {
                result = { identifier: 'script-1' };
              } else if (msg.method === 'Runtime.evaluate') {
                injectCount++;
                result = { result: { type: 'object', value: { version: cdp.PLUGIN_VERSION, status: 'ok' } } };
              }
              if (!socket.destroyed) {
                socket.write(encodeWsTextFrame(JSON.stringify({ id: msg.id, result })));
              }
            } catch {}
          }
        }
      }
    });
  });

  return {
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    getInjectCount() {
      return injectCount;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function stageTempRuntimeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-watcher-test-'));
  const files = [
    'cdp.js',
    'inject.js',
    'style.css',
    'config.example.json',
    ...cdp.RUNTIME_PARTS,
  ];
  for (const f of files) {
    fs.copyFileSync(path.join(ROOT_DIR, f), path.join(dir, f));
  }
  return dir;
}

async function waitFor(fn, timeoutMs = 12000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

test('formatCdpUnavailableMessage clearly distinguishes Antigravity 2.33.0+ running without CDP vs not running', () => {
  const runningNoPort = cdp.formatCdpUnavailableMessage({ running: true, port: null });
  assert.match(runningNoPort, /2\.33\.0/);
  assert.match(runningNoPort, /--remote-debugging-port=0/);

  const runningDeadPort = cdp.formatCdpUnavailableMessage({ running: true, port: 9222 });
  assert.match(runningDeadPort, /9222/);
  assert.match(runningDeadPort, /2\.33\.0/);

  const stopped = cdp.formatCdpUnavailableMessage({ running: false, port: null });
  assert.match(stopped, /未运行/);
  assert.match(stopped, /--remote-debugging-port=0/);
});

test('inject.js --watch --exit-on-host-close exits cleanly and removes .watch.pid after CDP host closes', async () => {
  const dir = stageTempRuntimeDir();
  const mock = createMockCdpServer();
  let child = null;
  try {
    const port = await mock.start();
    child = spawn(process.execPath, [path.join(dir, 'inject.js'), '--watch', '--exit-on-host-close'], {
      cwd: dir,
      env: { ...process.env, AG_CDP_PORT: String(port) },
      stdio: 'ignore',
    });

    const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

    await waitFor(() => mock.getInjectCount() >= 1, 6000);
    assert.ok(fs.existsSync(path.join(dir, '.watch.pid')), '.watch.pid created while watching');

    // Simulate Antigravity closing while port file/env still points to the old dead port
    await mock.close();

    const exitCode = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Watcher did not exit after host closed')), 12000)),
    ]);
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(path.join(dir, '.watch.pid')), false, '.watch.pid cleaned up on exit');
  } finally {
    if (child && child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
    try { await mock.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inject.js --watch --parent-pid exits cleanly when parent process is gone', async () => {
  const dir = stageTempRuntimeDir();
  let child = null;
  try {
    // Spawn a short-lived dummy parent process and immediately wait for it to exit
    const dummy = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = dummy.pid;
    await new Promise((resolve) => dummy.on('exit', resolve));

    child = spawn(
      process.execPath,
      [path.join(dir, 'inject.js'), '--watch', '--parent-pid', String(deadPid)],
      {
        cwd: dir,
        env: { ...process.env, AG_CDP_PORT: '1' },
        stdio: 'ignore',
      }
    );
    const exitCode = await Promise.race([
      new Promise((resolve) => child.on('exit', (code) => resolve(code))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Watcher did not exit when parent PID died')), 6000)),
    ]);
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(path.join(dir, '.watch.pid')), false, '.watch.pid cleaned up on parent exit');
  } finally {
    if (child && child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('relaunchAntigravityWithCdp verifies executable before terminating and preserves resolved running path', async () => {
  let terminateCalled = 0;
  let launchedWith = null;

  // Missing executable must NOT terminate the running process
  const missingRes = await cdp.relaunchAntigravityWithCdp({
    detectProcess: () => ({ running: true, pids: [4242] }),
    resolveRunningPath: () => null,
    findExecutable: () => null,
    terminate: () => {
      terminateCalled++;
    },
    launch: (opts) => {
      launchedWith = opts;
      return true;
    },
  });
  assert.deepEqual(missingRes, { relaunched: false, reason: 'executable-not-found' });
  assert.equal(terminateCalled, 0, 'Must not terminate running process when executable cannot be resolved');
  assert.equal(launchedWith, null);

  // When running executable path is resolved, terminate first then launch with that exact path
  let running = true;
  const okRes = await cdp.relaunchAntigravityWithCdp({
    port: 0,
    waitMs: 1000,
    detectProcess: () => ({ running, pids: running ? [5151] : [] }),
    resolveRunningPath: (pids) => (pids.includes(5151) ? '/custom/path/Antigravity' : null),
    findExecutable: () => null,
    terminate: (pids) => {
      terminateCalled++;
      assert.deepEqual(pids, [5151]);
      running = false;
    },
    launch: (opts) => {
      launchedWith = opts;
      return true;
    },
  });
  assert.deepEqual(okRes, { relaunched: true, reason: 'ok' });
  assert.equal(terminateCalled, 1);
  assert.equal(launchedWith.appPath, '/custom/path/Antigravity');
});

test('hasRemoteDebuggingFlag detects --remote-debugging-port on running processes', async () => {
  assert.equal(cdp.hasRemoteDebuggingFlag([]), false);
  if (process.platform === 'win32') return;

  const withFlag = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', '--', '--remote-debugging-port=0'], {
    stdio: 'ignore',
  });
  const withoutFlag = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    stdio: 'ignore',
  });
  try {
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(cdp.hasRemoteDebuggingFlag([withFlag.pid]), true);
    assert.equal(cdp.hasRemoteDebuggingFlag([withoutFlag.pid]), false);
  } finally {
    try { withFlag.kill('SIGKILL'); } catch {}
    try { withoutFlag.kill('SIGKILL'); } catch {}
  }
});
