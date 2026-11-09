@echo off
rem Membuat file rekap 7 hari terakhir (sampai kemarin) untuk dashboard Rekap Mingguan.
rem Tanggal akhir lain: buat-rekap.cmd 2026-11-16
cd /d "%~dp0"
set "NODE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
"%NODE%" "%~dp0rekap-mingguan.js" %1
if errorlevel 1 goto selesai
echo.
echo Ganti file di dashboard: buka Sources, pilih "Rekap 7 hari", Replace file,
echo lalu pilih file di atas. Atau minta Claude: "update rekap mingguan".
start "" explorer "%~dp0rekap"
:selesai
echo.
pause
