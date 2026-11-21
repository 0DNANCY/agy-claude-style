// Stop the background watcher (if running) and remove AGY Claude Style (agy-claude-style) from all Antigravity windows.
const fs = require('fs');
const {
  PID_FILE,
  readPort,
  listPages,
  resolveExistingWatchPidAction,
  CdpSession,
  REMOVE_EXPRESSION,
} = require('./cdp');

function stopWatcherWithResult(opts = {}) {
  const pidFile = opts.pidFile || PID_FILE;
  const targetDir = opts.targetDir || __dirname;
  const killFn = typeof opts.killFn === 'function' ? opts.killFn : (p, sig) => process.kill(p, sig);
  const decision = resolveExistingWatchPidAction(pidFile, targetDir, {
    selfPid: opts.selfPid,
    killFn,
    inspectFn: opts.inspectFn,
    platform: opts.platform,
  });

  if (decision.action === 'write') {
    return { stopped: false, reason: decision.status, pid: decision.pid };
  }
  if (decision.action === 'refuse') {
    console.warn(`[!] 无法验证守护进程归属 (PID ${decision.pid})，出于安全策略拒绝终止或删除锁文件`);
    return { stopped: false, reason: 'unknown', pid: decision.pid };
  }
  if (decision.action === 'clear') {
    try {
      fs.unlinkSync(pidFile);
    } catch {}
    return { stopped: false, reason: decision.status, pid: decision.pid };
  }

  // Only reached for decision.status === 'owned'.
  const pid = decision.pid;
  try {
    killFn(pid);
    console.log(`[✓] 已停止 agy-claude-style 后台守护进程 (PID ${pid})`);
  } catch (err) {
    if (!err || err.code !== 'ESRCH') throw err;
  }
  try {
    fs.unlinkSync(pidFile);
  } catch {}
  return { stopped: true, reason: 'stopped', pid };
}

function stopWatcher(opts = {}) {
  return stopWatcherWithResult(opts).stopped;
}

module.exports = {
  stopWatcher,
  stopWatcherWithResult,
};

if (require.main === module) {
  (async () => {
    const res = stopWatcherWithResult();
    const stopped = res.stopped;
    const port = readPort();
    if (!port) {
      if (!stopped && res.reason !== 'unknown') {
        console.log('[*] 未发现运行中的 agy-claude-style 守护进程或 Antigravity 调试端口');
      }
      return;
    }
    let pages = [];
    try {
      pages = await listPages(port);
    } catch {
      return;
    }
    for (const page of pages) {
      try {
        const session = await CdpSession.connect(page.webSocketDebuggerUrl);
        try {
          const evalRes = await session.evaluate(REMOVE_EXPRESSION);
          console.log(`[✓] 已移除 agy-claude-style: ${page.title || page.url} (清理节点: ${evalRes.removed})`);
        } finally {
          session.close();
        }
      } catch (err) {
        console.warn(`[!] 清理失败: ${page.title || page.url} — ${err.message}`);
      }
    }
  })();
}
