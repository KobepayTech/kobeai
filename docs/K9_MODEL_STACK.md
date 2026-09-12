# K9 local model stack

This file is the canonical model-installation companion to `docs/K9_ARCHITECTURE.md`.

## Where models live

The registry is `config/k9-models.json`. **Code reads model locations only from
it** — through `scripts/k9-models.mjs` (scripts, operators, `paths --json` for
Python workers) or `artifacts/api-server/src/lib/k9-models.ts` (the API and the
admin models page). Never hard-code a model path in a service.

Two roots, each overridable by env:

| Root | Default | Env override | Holds |
|---|---|---|---|
| `base` | `C:\KobeOS\Models` | `KOBEOS_MODELS_ROOT` | General KobeOS text models, owned by KobeOS |
| `k9` | `C:\KobeOS\Models\k9` | `K9_MODELS_ROOT` | Everything K9-specific |

```text
C:\KobeOS\Models\
├── qwen.gguf  deepseek.gguf  llama3.gguf  mistral.gguf  phi3.gguf
└── k9\
    ├── brain\
    │   ├── qwen3-vl-8b\         Qwen3-VL-8B-Instruct — the K9 brain
    │   └── existing\            qwen / deepseek / llama3 / mistral / phi3 .gguf (hard links)
    ├── tencent\
    │   ├── agents\              youtu-llm-2b, hunyuan-4b-instruct
    │   ├── vision\              youtu-vl-4b-instruct
    │   ├── ocr\                 hunyuan-ocr-1.5
    │   └── memory\              TencentDB-Agent-Memory, RoMem
    ├── detection\               yolo26m.pt, yolo26m-seg.pt, yolo26m-cls.pt, yoloe-26m-seg.pt
    ├── pose\                    yolo26m-pose.pt
    ├── tracking\                ByteTrack
    ├── reid\                    deep-person-reid, osnet-ain\osnet_ain_x1_0_msmt17.pth
    ├── face\                    yunet, sface
    ├── ocr\                     pp-ocr-v6-{tiny,small,medium}-{det,rec}
    ├── audio\                   silero-vad, whisper-large-v3-turbo, titanet-large,
    │                            pyannote-segmentation-3.0, pyannote-speaker-diarization-3.1
    ├── embeddings\              bge-m3
    ├── tts\                     kokoro-82m, piper-swahili
    └── optional\
        ├── detection\           RT-DETRv2, YOLO-Master (+ N/S/M weights), YOLO-World
        ├── vision\              LocateAnything-3B
        └── ocr\                 PaddleOCR-VL-1.6
```

Anything under `optional\` is a benchmark or hardware-tier alternative and is
never required.

## What runs today

**Brain — Qwen3-VL-8B-Instruct through Ollama.** K9's brain models run through
Ollama, built directly from the files in the registry rather than from
separately pulled copies. The brain, `qwen3_vl_8b` (`brain\qwen3-vl-8b`,
17.5 GB of safetensors), is imported as `k9-qwen3-vl` and quantized to Q4_K_M
(about 6 GB), so it fits in 16 GB of RAM and handles both text and images. The
KobeOS GGUFs are the fallbacks: `k9-qwen` (Qwen2.5-7B), `k9-mistral`,
`k9-llama3`, `k9-phi3`, `k9-deepseek`. `runtime.ollama` sets the order the
api-server tries them in, using the first one Ollama actually has.
`OLLAMA_MODEL` pins a single model instead. On a CPU-only PC an 8B model answers
noticeably slower than the older 7B; a GPU school server is recommended.

```cmd
node scripts\k9-models.mjs ollama-sync
```

registers any that are missing (the downloader and the K9 desktop app run it
too). Ollama reuses a blob it already holds for the same file — for example
from KobeOS's `kobechat-*` models — so GGUFs are not duplicated. Importing the
Qwen3-VL-8B brain the first time copies its weights into Ollama and quantizes
them, which needs roughly 40 GB of free disk while it runs and can take a long
time on a CPU-only PC.

**Vision and voice activity — connected through the K9 model runtime.**
`services/k9-runtime` is a local HTTP service run by the Python named in
`runtime.python` (on the reference PC `C:\KobeOS\vision-env`: CPU PyTorch,
Ultralytics, OpenCV). It loads every weight and code file through the registry
(`weights` / `code` entries) and needs no extra packages:

| Engine | Registry models | Endpoint |
|---|---|---|
| detect / segment / classify / pose | `yolo26m`, `yolo26m_seg`, `yolo26m_cls`, `yolo26m_pose` | `/v1/detect` … `/v1/pose` |
| tracking | `yolo26m` + ByteTrack (Ultralytics implementation, one tracker per camera) | `/v1/track` |
| faces | `yunet` + `sface` (128-d embeddings, cosine matching) | `/v1/faces`, `/v1/faces/match` |
| reid | `deep_person_reid` code + `osnet_ain_x1_0_msmt17` (512-d) | `/v1/reid` |
| vad | `silero_vad` | `/v1/vad` |

Start it with `scripts\k9-runtime.cmd` (the K9 desktop app starts it
automatically). `GET /health` lists every engine's state, and the admin
**Models** page shows each model as Connected or exactly what it still needs.
`scripts/k9-worker.mjs` drains the vision queue with it:

- **Teacher Lens lookup** — YuNet + SFace embed the largest face in the frame
  and the worker matches it against the enrolled student face gallery
  (`student_face_embeddings`, cosine ≥ 0.363). A match is whispered to the
  teacher. Enroll faces from the dashboard **Students** page ("Add photo") or
  from the lens picker ("Remember this face").
- **Teacher Lens paper photos** — read by the first registry brain in Ollama
  that accepts images (Qwen3-VL-8B). The answers pre-fill the mark sheet; the
  teacher checks them before saving, and nothing is recorded automatically.
- **Remediation plans, curated notes and other questions** — answered by the
  registry's brain order through Ollama.

Tests: `python -m unittest discover -s services/k9-runtime/tests`; set
`K9_RUNTIME_MODELS=1` to run the real models on sample photos.

**Not connected yet** (the runtime reports each one and why):

- OCR engines — PP-OCRv6 needs PaddleOCR; HunyuanOCR needs transformers. (Paper photos are read by Qwen3-VL instead.)
- Whisper large-v3-turbo and BGE-M3 — need transformers.
- TitaNet — needs NeMo. pyannote — gated weights not downloaded.
- Kokoro and Piper voices — need their TTS packages.
- Youtu-LLM, Hunyuan-4B, Youtu-VL — need transformers, and are slow on a CPU-only PC.
- YOLOE open-prompt segmentation — needs a MobileCLIP text encoder not in the registry.
- TencentDB Agent Memory and RoMem — services, not integrated yet.
- Camera presence alerts don't attach a frame yet, so those scenes aren't analysed.

## Important rules

1. **Do not download Qwen from the K9 downloader.** KobeOS owns `C:\KobeOS\Models\qwen.gguf`, and `brain\qwen3-vl-8b` is installed separately. K9 uses both, but the K9 tooling never downloads, moves or modifies them.
2. **An agent is a role, not a separate model copy.** Attendance, timetable, location, memory, birthday, security, and other lightweight K9 agents share the same resident Youtu-LLM worker unless routing calls for a stronger model.
3. **Do not install every Hunyuan size.** K9 uses Youtu-LLM-2B for lightweight agents and Hunyuan-4B-Instruct as the stronger Tencent text/reasoning fallback. Hunyuan 0.5B, 1.8B, and 7B are intentionally omitted because they duplicate that role.
4. **Heavy vision models are not run on every CCTV frame.** YOLO + tracking are the fast path. VLM/OCR workers run only on sampled frames or queued events.
5. **Model downloads never belong in Git.** The repository stores installers, manifests, configuration, and runtime code only.

## Installation

From Windows CMD:

```cmd
scripts\download-k9-all-ai-except-qwen.cmd
```

It prepares Python, Git and the Hugging Face CLI, then runs
`scripts/k9-models.mjs`, which does everything from the registry:

1. `layout --apply` moves folders to their registry location (old locations
   are listed as `legacy_paths` / `layout.relocate`), creates missing folders,
   and removes only extra hard-link names whose data stays at the KobeOS root.
   Nothing is deleted; run `node scripts\k9-models.mjs layout` first for a dry run.
2. `download` fetches anything not ready. Hugging Face downloads reuse the same
   `--local-dir`, so partial downloads resume; completed folders get
   `.k9_complete`; existing KobeOS GGUF and YOLO files are hard-linked, not
   copied; git repositories are skipped once `.git` exists.
3. `status` prints readiness. `download_failures.txt` is recreated each run.

Check readiness at any time with:

```cmd
scripts\k9-model-status.cmd
```

Other commands: `node scripts\k9-models.mjs root`, `paths [--json]`,
`status --json`.

To add or move a model, change `config/k9-models.json` only — add the old
location to `legacy_paths` so existing PCs migrate on the next `layout --apply`.

## Core K9 routing

```text
ordinary text, teacher / classroom assistant, image questions
        -> Qwen3-VL-8B (k9-qwen3-vl), falling back to qwen.gguf

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

A folder merely existing does not prove a Hugging Face model completed. For Hugging Face directories the downloader writes:

```text
.k9_complete
```

Gated repositories also list the weight files they must contain (`expect` in
the registry), so a folder holding only a README is reported as incomplete.
`k9-model-status.cmd` distinguishes READY, PARTIAL, MISSING, and optional components.

A model being downloaded is also not equivalent to K9 production readiness. The runtime still needs the relevant GPU worker, health checks, queue leases/retries, camera credentials, and school deployment configuration before that capability should be advertised as live.
