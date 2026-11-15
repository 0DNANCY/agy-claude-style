// Stop the background watcher (if running) and remove AGY Claude Style (agy-claude-style) from all Antigravity windows.
const fs = require('fs');
const { PID_FILE, readPort, listPages, CdpSession, REMOVE_EXPRESSION } = require('./cdp');

function stopWatcher() {
  let pid;
  try {
    pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
  } catch {
    return false;
  }
  if (!pid) return false;
  try {
    process.kill(pid);
    console.log(`[✓] 已停止 agy-claude-style 后台守护进程 (PID ${pid})`);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
  return true;
}

(async () => {
  const stopped = stopWatcher();
  const port = readPort();
  if (!port) {
    if (!stopped) console.log('[*] 未发现运行中的 agy-claude-style 守护进程或 Antigravity 调试端口');
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
        const res = await session.evaluate(REMOVE_EXPRESSION);
        console.log(`[✓] 已移除 agy-claude-style: ${page.title || page.url} (清理节点: ${res.removed})`);
      } finally {
        session.close();
      }
    } catch (err) {
      console.warn(`[!] 清理失败: ${page.title || page.url} — ${err.message}`);
    }
  }
})();
