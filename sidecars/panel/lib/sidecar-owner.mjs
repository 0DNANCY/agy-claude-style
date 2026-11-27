// Atomic multi-instance ownership & safe file replacement for AGY Claude Style panel sidecar.
// Adapted from agy-context-dashboard's SidecarOwner protocol (MIT):
// - Exclusive lock file (`wx`) with dead-PID stale-lock recovery.
// - Atomic temp-file write + rename with bounded Windows EPERM/EACCES/EBUSY retry.
// - Synchronous hot-path `owns()` guard (zero disk I/O / zero Promise allocation per call).
// - fs.watch + periodic fallback to supersede stale panel sidecars cleanly without killing arbitrary PIDs.

import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch as watchDirectory,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const WIN_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function isValidRecord(rec) {
  return Boolean(
    rec &&
      typeof rec === 'object' &&
      Number.isSafeInteger(rec.pid) &&
      rec.pid > 0 &&
      Number.isFinite(rec.startedAt) &&
      typeof rec.token === 'string' &&
      rec.token.length > 0
  );
}

function isNewer(a, b) {
  return a.startedAt > b.startedAt || (a.startedAt === b.startedAt && a.token > b.token);
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

/**
 * Synchronous atomic text write with unique temp name and Windows EPERM/EACCES/EBUSY retry.
 */
export function atomicWriteFileSync(filePath, content, { mode = 0o600, maxRetryMs = 1000 } = {}) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, content, { flag: 'wx', mode, encoding: 'utf8' });
    const deadline = Date.now() + maxRetryMs;
    for (;;) {
      try {
        renameSync(tmp, filePath);
        break;
      } catch (err) {
        if (!WIN_RETRY_CODES.has(err?.code) || Date.now() >= deadline) throw err;
        sleepSync(20);
      }
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
  return filePath;
}

export class SidecarOwner {
  constructor(
    stateDir,
    {
      fileName = 'active-panel-sidecar.json',
      pid = process.pid,
      startedAt = Math.floor(Date.now() - process.uptime() * 1000),
      token = randomUUID(),
      intervalMs = 2000,
      aliveCheck = isPidAlive,
    } = {}
  ) {
    this.dir = stateDir;
    this.file = join(stateDir, fileName);
    this.pid = pid;
    this.startedAt = startedAt;
    this.token = token;
    this.intervalMs = intervalMs;
    this.aliveCheck = aliveCheck;
    this.running = false;
    this.owned = false;
    this.generation = 0;
    this.checking = null;
    this.watching = null;
    this.watcher = null;
    this.timer = null;
  }

  /** Fast synchronous hot-path guard. */
  owns() {
    return this.running === true && this.owned === true;
  }

  invalidate() {
    this.generation += 1;
    this.owned = false;
    this.checking = null;
  }

  async read() {
    return JSON.parse(await readFile(this.file, 'utf8'));
  }

  async isOwner() {
    if (!this.running) return false;
    if (this.checking) return this.checking;
    const gen = this.generation;
    const checking = (async () => {
      let owned = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const cur = await this.read();
          owned = Boolean(isValidRecord(cur) && cur.pid === this.pid && cur.token === this.token);
          break;
        } catch (err) {
          const code = String(err?.code || '');
          const retryable = err instanceof SyntaxError || code === 'EBUSY' || code === 'EACCES' || code === 'EPERM' || code === 'ENOENT';
          if (!retryable || attempt === 2) break;
          await new Promise((r) => setTimeout(r, 25));
          if (!this.running || gen !== this.generation) return false;
        }
      }
      if (!this.running || gen !== this.generation) return false;
      this.owned = owned;
      return owned;
    })();
    this.checking = checking;
    try {
      return await checking;
    } finally {
      if (this.checking === checking) this.checking = null;
    }
  }

  async claim() {
    this.stop();
    mkdirSync(this.dir, { recursive: true });
    const lockFile = `${this.file}.lock`;
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        writeFileSync(lockFile, JSON.stringify({ pid: this.pid, token: this.token }), { flag: 'wx', mode: 0o600 });
        break;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        try {
          let holder = null;
          try {
            holder = JSON.parse(readFileSync(lockFile, 'utf8'));
          } catch {}
          const dead = holder?.pid ? !this.aliveCheck(holder.pid) : Date.now() - statSync(lockFile).mtimeMs > 10000;
          if (dead) {
            unlinkSync(lockFile);
            continue;
          }
        } catch (inner) {
          if (inner?.code === 'ENOENT') continue;
          throw inner;
        }
        if (Date.now() > deadline) throw new Error('Sidecar ownership claim timed out');
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    const tmp = `${this.file}.${this.token.slice(0, 8)}.tmp`;
    try {
      const record = { pid: this.pid, startedAt: this.startedAt, token: this.token };
      try {
        const prior = JSON.parse(readFileSync(this.file, 'utf8'));
        if (isValidRecord(prior) && isNewer(prior, record) && this.aliveCheck(prior.pid)) {
          return false;
        }
      } catch (err) {
        if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
      }
      writeFileSync(tmp, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
      const replaceDeadline = Date.now() + 1000;
      for (;;) {
        try {
          renameSync(tmp, this.file);
          break;
        } catch (err) {
          if (!WIN_RETRY_CODES.has(err?.code) || Date.now() >= replaceDeadline) throw err;
          await new Promise((r) => setTimeout(r, 20));
        }
      }
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
      try {
        if (JSON.parse(readFileSync(lockFile, 'utf8')).token === this.token) unlinkSync(lockFile);
      } catch {}
    }

    this.running = true;
    return this.isOwner();
  }

  watch(onLost) {
    clearInterval(this.timer);
    this.watcher?.close();
    const sym = Symbol('sidecar-owner-watch');
    this.watching = sym;
    let inFlight = false;
    const check = async () => {
      if (inFlight || !this.running || this.watching !== sym) return;
      inFlight = true;
      try {
        while (this.running && this.watching === sym) {
          const gen = this.generation;
          const owned = await this.isOwner();
          if (!this.running || this.watching !== sym) return;
          if (gen !== this.generation) continue;
          if (!owned) {
            this.stop();
            await onLost?.();
          }
          return;
        }
      } finally {
        inFlight = false;
      }
    };
    const run = () => {
      void check().catch(() => this.stop());
    };
    const changed = () => {
      if (this.watching !== sym) return;
      this.invalidate();
      run();
    };
    try {
      this.watcher = watchDirectory(this.dir, (_event, file) => {
        if (file === null || String(file) === basename(this.file)) changed();
      });
      this.watcher.unref?.();
      this.watcher.on('error', () => {
        if (this.watching !== sym) return;
        this.watcher?.close();
        this.watcher = null;
        changed();
      });
    } catch {}
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref?.();
    run();
  }

  stop() {
    this.running = false;
    this.watching = null;
    this.invalidate();
    clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
