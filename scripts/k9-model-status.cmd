@echo off
setlocal EnableExtensions EnableDelayedExpansion

title K9 Model Readiness
set "ROOT=C:\KobeOS\Models\k9"
set /a REQUIRED_TOTAL=0
set /a REQUIRED_READY=0
set /a OPTIONAL_TOTAL=0
set /a OPTIONAL_READY=0

echo.
echo ==============================================================
echo   K9 MODEL READINESS CHECK
echo ==============================================================
echo Root: %ROOT%
echo.

if not exist "%ROOT%" (
  echo [ERROR] K9 model root does not exist.
  echo Run scripts\download-k9-all-ai-except-qwen.cmd first.
  exit /b 2
)

REM Runtime-local text models. These are the exact paths used by k9-runtime.
call :REQFILE "Qwen"     "%ROOT%\brain\existing\qwen.gguf"
call :REQFILE "DeepSeek" "%ROOT%\brain\existing\deepseek.gguf"
call :REQFILE "Llama3"   "%ROOT%\brain\existing\llama3.gguf"
call :REQFILE "Mistral"  "%ROOT%\brain\existing\mistral.gguf"
call :REQFILE "Phi3"     "%ROOT%\brain\existing\phi3.gguf"

REM Tencent agents / vision / memory / OCR
call :REQDIR "Tencent Youtu-LLM-2B" "%ROOT%\tencent\agents\youtu-llm-2b"
call :REQDIR "Tencent Hunyuan-4B" "%ROOT%\tencent\agents\hunyuan-4b-instruct"
call :REQDIR "Tencent Youtu-VL-4B" "%ROOT%\tencent\vision\youtu-vl-4b-instruct"
call :REQDIR "Tencent HunyuanOCR-1.5" "%ROOT%\tencent\ocr\hunyuan-ocr-1.5"
call :REQGIT "TencentDB Agent Memory" "%ROOT%\tencent\memory\TencentDB-Agent-Memory"
call :REQGIT "Tencent RoMem" "%ROOT%\tencent\memory\RoMem"

REM Fast vision
call :REQFILE "YOLO26m" "%ROOT%\detection\yolo26m.pt"
call :REQFILE "YOLO26m Pose" "%ROOT%\pose\yolo26m-pose.pt"
call :REQGIT "ByteTrack" "%ROOT%\tracking\ByteTrack"
call :REQFILE "OSNet-AIN" "%ROOT%\reid\osnet-ain\osnet_ain_x1_0_msmt17.pth"
call :REQDIR "YuNet" "%ROOT%\face\yunet"
call :REQDIR "SFace" "%ROOT%\face\sface"

REM OCR
call :REQDIR "PP-OCRv6 medium detector" "%ROOT%\ocr\pp-ocr-v6-medium-det"
call :REQDIR "PP-OCRv6 medium recognizer" "%ROOT%\ocr\pp-ocr-v6-medium-rec"

REM Audio
call :REQGIT "Silero VAD" "%ROOT%\audio\silero-vad"
call :REQDIR "Whisper large-v3-turbo" "%ROOT%\audio\whisper-large-v3-turbo"
call :REQDIR "TitaNet Large" "%ROOT%\audio\titanet-large"
call :REQDIR "pyannote segmentation 3.0" "%ROOT%\audio\pyannote-segmentation-3.0"
call :REQDIR "pyannote diarization 3.1" "%ROOT%\audio\pyannote-speaker-diarization-3.1"

REM RAG / TTS
call :REQDIR "BGE-M3" "%ROOT%\embeddings\bge-m3"
call :REQDIR "Kokoro-82M" "%ROOT%\tts\kokoro-82m"
call :REQDIR "Piper Swahili" "%ROOT%\tts\piper-swahili"

REM Optional / benchmark / hardware-tier models
call :OPTDIR "Qwen3-VL-8B" "%ROOT%\brain\qwen3-vl-8b"
call :OPTDIR "PP-OCRv6 tiny detector" "%ROOT%\ocr\pp-ocr-v6-tiny-det"
call :OPTDIR "PP-OCRv6 tiny recognizer" "%ROOT%\ocr\pp-ocr-v6-tiny-rec"
call :OPTDIR "PP-OCRv6 small detector" "%ROOT%\ocr\pp-ocr-v6-small-det"
call :OPTDIR "PP-OCRv6 small recognizer" "%ROOT%\ocr\pp-ocr-v6-small-rec"
call :OPTDIR "PaddleOCR-VL-1.6" "%ROOT%\ocr\paddleocr-vl-1.6"
call :OPTDIR "RT-DETRv2" "%ROOT%\detection\rtdetr-v2-r50vd"
call :OPTDIR "LocateAnything-3B" "%ROOT%\vision\locateanything-3b"
call :OPTFILE "YOLO-Master N" "%ROOT%\tencent\vision\YOLO-Master-EsMoE-N.pt"
call :OPTFILE "YOLO-Master S" "%ROOT%\tencent\vision\YOLO-Master-EsMoE-S.pt"
call :OPTFILE "YOLO-Master M" "%ROOT%\tencent\vision\YOLO-Master-EsMoE-M.pt"
call :OPTDIR "YOLO-World V2.1" "%ROOT%\tencent\vision\yolo-world-v2.1-weights"

echo.
echo ==============================================================
echo Required ready: %REQUIRED_READY% / %REQUIRED_TOTAL%
echo Optional ready: %OPTIONAL_READY% / %OPTIONAL_TOTAL%

if %REQUIRED_READY% EQU %REQUIRED_TOTAL% (
  echo [READY] Required K9 model stack is present at runtime paths.
  exit /b 0
) else (
  echo [NOT READY] One or more required K9 runtime components are missing.
  if not exist "%ROOT%\brain\existing\qwen.gguf" if exist "C:\KobeOS\Models\qwen.gguf" (
    echo [FIX ] Existing Qwen found outside runtime root.
    echo        Run scripts\link-k9-qwen-runtime.cmd
  )
  echo Check C:\KobeOS\Models\k9\download_failures.txt
  exit /b 1
)

:REQFILE
set /a REQUIRED_TOTAL+=1
if exist "%~2" (
  set /a REQUIRED_READY+=1
  echo [READY] %~1
) else (
  echo [MISS ] %~1 -- %~2
)
exit /b 0

:REQDIR
set /a REQUIRED_TOTAL+=1
if exist "%~2\.k9_complete" (
  set /a REQUIRED_READY+=1
  echo [READY] %~1
) else if exist "%~2" (
  echo [PART ] %~1 -- folder exists but .k9_complete is missing
) else (
  echo [MISS ] %~1 -- %~2
)
exit /b 0

:REQGIT
set /a REQUIRED_TOTAL+=1
if exist "%~2\.git" (
  set /a REQUIRED_READY+=1
  echo [READY] %~1
) else (
  echo [MISS ] %~1 -- %~2
)
exit /b 0

:OPTFILE
set /a OPTIONAL_TOTAL+=1
if exist "%~2" (
  set /a OPTIONAL_READY+=1
  echo [OPT OK] %~1
) else (
  echo [OPT --] %~1
)
exit /b 0

:OPTDIR
set /a OPTIONAL_TOTAL+=1
if exist "%~2\.k9_complete" (
  set /a OPTIONAL_READY+=1
  echo [OPT OK] %~1
) else if exist "%~2" (
  echo [OPT PT] %~1 -- partial folder
) else (
  echo [OPT --] %~1
)
exit /b 0
