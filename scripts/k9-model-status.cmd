@echo off
REM K9 model readiness. Model locations come only from config\k9-models.json
REM (see scripts\k9-models.mjs). Pass --json for machine-readable output.
setlocal
title K9 Model Readiness

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is required. Install Node.js 22 or later, then rerun this file.
  exit /b 2
)

node "%~dp0k9-models.mjs" status %*
exit /b %errorlevel%
