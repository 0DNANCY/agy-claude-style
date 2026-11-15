@echo off
rem Disable Windows Startup autostart for AGY Claude Style (agy-claude-style).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = [Environment]::GetFolderPath('Startup'); $hit = $false;" ^
  "foreach ($n in @('AGY-Claude-Style.lnk', 'Antigravity Claude Style.lnk')) { $p = Join-Path $s $n; if (Test-Path $p) { Remove-Item $p -Force; Write-Host ('Autostart disabled: ' + $p); $hit = $true } }" ^
  "if (-not $hit) { Write-Host 'AGY Claude Style (agy-claude-style) autostart shortcut not found.' }"
pause
