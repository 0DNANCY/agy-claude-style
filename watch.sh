#!/usr/bin/env bash
# Start the AGY Claude Style (agy-claude-style) background watcher.
cd "$(dirname "$0")"
nohup node inject.js --watch --replace > watch.log 2>&1 </dev/null &
echo "AGY Claude Style (agy-claude-style) watcher started (PID $!)"
