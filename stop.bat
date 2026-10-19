@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -Command "$plannerScript = Join-Path (Get-Location) 'server.ps1'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($plannerScript) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }"
endlocal
