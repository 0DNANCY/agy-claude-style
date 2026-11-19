@echo off
rem Launch Antigravity with CDP remote debugging enabled (--remote-debugging-port=0)
rem and start the AGY Claude Style background watcher.
rem Usage: launch.bat [--relaunch]
cd /d "%~dp0"
node "%~dp0inject.js" --launch %*
if errorlevel 1 (
  echo.
  echo [Tip] If Antigravity is already running without CDP, run: launch.bat --relaunch
  pause
  exit /b 1
)
start "" /b wscript.exe "%~dp0watch-hidden.vbs"
echo AGY Claude Style launched with CDP enabled. Log: %~dp0watch.log
timeout /t 2 >nul 2>&1
