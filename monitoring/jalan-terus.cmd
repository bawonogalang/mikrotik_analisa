@echo off
rem Menjalankan web monitoring terus-menerus.
rem Kalau server berhenti/crash, dijalankan ulang 10 detik kemudian.
cd /d "%~dp0"
if not exist logs mkdir logs
set "NODE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
:loop
"%NODE%" "%~dp0server.js" >nul 2>> logs\crash.log
rem kode 3 = monitoring lain sudah jalan di port yang sama
if errorlevel 3 if not errorlevel 4 exit /b
ping -n 11 127.0.0.1 >nul
goto loop
