@echo off
REM Starts the local K9 model runtime (services\k9-runtime): detection, tracking,
REM faces, ReID and voice activity. The Python to use and every model path come
REM from config\k9-models.json. Extra arguments go to server.py (e.g. --preload).
setlocal
title K9 Model Runtime

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is required. Install Node.js 22 or later, then rerun this file.
  exit /b 2
)

for /f "delims=" %%P in ('node "%~dp0k9-models.mjs" python') do set "K9_PY=%%P"
if not exist "%K9_PY%" (
  echo [ERROR] The K9 runtime Python was not found: %K9_PY%
  echo Set runtime.python.executable in config\k9-models.json or the K9_PYTHON environment variable.
  exit /b 2
)

"%K9_PY%" "%~dp0..\services\k9-runtime\server.py" %*
exit /b %errorlevel%
