@echo off
rem Menjalankan ulang monitoring, mis. setelah mengubah routers.json atau memperbarui program.
rem Monitoring berjalan di luar sesi login, jadi perlu izin Administrator.
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'" & exit /b)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*jalan-terus.cmd*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*MonitorTernate*server.js*') -or ($_.Name -eq 'ssh.exe' -and $_.CommandLine -like '*mt_ternate_webmon*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
timeout /t 3 /nobreak >nul
schtasks /Query /TN "Monitor WiFi Ternate" >nul 2>&1 && (schtasks /Run /TN "Monitor WiFi Ternate" >nul & echo Monitoring dijalankan ulang lewat Scheduled Task.) || (start "" wscript "%~dp0mulai-monitor.vbs" & echo Monitoring dijalankan ulang.)
echo Menunggu router tersambung...
timeout /t 12 /nobreak >nul
powershell -NoProfile -Command "try { (Invoke-RestMethod http://127.0.0.1:8090/api/routers -TimeoutSec 10).routers | ForEach-Object { '{0,-24} {1}' -f $_.name, $(if ($_.ok) { 'terhubung' } else { 'belum terhubung (tunggu sebentar)' }) } } catch { 'Server belum menjawab, buka dashboard sebentar lagi.' }"
echo.
pause
