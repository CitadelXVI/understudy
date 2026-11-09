@echo off
rem Stop Understudy and the kmd-generate worker it started (the process that
rem holds the models in VRAM).  Other kmd-generate processes are left alone.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$servers = @(Get-Process understudy -ErrorAction SilentlyContinue);" ^
  "if ($servers.Count -eq 0) { Write-Host 'Understudy is not running.'; exit 0 };" ^
  "foreach ($server in $servers) {" ^
  "  Get-CimInstance Win32_Process -Filter ('Name=''kmd-generate.exe'' AND ParentProcessId=' + $server.Id) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };" ^
  "  Stop-Process -Id $server.Id -Force" ^
  "};" ^
  "Write-Host ('Stopped Understudy (PID ' + ($servers.Id -join ', ') + ').')"
