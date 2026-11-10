@echo off
setlocal
title XRegion Playwright E2E Runner
cd /d "%~dp0"
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0tests\e2e\run.ps1" %*
