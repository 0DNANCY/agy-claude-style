@echo off
rem Start the AGY Claude Style (agy-claude-style) background watcher (no console window). Stop it with remove.bat.
start "" /b wscript.exe "%~dp0watch-hidden.vbs"
echo AGY Claude Style (agy-claude-style) watcher started. Log: %~dp0watch.log
timeout /t 2 >nul 2>&1
