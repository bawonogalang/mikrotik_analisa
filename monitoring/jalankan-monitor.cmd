@echo off
title Web Monitoring MikroTik Ternate
cd /d "%~dp0"
echo Buka http://localhost:8090 di browser.
node server.js %*
pause
