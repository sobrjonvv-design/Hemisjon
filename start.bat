@echo off
setlocal
cd /d "%~dp0"
set "plannerPath=%~dp0server.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/manifest.json' -TimeoutSec 2; if ($r.Content -notmatch 'HEMIS') { exit 1 } } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File ' + [char]34 + $env:plannerPath + [char]34)"
  timeout /t 2 /nobreak >nul
)
start "" "http://127.0.0.1:8080/"
endlocal
