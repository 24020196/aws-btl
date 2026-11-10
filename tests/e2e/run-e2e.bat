@echo off
setlocal
title XRegion Playwright E2E Runner
cd /d "%~dp0"
call "%~dp0run.bat" %*
