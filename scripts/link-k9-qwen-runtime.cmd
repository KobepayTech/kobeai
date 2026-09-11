@echo off
setlocal EnableExtensions

title K9 Qwen Runtime Link
set "SOURCE=C:\KobeOS\Models\qwen.gguf"
set "DESTDIR=C:\KobeOS\Models\k9\brain\existing"
set "DEST=%DESTDIR%\qwen.gguf"

echo.
echo ==============================================================
echo   K9 QWEN RUNTIME LINK
echo ==============================================================
echo Source:      %SOURCE%
echo Runtime path: %DEST%
echo.

echo This does NOT download, copy, move, replace, or delete Qwen.
echo It creates a zero-copy NTFS hard link so the K9 runtime can see
necho the existing Qwen through its canonical model-root path.
echo.

if exist "%DEST%" (
    echo [READY] Runtime Qwen path already exists.
    dir "%DEST%"
    exit /b 0
)

if not exist "%SOURCE%" (
    echo [ERROR] Existing Qwen was not found:
    echo %SOURCE%
    echo.
    echo Find Qwen with:
    echo dir C:\KobeOS\Models\*qwen* /s /b
    exit /b 2
)

if not exist "%DESTDIR%" mkdir "%DESTDIR%"

mklink /H "%DEST%" "%SOURCE%" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Could not create the Qwen hard link.
    echo Both paths must be on the same NTFS volume.
    echo Try CMD as Administrator if Windows blocks link creation.
    exit /b 3
)

echo [READY] Qwen linked for K9 runtime without duplicating model data.
fsutil hardlink list "%SOURCE%" 2>nul
exit /b 0
