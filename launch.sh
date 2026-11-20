#!/usr/bin/env bash
# Launch Antigravity with CDP remote debugging enabled (--remote-debugging-port=0)
# and start the AGY Claude Style watcher if not already running.
# Usage: ./launch.sh [--relaunch]
set -euo pipefail
cd "$(dirname "$0")"

node inject.js --launch "$@"

# Start watcher if no live watcher PID exists
if [ -f .watch.pid ]; then
  PID="$(cat .watch.pid 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "[*] AGY Claude Style watcher is already running (PID $PID)"
    exit 0
  fi
fi

nohup node inject.js --watch --replace >/dev/null 2>>watch.log </dev/null &
echo "[✓] AGY Claude Style watcher started (PID $!)"
