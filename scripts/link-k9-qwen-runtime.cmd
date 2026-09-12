@echo off
setlocal EnableExtensions

title K9 Qwen Runtime Link

echo.
echo ==============================================================
echo   K9 QWEN RUNTIME LINK - NO LONGER NEEDED
echo ==============================================================
echo.
echo This helper used to hard-link:
echo     C:\KobeOS\Models\qwen.gguf
echo  to C:\KobeOS\Models\k9\brain\existing\qwen.gguf
echo.
echo K9 now reads every model location from the one registry:
echo     config\k9-models.json
echo.
echo Qwen is registered there at the KobeOS models root, so the K9
echo runtime, the api-server, the worker and the desktop app all open
echo C:\KobeOS\Models\qwen.gguf directly. No link is required.
echo.
echo Creating one would also work against the layout step, which lists
echo brain\existing\qwen.gguf as a redundant hard-link name to remove:
echo     node scripts\k9-models.mjs layout
echo.
echo Check what K9 can actually see instead:
echo     scripts\k9-model-status.cmd
echo.

REM Report the current state without changing anything.
if exist "C:\KobeOS\Models\qwen.gguf" (
    echo [READY] Qwen is present at C:\KobeOS\Models\qwen.gguf
    fsutil hardlink list "C:\KobeOS\Models\qwen.gguf" 2>nul
) else (
    echo [MISS ] C:\KobeOS\Models\qwen.gguf was not found.
    echo         KobeOS owns this file; K9 never downloads or moves it.
)

exit /b 0
