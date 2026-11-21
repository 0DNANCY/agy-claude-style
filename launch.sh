#!/usr/bin/env bash
# Launch Antigravity with CDP remote debugging enabled (--remote-debugging-port=0)
# and start the AGY Claude Style watcher (managed exit-on-close by default, or --daemon).
# Usage: ./launch.sh [--relaunch] [--daemon]
set -euo pipefail
cd "$(dirname "$0")"

DAEMON=0
LAUNCH_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--daemon" ]; then
    DAEMON=1
  else
    LAUNCH_ARGS+=("$arg")
  fi
done

if [ ${#LAUNCH_ARGS[@]} -gt 0 ]; then
  node inject.js --launch "${LAUNCH_ARGS[@]}"
else
  node inject.js --launch
fi

if [ "$DAEMON" = "1" ]; then
  nohup node inject.js --watch --replace >/dev/null 2>>watch.log </dev/null &
  echo "[✓] AGY Claude Style daemon watcher started (PID $!)"
  exit 0
fi

# Managed mode (default): start watcher with --exit-on-host-close if no live watcher PID exists
if [ -f .watch.pid ]; then
  PID="$(cat .watch.pid 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "[*] AGY Claude Style watcher is already running (PID $PID)"
    exit 0
  fi
fi

nohup node inject.js --watch --exit-on-host-close >/dev/null 2>>watch.log </dev/null &
echo "[✓] AGY Claude Style managed watcher started (PID $!)"
