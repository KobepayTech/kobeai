@echo off
setlocal EnableExtensions EnableDelayedExpansion
title K9 ALL AI MODELS - EXCEPT QWEN

REM Every model, its location and its source come from config\k9-models.json.
REM This file only prepares the tools; scripts\k9-models.mjs does the work.

echo.
echo =====================================================================
echo   K9 - DOWNLOAD ALL AI MODELS WE NEED
echo   QWEN IS EXPLICITLY EXCLUDED
echo =====================================================================
echo.
echo This downloader:
echo   - reads every model location from config\k9-models.json
echo   - aligns the folders under the K9 models root with the registry
echo   - skips completed models and resumes partial Hugging Face downloads
echo   - reuses existing KobeOS weights with hard links
echo.
echo Qwen folders/files are NOT downloaded, moved, deleted, or modified.
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [MISSING] Node.js. Install Node.js 22 or later, then run this file again.
    pause
    exit /b 1
)
echo [OK] Node.js

where py >nul 2>&1
if errorlevel 1 (
    echo [MISSING] Python launcher.
    echo Installing Python 3.12 with winget...
    winget install -e --id Python.Python.3.12
    echo CLOSE this CMD window, open a new CMD, and run this file again.
    pause
    exit /b 1
)
echo [OK] Python
py --version

where git >nul 2>&1
if errorlevel 1 (
    echo [INSTALL] Git
    winget install -e --id Git.Git
    set "PATH=%PATH%;C:\Program Files\Git\cmd"
)
where git >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git is installed but not visible yet.
    echo Close CMD, reopen it, and rerun this file.
    pause
    exit /b 1
)
echo [OK] Git
git --version

echo.
echo [SETUP] Hugging Face CLI / Xet / gdown
py -m pip install --upgrade pip
py -m pip install --upgrade huggingface_hub hf_xet gdown
for /f "delims=" %%S in ('py -c "import sysconfig; print(sysconfig.get_path('scripts'))"') do set "PY_SCRIPTS=%%S"
set "PATH=%PATH%;%PY_SCRIPTS%"
set "HF_EXE=%PY_SCRIPTS%\hf.exe"
if not exist "%HF_EXE%" (
    where hf >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] hf.exe was not found.
        echo Python Scripts folder: %PY_SCRIPTS%
        pause
        exit /b 1
    )
    set "HF_EXE=hf"
)
echo [OK] Hugging Face CLI
"%HF_EXE%" --version

set "K9MODELS=node "%~dp0k9-models.mjs""
for /f "delims=" %%R in ('node "%~dp0k9-models.mjs" root') do set "ROOT=%%R"
echo.
echo K9 models root: %ROOT%

echo.
echo =====================================================================
echo   ALIGN FOLDERS WITH config\k9-models.json
echo =====================================================================
%K9MODELS% layout --apply

echo.
echo =====================================================================
echo   DOWNLOAD MISSING MODELS
echo =====================================================================
%K9MODELS% download

echo.
echo =====================================================================
echo   CONNECT TEXT MODELS TO OLLAMA
echo =====================================================================
%K9MODELS% ollama-sync

echo.
echo =====================================================================
echo   READINESS
echo =====================================================================
%K9MODELS% status
tree "%ROOT%" /F > "%ROOT%\k9_model_tree.txt"
echo.
echo Tree: %ROOT%\k9_model_tree.txt
echo.
echo If pyannote is listed as failed/gated, accept both model access pages,
echo run: "%HF_EXE%" auth login
echo then run this CMD file again.
echo.
echo Re-running is safe: completed models are skipped and partial HF downloads resume.
pause
exit /b 0
