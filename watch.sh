#!/usr/bin/env bash
# Start the AGY Claude Style (agy-claude-style) background watcher.
cd "$(dirname "$0")"
nohup node inject.js --watch --replace >/dev/null 2>>watch.log </dev/null &
echo "AGY Claude Style (agy-claude-style) watcher started (PID $!)"
