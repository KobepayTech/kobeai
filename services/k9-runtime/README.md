# K9 Model Runtime

`services/k9-runtime` turns the local K9 model tree into one authenticated, lazy-loaded inference service.

The runtime does **not** download weights. It uses the model folders created by the K9 downloader and reports the difference between:

- `present`: the expected path exists on disk;
- `complete`: the directory/file looks complete enough to attempt loading;
- `loaded`: the adapter is currently resident in RAM/VRAM;
- `error`: the most recent load failure.

## Model root

On Windows the native default is:

```text
C:\KobeOS\Models\k9
```

Inside Docker the default is:

```text
/models/k9
```

Override either with `K9_MODEL_ROOT`.

The school-server compose file mounts `${K9_MODEL_ROOT_HOST}` into `/models/k9`. On a Windows Docker Desktop host set:

```text
K9_MODEL_ROOT_HOST=C:/KobeOS/Models/k9
```

## Connected capability routing

The runtime prefers the existing K9 production pack:

| Capability | Primary local model |
| --- | --- |
| general chat | existing `qwen.gguf` |
| reasoning | existing `deepseek.gguf` |
| multimodal reasoning | Qwen3-VL-8B |
| lightweight agent | Tencent Youtu-LLM-2B |
| camera/VLM understanding | Tencent Youtu-VL-4B-Instruct |
| hard OCR | Tencent HunyuanOCR-1.5 |
| real-time detection | YOLO26m |
| pose | YOLO26m-pose |
| tracking | ByteTrack |
| cross-camera ReID | OSNet-AIN |
| face detection / recognition assets | YuNet / SFace |
| speech activity | Silero VAD |
| ASR | Whisper Large-v3-Turbo |
| speaker ID | TitaNet Large |
| diarization | pyannote |
| RAG embeddings | BGE-M3 |
| Swahili TTS | Piper `sw_CD-lanfrica-medium` |

TencentDB-Agent-Memory, RoMem, the PP-OCR components, Kokoro, and optional benchmark models are also registered so K9 can see their exact local paths. They are not auto-loaded at startup.

KobeVision remains the privacy boundary for school biometric attendance. K9 Runtime does not expose a public face-embedding API and does not replace the existing consent/encrypted-template flow.

## Start on Windows

Create a Python 3.12 virtual environment and install:

```bat
cd services\k9-runtime
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -U pip
.venv\Scripts\python -m pip install -r requirements.txt
set K9_MODEL_ROOT=C:\KobeOS\Models\k9
set K9_RUNTIME_SHARED_SECRET=replace-me
.venv\Scripts\python -m uvicorn app:app --host 127.0.0.1 --port 8091
```

For TitaNet/pyannote support also install:

```bat
.venv\Scripts\python -m pip install -r requirements-audio-extra.txt
```

## Main endpoints

All `/v1/*` endpoints require `x-k9-secret` or a bearer token matching `K9_RUNTIME_SHARED_SECRET`.

```text
GET  /health
GET  /v1/models
POST /v1/models/load
POST /v1/models/unload
POST /v1/chat
POST /v1/vision/detect
POST /v1/vision/pose
POST /v1/vision/describe
POST /v1/ocr
POST /v1/tracking/update
POST /v1/reid/embedding
POST /v1/audio/vad
POST /v1/audio/transcribe
POST /v1/embed
POST /v1/tts/swahili
```

`/health` deliberately stays unauthenticated so Docker and local supervisors can check service liveness without exposing model details.

## Loading policy

Nothing heavy is loaded merely because it exists on disk.

A model loads on first use or through `POST /v1/models/load`. It stays resident until explicitly unloaded or the process stops. This keeps the real-time paths warm without forcing Qwen3-VL, Youtu-VL, HunyuanOCR, Whisper, TitaNet and pyannote into memory simultaneously.

## Backend integration

The KobeAI API exposes staff-authenticated model-control endpoints under:

```text
GET  /api/v1/k9-runtime/health
GET  /api/v1/k9-runtime/models
POST /api/v1/k9-runtime/models/load
POST /api/v1/k9-runtime/models/unload
```

Large image/audio inference stays on the local runtime network rather than being proxied through the public API server.
