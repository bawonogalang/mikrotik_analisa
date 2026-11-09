@echo off
rem Menghentikan web monitoring + tunnel SSH-nya (akan jalan lagi saat PC hidup atau login berikutnya).
rem Monitoring berjalan di luar sesi login, jadi hanya Administrator yang bisa melihat prosesnya.
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'" & exit /b)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*jalan-terus.cmd*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*MonitorTernate*server.js*') -or ($_.Name -eq 'ssh.exe' -and $_.CommandLine -like '*mt_ternate_webmon*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Monitoring dihentikan. Jalankan mulai-monitor.vbs untuk menyalakan lagi.
pause
