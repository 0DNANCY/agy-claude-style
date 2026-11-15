@echo off
chcp 65001 >nul
rem Inject AGY Claude Style (agy-claude-style) into Antigravity windows once.
echo Injecting AGY Claude Style (agy-claude-style)...
node "%~dp0inject.js"
pause
