@echo off
chcp 65001 >nul
rem Stop the AGY Claude Style (agy-claude-style) watcher and restore Antigravity UI.
echo Removing AGY Claude Style (agy-claude-style)...
node "%~dp0remove.js"
pause
