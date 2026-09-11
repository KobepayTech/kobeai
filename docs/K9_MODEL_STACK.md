# K9 local model stack

This file is the canonical model-installation companion to `docs/K9_ARCHITECTURE.md`.

The Windows model root is:

```text
C:\KobeOS\Models\k9
```

The machine-readable registry is `config/k9-models.json`.

## Important rules

1. **Do not download Qwen from the K9 downloader.** KobeOS already owns the existing Qwen GGUF under `C:\KobeOS\Models\qwen.gguf`. K9 may use it, but the K9 installer does not duplicate or modify it.
2. **An agent is a role, not a separate model copy.** Attendance, timetable, location, memory, birthday, security, and other lightweight K9 agents share the same resident Youtu-LLM worker unless routing calls for a stronger model.
3. **Do not install every Hunyuan size.** K9 uses Youtu-LLM-2B for lightweight agents and Hunyuan-4B-Instruct as the stronger Tencent text/reasoning fallback. Hunyuan 0.5B, 1.8B, and 7B are intentionally omitted because they duplicate that role.
4. **Heavy vision models are not run on every CCTV frame.** YOLO + tracking are the fast path. VLM/OCR workers run only on sampled frames or queued events.
5. **Model downloads never belong in Git.** The repository stores installers, manifests, configuration, and runtime code only.

## Installation

From Windows CMD:

```cmd
scripts\download-k9-all-ai-except-qwen.cmd
```

The installer is restart-safe:

- Hugging Face downloads use the same `--local-dir`, so partial downloads are reused/resumed.
- Completed Hugging Face folders get `.k9_complete`.
- Existing KobeOS YOLO and GGUF files are hard-linked instead of copied.
- Git repositories are skipped when `.git` already exists.
- `download_failures.txt` is recreated each run so resolved failures do not remain stale.

Check readiness with:

```cmd
scripts\k9-model-status.cmd
```

## Core K9 routing

```text
ordinary text / existing KobeOS chat
        -> existing qwen.gguf

lightweight workflow/agent task
        -> Tencent Youtu-LLM-2B

stronger Tencent text/reasoning fallback
        -> Hunyuan-4B-Instruct

continuous camera frames
        -> YOLO26 / selected YOLO-Master deployment
        -> ByteTrack
        -> YuNet/SFace and OSNet when identity is needed

visual event requiring language/scene reasoning
        -> Tencent Youtu-VL-4B-Instruct

fast board/book OCR
        -> PP-OCRv6

hard OCR/document/layout
        -> HunyuanOCR-1.5
        -> PaddleOCR-VL only when benchmarked/needed

classroom microphone
        -> Silero VAD
        -> Whisper large-v3-turbo
        -> pyannote diarization
        -> TitaNet enrolled-speaker identity

school knowledge / profile retrieval
        -> BGE-M3
        -> TencentDB Agent Memory + RoMem

speech output
        -> Kokoro-82M (general)
        -> Piper sw_CD voice (Swahili path)
```

## Tencent components

### Agents

- `tencent/Youtu-LLM-2B` — default lightweight agent model.
- `tencent/Hunyuan-4B-Instruct` — stronger Tencent reasoning fallback.

### Vision

- `tencent/Youtu-VL-4B-Instruct` — visual-language worker.
- Tencent YOLO-Master N/S/M — detector benchmark/deployment choices.
- YOLO-World V2.1 — open-vocabulary search.

Only one detector should normally serve a camera stream at a time. Alternative detector weights are present for benchmarking and hardware tiers; they are not all loaded together.

### OCR

- `tencent/HunyuanOCR` — install the current root HunyuanOCR 1.5 weights.
- The installer excludes archived `v1.0/*` and optional `dflash/*` so the same capability is not stored twice.

### Memory

- `TencentCloud/TencentDB-Agent-Memory` — long-term/shared agent memory runtime.
- `Tencent/RoMem` — temporal memory layer for facts/events that change over time.

These are software repositories rather than large standalone weight files. They are expected under:

```text
C:\KobeOS\Models\k9\tencent\memory\
```

## Vision/tracking specialists

- YOLO26m — default existing detector available from KobeOS Sports assets.
- YOLO26m-pose — pose/activity cues.
- ByteTrack — track identity inside one camera.
- OSNet-AIN — cross-camera person ReID when face identity is unavailable.
- YuNet — face detection baseline.
- SFace — face embedding/recognition baseline.
- RT-DETRv2 — alternative detector benchmark.
- NVIDIA LocateAnything-3B — precision grounding, optional at runtime.

The repository must not ship InsightFace research-only pretrained weights as a commercial default. If an ArcFace-compatible model is later adopted, its production licensing must be explicit.

## OCR tiers

The installer includes tiny, small, and medium PP-OCRv6 tiers because these are useful hardware/deployment tiers rather than separate agent roles:

```text
Tiny   -> very low-resource edge node
Small  -> lightweight school server
Medium -> default quality-first fast OCR
```

HunyuanOCR and PaddleOCR-VL are not placed in the fast per-frame OCR loop.

## Audio specialists

- Silero VAD — speech/no-speech gate.
- Whisper large-v3-turbo — speech-to-text.
- pyannote segmentation 3.0 — speaker segmentation.
- pyannote speaker-diarization 3.1 — diarization pipeline.
- NVIDIA TitaNet-Large — enrolled-speaker embeddings/recognition.

The two pyannote downloads are gated. Accept their Hugging Face conditions and run:

```cmd
hf auth login
```

Then rerun the same downloader.

## Readiness

A folder merely existing does not prove a Hugging Face model completed. For Hugging Face directories the installer writes:

```text
.k9_complete
```

`k9-model-status.cmd` distinguishes READY, PARTIAL, MISSING, and optional components.

A model being downloaded is also not equivalent to K9 production readiness. The runtime still needs the relevant GPU worker, health checks, queue leases/retries, camera credentials, and school deployment configuration before that capability should be advertised as live.
