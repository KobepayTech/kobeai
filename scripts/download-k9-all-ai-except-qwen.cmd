@echo off
setlocal EnableExtensions EnableDelayedExpansion
title K9 ALL AI MODELS - EXCEPT QWEN

set "ROOT=C:\KobeOS\Models\k9"
set "BASE=C:\KobeOS\Models"
set "OKLOG=%ROOT%\download_completed.txt"
set "FAILLOG=%ROOT%\download_failures.txt"
set "MANIFEST=%ROOT%\K9_ALL_MODELS_EXCEPT_QWEN.txt"

echo.
echo =====================================================================
echo   K9 - DOWNLOAD ALL AI MODELS WE NEED
echo   QWEN IS EXPLICITLY EXCLUDED
echo =====================================================================
echo.
echo This downloader:
echo   - checks before downloading
echo   - skips completed models
echo   - resumes partial Hugging Face downloads
echo   - reuses existing KobeOS weights with hard links
echo   - downloads big AND small specialist models with distinct K9 roles
echo   - includes Tencent agent/memory/vision models without redundant size variants
echo   - clears stale failure logs on every run
echo.
echo Qwen folders/files are NOT downloaded, moved, deleted, or modified.
echo.

if not exist "%ROOT%" mkdir "%ROOT%"
type nul > "%OKLOG%"
type nul > "%FAILLOG%"

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

for %%D in (
    "%ROOT%\brain"
    "%ROOT%\brain\existing"
    "%ROOT%\tencent"
    "%ROOT%\tencent\agents"
    "%ROOT%\tencent\vision"
    "%ROOT%\tencent\ocr"
    "%ROOT%\tencent\memory"
    "%ROOT%\detection"
    "%ROOT%\pose"
    "%ROOT%\tracking"
    "%ROOT%\reid"
    "%ROOT%\face"
    "%ROOT%\ocr"
    "%ROOT%\audio"
    "%ROOT%\embeddings"
    "%ROOT%\tts"
    "%ROOT%\vision"
) do if not exist "%%~D" mkdir "%%~D"

call :MIGRATE_DIR "%ROOT%\optional\detection\rtdetr-v2-r50vd" "%ROOT%\detection\rtdetr-v2-r50vd"
call :MIGRATE_DIR "%ROOT%\optional\vision\locateanything-3b" "%ROOT%\vision\locateanything-3b"
call :MIGRATE_DIR "%ROOT%\optional\ocr\paddleocr-vl-1.6" "%ROOT%\ocr\paddleocr-vl-1.6"
call :MIGRATE_DIR "%ROOT%\optional\detection\YOLO-Master" "%ROOT%\tencent\vision\YOLO-Master"
call :MIGRATE_DIR "%ROOT%\optional\detection\YOLO-World" "%ROOT%\tencent\vision\YOLO-World"

echo.
echo ===== EXISTING NON-QWEN KOBEOS MODELS =====
call :LINK "%BASE%\deepseek.gguf" "%ROOT%\brain\existing\deepseek.gguf"
call :LINK "%BASE%\llama3.gguf"   "%ROOT%\brain\existing\llama3.gguf"
call :LINK "%BASE%\mistral.gguf"  "%ROOT%\brain\existing\mistral.gguf"
call :LINK "%BASE%\phi3.gguf"     "%ROOT%\brain\existing\phi3.gguf"

echo.
echo ===== EXISTING YOLO26 WEIGHTS =====
call :LINK "%BASE%\Sports\shared\yolo26m.pt"       "%ROOT%\detection\yolo26m.pt"
call :LINK "%BASE%\Sports\shared\yolo26m-pose.pt"  "%ROOT%\pose\yolo26m-pose.pt"
call :LINK "%BASE%\Sports\shared\yolo26m-seg.pt"   "%ROOT%\detection\yolo26m-seg.pt"
call :LINK "%BASE%\Sports\shared\yolo26m-cls.pt"   "%ROOT%\detection\yolo26m-cls.pt"
call :LINK "%BASE%\Sports\shared\yoloe-26m-seg.pt" "%ROOT%\detection\yoloe-26m-seg.pt"

echo.
echo =====================================================================
echo   TENCENT AGENT MODELS
echo =====================================================================
call :HF "tencent/Youtu-LLM-2B" "%ROOT%\tencent\agents\youtu-llm-2b"
REM One stronger Tencent text/reasoning fallback is enough.
REM 0.5B / 1.8B / 7B are intentionally omitted because they duplicate this role.
call :HF "tencent/Hunyuan-4B-Instruct" "%ROOT%\tencent\agents\hunyuan-4b-instruct"

echo.
echo =====================================================================
echo   TENCENT VISION
echo =====================================================================
call :HF "tencent/Youtu-VL-4B-Instruct" "%ROOT%\tencent\vision\youtu-vl-4b-instruct"
call :GIT "https://github.com/Tencent/YOLO-Master.git" "%ROOT%\tencent\vision\YOLO-Master"
call :URL "https://github.com/Tencent/YOLO-Master/releases/download/YOLO-Master-v26.02/YOLO-Master-EsMoE-N.pt" "%ROOT%\tencent\vision\YOLO-Master-EsMoE-N.pt"
call :URL "https://github.com/Tencent/YOLO-Master/releases/download/YOLO-Master-v26.02/YOLO-Master-EsMoE-S.pt" "%ROOT%\tencent\vision\YOLO-Master-EsMoE-S.pt"
call :URL "https://github.com/Tencent/YOLO-Master/releases/download/YOLO-Master-v26.02/YOLO-Master-EsMoE-M.pt" "%ROOT%\tencent\vision\YOLO-Master-EsMoE-M.pt"
call :GITREC "https://github.com/AILab-CVC/YOLO-World.git" "%ROOT%\tencent\vision\YOLO-World"
call :HF "wondervictor/YOLO-World-V2.1" "%ROOT%\tencent\vision\yolo-world-v2.1-weights"

echo.
echo =====================================================================
echo   TENCENT OCR
echo =====================================================================
call :HFEX2 "tencent/HunyuanOCR" "%ROOT%\tencent\ocr\hunyuan-ocr-1.5" "v1.0/*" "dflash/*"

echo.
echo =====================================================================
echo   TENCENT MEMORY / AGENT INFRASTRUCTURE
echo =====================================================================
call :GIT "https://github.com/TencentCloud/TencentDB-Agent-Memory.git" "%ROOT%\tencent\memory\TencentDB-Agent-Memory"
call :GIT "https://github.com/Tencent/RoMem.git" "%ROOT%\tencent\memory\RoMem"

echo.
echo =====================================================================
echo   DETECTION / GROUNDING
echo =====================================================================
call :HF "PekingU/RTDetrV2_r50vd" "%ROOT%\detection\rtdetr-v2-r50vd"
call :HF "nvidia/LocateAnything-3B" "%ROOT%\vision\locateanything-3b"

echo.
echo =====================================================================
echo   TRACKING
echo =====================================================================
call :GIT "https://github.com/FoundationVision/ByteTrack.git" "%ROOT%\tracking\ByteTrack"

echo.
echo =====================================================================
echo   PERSON RE-IDENTIFICATION
echo =====================================================================
call :GIT "https://github.com/KaiyangZhou/deep-person-reid.git" "%ROOT%\reid\deep-person-reid"
if exist "%ROOT%\reid\osnet-ain\osnet_ain_x1_0_msmt17.pth" (
    echo [SKIP] OSNet-AIN x1.0 MSMT17
    echo SKIP OSNet-AIN x1.0 MSMT17>>"%OKLOG%"
) else (
    if not exist "%ROOT%\reid\osnet-ain" mkdir "%ROOT%\reid\osnet-ain"
    echo [DOWNLOAD] OSNet-AIN x1.0 MSMT17
    py -m gdown --id 1SigwBE6mPdqiJMqhuIY4aqC7--5CsMal -O "%ROOT%\reid\osnet-ain\osnet_ain_x1_0_msmt17.pth"
    if errorlevel 1 (
        echo OSNet-AIN x1.0 MSMT17>>"%FAILLOG%"
        echo [FAILED] OSNet-AIN
    ) else (
        echo OSNet-AIN x1.0 MSMT17>>"%OKLOG%"
        echo [OK] OSNet-AIN
    )
)

echo.
echo =====================================================================
echo   FACE MODELS
echo =====================================================================
call :HF "opencv/face_detection_yunet" "%ROOT%\face\yunet"
call :HF "opencv/face_recognition_sface" "%ROOT%\face\sface"

echo.
echo =====================================================================
echo   PADDLE OCR - TINY / SMALL / MEDIUM / DOCUMENT
echo =====================================================================
call :HF "PaddlePaddle/PP-OCRv6_tiny_det"   "%ROOT%\ocr\pp-ocr-v6-tiny-det"
call :HF "PaddlePaddle/PP-OCRv6_tiny_rec"   "%ROOT%\ocr\pp-ocr-v6-tiny-rec"
call :HF "PaddlePaddle/PP-OCRv6_small_det"  "%ROOT%\ocr\pp-ocr-v6-small-det"
call :HF "PaddlePaddle/PP-OCRv6_small_rec"  "%ROOT%\ocr\pp-ocr-v6-small-rec"
call :HF "PaddlePaddle/PP-OCRv6_medium_det" "%ROOT%\ocr\pp-ocr-v6-medium-det"
call :HF "PaddlePaddle/PP-OCRv6_medium_rec" "%ROOT%\ocr\pp-ocr-v6-medium-rec"
call :HF "PaddlePaddle/PaddleOCR-VL-1.6" "%ROOT%\ocr\paddleocr-vl-1.6"

echo.
echo =====================================================================
echo   AUDIO / SPEECH / SPEAKER MODELS
echo =====================================================================
call :GIT "https://github.com/snakers4/silero-vad.git" "%ROOT%\audio\silero-vad"
call :HF "openai/whisper-large-v3-turbo" "%ROOT%\audio\whisper-large-v3-turbo"
call :HF "nvidia/speakerverification_en_titanet_large" "%ROOT%\audio\titanet-large"
call :HF "pyannote/segmentation-3.0" "%ROOT%\audio\pyannote-segmentation-3.0"
call :HF "pyannote/speaker-diarization-3.1" "%ROOT%\audio\pyannote-speaker-diarization-3.1"

echo.
echo =====================================================================
echo   EMBEDDINGS / SCHOOL RAG
echo =====================================================================
call :HFEX1 "BAAI/bge-m3" "%ROOT%\embeddings\bge-m3" "onnx/*"

echo.
echo =====================================================================
echo   TEXT TO SPEECH
echo =====================================================================
call :HF "hexgrad/Kokoro-82M" "%ROOT%\tts\kokoro-82m"
call :HFFILE "rhasspy/piper-voices" "sw/sw_CD/lanfrica/medium/sw_CD-lanfrica-medium.onnx" "%ROOT%\tts\piper-swahili"
call :HFFILE "rhasspy/piper-voices" "sw/sw_CD/lanfrica/medium/sw_CD-lanfrica-medium.onnx.json" "%ROOT%\tts\piper-swahili"
call :HFFILE "rhasspy/piper-voices" "sw/sw_CD/lanfrica/medium/MODEL_CARD" "%ROOT%\tts\piper-swahili"

(
echo K9 ALL AI MODELS EXCEPT QWEN
echo.
echo QWEN: EXCLUDED BY USER REQUEST
echo.
echo EXISTING LOCAL BRAINS:
echo   deepseek.gguf
echo   llama3.gguf
echo   mistral.gguf
echo   phi3.gguf
echo.
echo TENCENT AGENTS:
echo   Youtu-LLM-2B
echo   Hunyuan-4B-Instruct  [stronger Tencent fallback/reasoning worker]
echo.
echo TENCENT VISION:
echo   Youtu-VL-4B-Instruct
echo   YOLO-Master EsMoE N/S/M
echo   YOLO-World V2.1
echo.
echo TENCENT OCR:
echo   HunyuanOCR-1.5
echo.
echo TENCENT MEMORY:
echo   TencentDB-Agent-Memory
echo   RoMem
echo.
echo DETECTION / GROUNDING:
echo   YOLO26m / pose / seg / cls / YOLOE seg if already available
echo   RT-DETRv2 R50
echo   NVIDIA LocateAnything-3B
echo.
echo TRACKING / ID:
echo   ByteTrack
echo   OSNet-AIN x1.0 MSMT17
echo   YuNet
echo   SFace
echo.
echo OCR:
echo   PP-OCRv6 tiny det/rec
echo   PP-OCRv6 small det/rec
echo   PP-OCRv6 medium det/rec
echo   PaddleOCR-VL-1.6
echo.
echo AUDIO:
echo   Silero VAD
echo   Whisper Large-v3-Turbo
echo   TitaNet Large
echo   pyannote segmentation-3.0
echo   pyannote speaker-diarization-3.1
echo.
echo MEMORY / RAG:
echo   BGE-M3
echo.
echo TTS:
echo   Kokoro-82M
echo   Piper Swahili sw_CD-lanfrica-medium
echo.
echo NOTE:
echo   CubeBox was discussed, but no verified standalone official CubeBox
echo   model checkpoint was identified, so this script does not invent one.
) > "%MANIFEST%"

echo.
echo =====================================================================
echo   FINISHED K9 ALL-MODELS PASS - QWEN EXCLUDED
echo =====================================================================
echo Completed/skipped successfully: %OKLOG%
echo Failed/gated:                 %FAILLOG%
echo Manifest:                     %MANIFEST%
echo Tree:                         %ROOT%\k9_model_tree.txt
tree "%ROOT%" /F > "%ROOT%\k9_model_tree.txt"
echo.
echo If pyannote is in the failure file, accept both model access pages,
echo run: "%HF_EXE%" auth login
echo then run this CMD file again.
echo.
echo Re-running is safe: completed models are skipped and partial HF downloads resume.
pause
exit /b 0

:HF
set "MODEL=%~1"
set "DEST=%~2"
if exist "%DEST%\.k9_complete" (
    echo [SKIP] %MODEL%
    echo SKIP %MODEL%>>"%OKLOG%"
    exit /b 0
)
if not exist "%DEST%" mkdir "%DEST%"
echo.
echo [DOWNLOAD] %MODEL%
echo            ^> %DEST%
"%HF_EXE%" download "%MODEL%" --local-dir "%DEST%"
if errorlevel 1 (
    echo %MODEL%>>"%FAILLOG%"
    echo [FAILED] %MODEL%
    exit /b 0
)
type nul > "%DEST%\.k9_complete"
echo %MODEL%>>"%OKLOG%"
echo [OK] %MODEL%
exit /b 0

:HFEX1
set "MODEL=%~1"
set "DEST=%~2"
set "EX1=%~3"
if exist "%DEST%\.k9_complete" (
    echo [SKIP] %MODEL%
    echo SKIP %MODEL%>>"%OKLOG%"
    exit /b 0
)
if not exist "%DEST%" mkdir "%DEST%"
echo.
echo [DOWNLOAD] %MODEL% excluding %EX1%
"%HF_EXE%" download "%MODEL%" --local-dir "%DEST%" --exclude "%EX1%"
if errorlevel 1 (
    echo %MODEL%>>"%FAILLOG%"
    echo [FAILED] %MODEL%
    exit /b 0
)
type nul > "%DEST%\.k9_complete"
echo %MODEL%>>"%OKLOG%"
echo [OK] %MODEL%
exit /b 0

:HFEX2
set "MODEL=%~1"
set "DEST=%~2"
set "EX1=%~3"
set "EX2=%~4"
if exist "%DEST%\.k9_complete" (
    echo [SKIP] %MODEL%
    echo SKIP %MODEL%>>"%OKLOG%"
    exit /b 0
)
if not exist "%DEST%" mkdir "%DEST%"
echo.
echo [DOWNLOAD] %MODEL%
echo            excluding %EX1%
echo            excluding %EX2%
"%HF_EXE%" download "%MODEL%" --local-dir "%DEST%" --exclude "%EX1%" --exclude "%EX2%"
if errorlevel 1 (
    echo %MODEL%>>"%FAILLOG%"
    echo [FAILED] %MODEL%
    exit /b 0
)
type nul > "%DEST%\.k9_complete"
echo %MODEL%>>"%OKLOG%"
echo [OK] %MODEL%
exit /b 0

:HFFILE
set "MODEL=%~1"
set "FILE=%~2"
set "DEST=%~3"
if exist "%DEST%\%FILE%" (
    echo [SKIP] %MODEL% :: %FILE%
    echo SKIP %MODEL% :: %FILE%>>"%OKLOG%"
    exit /b 0
)
if not exist "%DEST%" mkdir "%DEST%"
echo.
echo [DOWNLOAD FILE] %MODEL% :: %FILE%
"%HF_EXE%" download "%MODEL%" "%FILE%" --local-dir "%DEST%"
if errorlevel 1 (
    echo %MODEL% :: %FILE%>>"%FAILLOG%"
    echo [FAILED] %FILE%
) else (
    echo %MODEL% :: %FILE%>>"%OKLOG%"
    echo [OK] %FILE%
)
exit /b 0

:GIT
set "URL=%~1"
set "DEST=%~2"
if exist "%DEST%\.git" (
    echo [SKIP] Git repo: %DEST%
    echo SKIP %URL%>>"%OKLOG%"
    exit /b 0
)
if exist "%DEST%" (
    echo [WARNING] Existing non-Git folder: %DEST%
    echo Git folder conflict: %DEST%>>"%FAILLOG%"
    exit /b 0
)
echo.
echo [CLONE] %URL%
git clone --depth 1 "%URL%" "%DEST%"
if errorlevel 1 (
    echo %URL%>>"%FAILLOG%"
    echo [FAILED] %URL%
) else (
    echo %URL%>>"%OKLOG%"
    echo [OK] %URL%
)
exit /b 0

:GITREC
set "URL=%~1"
set "DEST=%~2"
if exist "%DEST%\.git" (
    echo [SKIP] Git repo: %DEST%
    echo SKIP %URL%>>"%OKLOG%"
    exit /b 0
)
if exist "%DEST%" (
    echo [WARNING] Existing non-Git folder: %DEST%
    echo Git folder conflict: %DEST%>>"%FAILLOG%"
    exit /b 0
)
echo.
echo [CLONE RECURSIVE] %URL%
git clone --recursive --depth 1 "%URL%" "%DEST%"
if errorlevel 1 (
    echo %URL%>>"%FAILLOG%"
    echo [FAILED] %URL%
) else (
    echo %URL%>>"%OKLOG%"
    echo [OK] %URL%
)
exit /b 0

:URL
set "URL=%~1"
set "DEST=%~2"
if exist "%DEST%" (
    for %%A in ("%DEST%") do if %%~zA GTR 0 (
        echo [SKIP] %%~nxA
        echo SKIP %URL%>>"%OKLOG%"
        exit /b 0
    )
)
for %%F in ("%DEST%") do if not exist "%%~dpF" mkdir "%%~dpF"
echo.
echo [DOWNLOAD URL] %URL%
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%DEST%'"
if errorlevel 1 (
    echo %URL%>>"%FAILLOG%"
    echo [FAILED] %URL%
) else (
    echo %URL%>>"%OKLOG%"
    echo [OK] %DEST%
)
exit /b 0

:LINK
set "SRC=%~1"
set "DST=%~2"
if exist "%DST%" (
    echo [SKIP] Already present: %DST%
    echo SKIP %DST%>>"%OKLOG%"
    exit /b 0
)
if not exist "%SRC%" (
    echo [NOT FOUND] Existing local model: %SRC%
    echo Existing local model missing: %SRC%>>"%FAILLOG%"
    exit /b 0
)
for %%F in ("%DST%") do if not exist "%%~dpF" mkdir "%%~dpF"
mklink /H "%DST%" "%SRC%" >nul 2>&1
if errorlevel 1 (
    echo Hard link failed: %SRC% -^> %DST%>>"%FAILLOG%"
    echo [FAILED LINK] %SRC%
) else (
    echo [REUSED] %SRC%
    echo       ^> %DST%
    echo REUSED %SRC%>>"%OKLOG%"
)
exit /b 0

:MIGRATE_DIR
set "OLD=%~1"
set "NEW=%~2"
if exist "%NEW%" exit /b 0
if not exist "%OLD%" exit /b 0
for %%F in ("%NEW%") do if not exist "%%~dpF" mkdir "%%~dpF"
echo [MIGRATE] %OLD%
echo        ^> %NEW%
move "%OLD%" "%NEW%" >nul 2>&1
exit /b 0
