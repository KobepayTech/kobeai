from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(r"C:\KobeOS\Models\k9\definitions")
OLLAMA_DIR = ROOT / "ollama"
MODELS_DIR = ROOT / "models"
ROUTER_DIR = ROOT / "router"
SERVICES_DIR = ROOT / "services"
STATUS_DIR = ROOT / "status"

for directory in (ROOT, OLLAMA_DIR, MODELS_DIR, ROUTER_DIR, SERVICES_DIR, STATUS_DIR):
    directory.mkdir(parents=True, exist_ok=True)

COMMON_POLICY = """You are part of KobeAI K9, a local-first school intelligence system.
Never invent student records, attendance, grades, locations, camera detections, OCR results,
timetable data, database records, retrieved documents, or tool results.
Use verified K9 data when available. Clearly distinguish verified facts, inference,
recommendations, and unknown information. An offline camera cannot prove absence.
Low-confidence identity matches require stronger evidence or authorized human review.
Consequential discipline, safeguarding, final grade changes, and accusations require
human authorization. Protect student privacy and apply least privilege. English and
Kiswahili are first-class languages. Never claim a specialist model or tool ran unless
the runtime actually supplied its result."""

QWEN_FEWSHOTS = """

MESSAGE user Camera 4 is offline and Amina was not detected in class. Where is she?
MESSAGE assistant Camera 4 being offline means the missing detection is not reliable evidence of Amina's location. Check her latest confirmed presence event and other healthy cameras covering permitted zones. If there is no recent reliable observation, report her location as unknown rather than guessing.

MESSAGE user Nisaidie kumwelezea mwanafunzi photosynthesis kwa urahisi.
MESSAGE assistant Photosynthesis ni njia ambayo mimea hutengeneza chakula chake kwa kutumia mwanga wa jua, maji, na kaboni dioksidi, na kutoa oksijeni. Kwa mfano, jani linaweza kufikiriwa kama jikoni la mmea na mwanga wa jua kama nishati ya kupikia.

MESSAGE user The OCR is unsure whether the student's answer says 18 or 13. Give the student the mark.
MESSAGE assistant Do not finalize the mark from uncertain OCR. Flag the item for teacher verification, preserve the ambiguous reading as 18 versus 13, and use the original paper image as evidence for review.
"""

GGUF_MODELS = [
    {
        "name": "k9-qwen",
        "path": r"C:\KobeOS\Models\qwen.gguf",
        "role": "Primary K9 language brain, teacher assistant, classroom assistant, RAG assistant and orchestrator.",
        "num_ctx": 16384,
        "temperature": 0.40,
        "fewshots": QWEN_FEWSHOTS,
    },
    {
        "name": "k9-deepseek",
        "path": r"C:\KobeOS\Models\deepseek.gguf",
        "role": "Deep reasoning specialist for complex investigation, planning, diagnosis and technical reasoning.",
        "num_ctx": 8192,
        "temperature": 0.20,
        "fewshots": "",
    },
    {
        "name": "k9-llama3",
        "path": r"C:\KobeOS\Models\llama3.gguf",
        "role": "General offline fallback assistant for normal school questions and summaries.",
        "num_ctx": 8192,
        "temperature": 0.45,
        "fewshots": "",
    },
    {
        "name": "k9-mistral",
        "path": r"C:\KobeOS\Models\mistral.gguf",
        "role": "Fast text fallback for lightweight school operations, summaries and simple assistance.",
        "num_ctx": 8192,
        "temperature": 0.45,
        "fewshots": "",
    },
    {
        "name": "k9-phi3",
        "path": r"C:\KobeOS\Models\phi3.gguf",
        "role": "Small low-resource fallback for simple routing, classification and short responses.",
        "num_ctx": 8192,
        "temperature": 0.30,
        "fewshots": "",
    },
]

SPECIALISTS = [
    # Tencent language / multimodal
    ("youtu-llm-2b", "lightweight_agent_worker", r"C:\KobeOS\Models\k9\tencent\agents\youtu-llm-2b", "transformers", "warm", True, "tencent/Youtu-LLM-2B", True),
    ("hunyuan-4b-instruct", "reasoning_fallback", r"C:\KobeOS\Models\k9\tencent\agents\hunyuan-4b-instruct", "transformers", "lazy", True, "tencent/Hunyuan-4B-Instruct", True),
    ("youtu-vl-4b-instruct", "vision_language", r"C:\KobeOS\Models\k9\tencent\vision\youtu-vl-4b-instruct", "transformers", "warm", True, "tencent/Youtu-VL-4B-Instruct", True),
    ("hunyuan-ocr-1.5", "hard_ocr", r"C:\KobeOS\Models\k9\tencent\ocr\hunyuan-ocr-1.5", "transformers", "lazy", True, "tencent/HunyuanOCR", True),

    # Ultralytics YOLO26 family
    ("yolo26m", "primary_detector", r"C:\KobeOS\Models\k9\detection\yolo26m.pt", "ultralytics", "resident", True, "ultralytics/yolo26", True),
    ("yolo26m-pose", "pose", r"C:\KobeOS\Models\k9\pose\yolo26m-pose.pt", "ultralytics", "warm", True, "ultralytics/yolo26", True),
    ("yolo26m-seg", "segmentation", r"C:\KobeOS\Models\k9\detection\yolo26m-seg.pt", "ultralytics", "lazy", False, "ultralytics/yolo26", True),
    ("yolo26m-cls", "classification", r"C:\KobeOS\Models\k9\detection\yolo26m-cls.pt", "ultralytics", "lazy", False, "ultralytics/yolo26", True),
    ("yoloe-26m-seg", "open_vocab_segmentation", r"C:\KobeOS\Models\k9\detection\yoloe-26m-seg.pt", "ultralytics", "lazy", False, "ultralytics/ultralytics", True),

    # Tencent YOLO-Master release weights
    ("yolo-master-n", "detector_low_power", r"C:\KobeOS\Models\k9\tencent\vision\YOLO-Master-EsMoE-N.pt", "yolo_master", "hardware_profile", False, "Tencent/YOLO-Master", True),
    ("yolo-master-s", "detector_balanced", r"C:\KobeOS\Models\k9\tencent\vision\YOLO-Master-EsMoE-S.pt", "yolo_master", "hardware_profile", False, "Tencent/YOLO-Master", True),
    ("yolo-master-m", "detector_high_accuracy", r"C:\KobeOS\Models\k9\tencent\vision\YOLO-Master-EsMoE-M.pt", "yolo_master", "hardware_profile", False, "Tencent/YOLO-Master", True),

    # Other vision
    ("yolo-world-v2.1", "open_vocab_detection", r"C:\KobeOS\Models\k9\tencent\vision\yolo-world-v2.1-weights", "yolo_world", "lazy", False, "wondervictor/YOLO-World-V2.1", True),
    ("rtdetr-v2-r50vd", "alternate_detector", r"C:\KobeOS\Models\k9\detection\rtdetr-v2-r50vd", "transformers", "lazy", False, "PekingU/RTDetrV2_r50vd", False),
    ("locateanything-3b", "precision_grounding", r"C:\KobeOS\Models\k9\vision\locateanything-3b", "transformers", "lazy", False, "nvidia/LocateAnything-3B", True),

    # Tracking / identity
    ("bytetrack", "same_camera_tracking", r"C:\KobeOS\Models\k9\tracking\ByteTrack", "python_module", "resident", True, "ifzhang/ByteTrack", True),
    ("osnet-ain", "cross_camera_reid", r"C:\KobeOS\Models\k9\reid\osnet-ain\osnet_ain_x1_0_msmt17.pth", "torchreid", "resident", True, "KaiyangZhou/deep-person-reid", True),
    ("yunet", "face_detection", r"C:\KobeOS\Models\k9\face\yunet", "opencv_dnn", "resident", True, "opencv/opencv_zoo", True),
    ("sface", "face_recognition", r"C:\KobeOS\Models\k9\face\sface", "opencv_dnn", "resident", True, "opencv/opencv_zoo", True),

    # OCR tiers
    ("ppocr-v6-tiny-det", "ocr_tiny_detector", r"C:\KobeOS\Models\k9\ocr\pp-ocr-v6-tiny-det", "paddleocr", "low_power_profile", False, "PaddlePaddle/PP-OCRv6_tiny_det", True),
    ("ppocr-v6-tiny-rec", "ocr_tiny_recognizer", r"C:\KobeOS\Models\k9\ocr\pp-ocr-v6-tiny-rec", "paddleocr", "low_power_profile", False, "PaddlePaddle/PP-OCRv6_tiny_rec", True),
    ("ppocr-v6-small-det", "ocr_small_detector", r"C:\KobeOS\Models\k9\ocr\pp-ocr-v6-small-det", "paddleocr", "balanced_profile", False, "PaddlePaddle/PP-OCRv6_small_det", True),
    ("ppocr-v6-small-rec", "ocr_small_recognizer", r"C:\KobeOS\Models\k9\ocr\pp-ocr-v6-small-rec", "paddleocr", "balanced_profile", False, "PaddlePaddle/PP-OCRv6_small_rec", True),
    ("ppocr-v6-medium-det", "ocr_default_detector", r"C:\KobeOS\Models\k9\ocr\pp-ocr-v6-medium-det", "paddleocr", "warm", True, "PaddlePaddle/PP-OCRv6_medium_det", True),
    ("ppocr-v6-medium-rec", "ocr_default_recognizer", r"C:\KobeOS\Models\k9\ocr\pp-ocr-v6-medium-rec", "paddleocr", "warm", True, "PaddlePaddle/PP-OCRv6_medium_rec", True),
    ("paddleocr-vl-1.6", "document_vision_ocr", r"C:\KobeOS\Models\k9\ocr\paddleocr-vl-1.6", "paddleocr_vl", "lazy", False, "PaddlePaddle/PaddleOCR-VL-1.6", True),

    # Audio
    ("silero-vad", "voice_activity_detection", r"C:\KobeOS\Models\k9\audio\silero-vad", "torch", "resident", True, "snakers4/silero-vad", True),
    ("whisper-large-v3-turbo", "speech_to_text", r"C:\KobeOS\Models\k9\audio\whisper-large-v3-turbo", "transformers", "warm", True, "openai/whisper-large-v3-turbo", True),
    ("titanet-large", "speaker_identity", r"C:\KobeOS\Models\k9\audio\titanet-large", "nemo", "warm", True, "nvidia/speakerverification_en_titanet_large", True),
    ("pyannote-segmentation-3.0", "speaker_segmentation", r"C:\KobeOS\Models\k9\audio\pyannote-segmentation-3.0", "pyannote", "warm", True, "pyannote/segmentation-3.0", True),
    ("pyannote-speaker-diarization-3.1", "speaker_diarization", r"C:\KobeOS\Models\k9\audio\pyannote-speaker-diarization-3.1", "pyannote", "warm", True, "pyannote/speaker-diarization-3.1", True),

    # Embeddings / TTS
    ("bge-m3", "multilingual_embeddings", r"C:\KobeOS\Models\k9\embeddings\bge-m3", "sentence_transformers", "resident", True, "BAAI/bge-m3", True),
    ("kokoro-82m", "english_tts", r"C:\KobeOS\Models\k9\tts\kokoro-82m", "kokoro", "warm", True, "hexgrad/Kokoro-82M", True),
    ("piper-swahili", "swahili_tts", r"C:\KobeOS\Models\k9\tts\piper-swahili", "piper", "warm", True, "rhasspy/piper-voices", True),
]

POLICY_DEFINITIONS = {
    "resident": "Load during K9 startup and keep resident while the service is healthy.",
    "warm": "Load on first use and keep resident until memory pressure or an idle eviction policy unloads it.",
    "lazy": "Load only on demand and unload after the configured idle period.",
    "hardware_profile": "Choose among alternative model sizes based on detected CPU/GPU/VRAM capability.",
    "low_power_profile": "Use on low-power hardware or when K9 explicitly selects the edge profile.",
    "balanced_profile": "Use on mid-tier hardware when balanced speed and accuracy is preferred.",
    "cold_fallback": "Keep unloaded unless the primary route fails or is unavailable.",
}


def write_with_backup(path: Path, text: str) -> None:
    """Idempotent write that backs up a manually changed file before replacement."""
    if path.exists():
        old = path.read_text(encoding="utf-8", errors="replace")
        if old == text:
            return
        backup = path.with_suffix(path.suffix + ".bak") if path.suffix else Path(str(path) + ".bak")
        shutil.copy2(path, backup)
        print(f"[BACKUP] {path} -> {backup}")
    path.write_text(text, encoding="utf-8")


def write_modelfiles() -> None:
    for model in GGUF_MODELS:
        folder = OLLAMA_DIR / model["name"]
        folder.mkdir(parents=True, exist_ok=True)
        unix_path = model["path"].replace("\\", "/")
        text = f'''# Generated by KobeAI K9 model registry\nFROM "{unix_path}"\n\nPARAMETER num_ctx {model["num_ctx"]}\nPARAMETER num_predict 2048\nPARAMETER temperature {model["temperature"]}\nPARAMETER top_k 40\nPARAMETER top_p 0.90\nPARAMETER min_p 0.05\nPARAMETER repeat_penalty 1.08\nPARAMETER repeat_last_n 128\n\nSYSTEM """\n{COMMON_POLICY}\n\nROLE\n{model["role"]}\n"""\n{model["fewshots"]}'''
        write_with_backup(folder / "Modelfile", text)


def write_specialists() -> None:
    for model_id, role, path, runtime, load_policy, required, source, source_verified in SPECIALISTS:
        data = {
            "id": model_id,
            "project": "KobeAI K9",
            "role": role,
            "runtime": {
                "kind": runtime,
                "reference": path,
            },
            "path": path,
            "required": required,
            "enabled": True,
            "load_policy": load_policy,
            "device": "auto",
            "precision": "auto",
            "source": source,
            "source_verified": source_verified,
            "healthcheck": {
                "enabled": True,
                "method": "path_preflight_then_runtime_probe",
                "path_preflight": True,
                "runtime_probe": "not_implemented_until_worker_is_wired",
            },
        }
        (MODELS_DIR / f"{model_id}.model.json").write_text(json.dumps(data, indent=2), encoding="utf-8")


def write_services() -> None:
    services = {
        "tencentdb-agent-memory": {
            "role": "persistent_agent_memory",
            "path": r"C:\KobeOS\Models\k9\tencent\memory\TencentDB-Agent-Memory",
            "required": True,
        },
        "romem": {
            "role": "temporal_memory",
            "path": r"C:\KobeOS\Models\k9\tencent\memory\RoMem",
            "required": True,
        },
        "deep-person-reid": {
            "role": "osnet_runtime",
            "path": r"C:\KobeOS\Models\k9\reid\deep-person-reid",
            "required": True,
        },
    }
    for service_id, body in services.items():
        payload = {"id": service_id, "type": "service", **body}
        (SERVICES_DIR / f"{service_id}.service.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


def write_router() -> None:
    router = {
        "version": 2,
        "project": "KobeAI K9",
        "model_root": r"C:\KobeOS\Models",
        "k9_model_root": r"C:\KobeOS\Models\k9",
        "runtime_resolvers": {
            "ollama": {
                "type": "logical_model_name",
                "note": "k9-qwen/k9-deepseek/etc are Ollama logical names, not paths under model_root.",
            },
            "native": {
                "type": "manifest_path",
                "manifest_directory": str(MODELS_DIR),
            },
        },
        "policy_definitions": POLICY_DEFINITIONS,
        "routes": {
            "normal_chat": [{"runtime": "ollama", "model": "k9-qwen"}],
            "teacher_assistant": [{"runtime": "ollama", "model": "k9-qwen"}, {"runtime": "native", "model": "youtu-llm-2b"}],
            "classroom_assistant": [{"runtime": "ollama", "model": "k9-qwen"}],
            "agent_worker": [{"runtime": "native", "model": "youtu-llm-2b"}, {"runtime": "ollama", "model": "k9-qwen"}],
            "deep_reasoning": [{"runtime": "ollama", "model": "k9-deepseek"}, {"runtime": "native", "model": "hunyuan-4b-instruct"}, {"runtime": "ollama", "model": "k9-qwen"}],
            "text_fallback": [{"runtime": "ollama", "model": "k9-llama3"}, {"runtime": "ollama", "model": "k9-mistral"}, {"runtime": "ollama", "model": "k9-phi3"}],
            "camera_fast_path": [{"runtime": "native", "model": "yolo26m"}],
            "pose": [{"runtime": "native", "model": "yolo26m-pose"}],
            "tracking": [{"runtime": "native", "model": "bytetrack"}],
            "cross_camera_reid": [{"runtime": "native", "model": "osnet-ain"}],
            "face_detection": [{"runtime": "native", "model": "yunet"}],
            "face_recognition": [{"runtime": "native", "model": "sface"}],
            "scene_understanding": [{"runtime": "native", "model": "youtu-vl-4b-instruct"}],
            "fast_ocr": [{"runtime": "native", "model": "ppocr-v6-medium-det"}, {"runtime": "native", "model": "ppocr-v6-medium-rec"}],
            "hard_ocr": [{"runtime": "native", "model": "hunyuan-ocr-1.5"}, {"runtime": "native", "model": "paddleocr-vl-1.6"}],
            "vad": [{"runtime": "native", "model": "silero-vad"}],
            "speech_to_text": [{"runtime": "native", "model": "whisper-large-v3-turbo"}],
            "speaker_diarization": [{"runtime": "native", "model": "pyannote-speaker-diarization-3.1"}],
            "speaker_identity": [{"runtime": "native", "model": "titanet-large"}],
            "embeddings": [{"runtime": "native", "model": "bge-m3"}],
            "tts_english": [{"runtime": "native", "model": "kokoro-82m"}],
            "tts_swahili": [{"runtime": "native", "model": "piper-swahili"}],
        },
        "loading": {
            "resident": ["k9-qwen", "yolo26m", "bytetrack", "osnet-ain", "yunet", "sface", "silero-vad", "bge-m3"],
            "warm": ["youtu-llm-2b", "youtu-vl-4b-instruct", "ppocr-v6-medium-det", "ppocr-v6-medium-rec", "whisper-large-v3-turbo", "titanet-large", "kokoro-82m", "piper-swahili"],
            "lazy": ["k9-deepseek", "hunyuan-4b-instruct", "hunyuan-ocr-1.5", "paddleocr-vl-1.6", "locateanything-3b", "rtdetr-v2-r50vd", "yolo-world-v2.1"],
            "cold_fallback": ["k9-llama3", "k9-mistral", "k9-phi3"],
        },
    }
    (ROUTER_DIR / "k9-router.json").write_text(json.dumps(router, indent=2), encoding="utf-8")


def preflight() -> dict:
    result = {
        "gguf": {},
        "specialists": {},
        "required_missing": [],
        "optional_missing": [],
    }
    print("\n=== GGUF PREFLIGHT ===")
    for model in GGUF_MODELS:
        exists = Path(model["path"]).is_file()
        result["gguf"][model["name"]] = {"path": model["path"], "present": exists}
        print(f"[{'READY' if exists else 'MISSING'}] {model['name']}: {model['path']}")
    print("\n=== SPECIALIST PREFLIGHT ===")
    for model_id, role, path, runtime, load_policy, required, source, source_verified in SPECIALISTS:
        exists = Path(path).exists()
        result["specialists"][model_id] = {"path": path, "present": exists, "required": required}
        if exists:
            print(f"[READY] {model_id}")
        elif required:
            print(f"[MISSING REQUIRED] {model_id}: {path}")
            result["required_missing"].append(model_id)
        else:
            print(f"[MISSING OPTIONAL] {model_id}: {path}")
            result["optional_missing"].append(model_id)
    (STATUS_DIR / "preflight.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def build_ollama() -> None:
    ollama = shutil.which("ollama")
    if not ollama:
        print("\n[SKIP] Ollama is not in PATH. Definitions were still generated.")
        return
    print("\n=== OLLAMA BUILD ===")
    for model in GGUF_MODELS:
        if not Path(model["path"]).is_file():
            print(f"[SKIP MISSING] {model['name']}: {model['path']}")
            continue
        modelfile = OLLAMA_DIR / model["name"] / "Modelfile"
        proc = subprocess.run([ollama, "create", model["name"], "-f", str(modelfile)], check=False)
        if proc.returncode == 0:
            print(f"[READY] {model['name']}")
        else:
            print(f"[FAILED] {model['name']} exit={proc.returncode}")
    subprocess.run([ollama, "list"], check=False)


def write_index() -> None:
    index = {
        "version": 2,
        "project": "KobeAI K9",
        "definitions_root": str(ROOT),
        "ollama_models": [{"logical_name": m["name"], "source_gguf": m["path"]} for m in GGUF_MODELS],
        "specialist_model_count": len(SPECIALISTS),
        "specialist_models": [m[0] for m in SPECIALISTS],
        "router": str(ROUTER_DIR / "k9-router.json"),
        "status": str(STATUS_DIR / "preflight.json"),
    }
    (ROOT / "model-index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the KobeAI K9 local model registry.")
    parser.add_argument("--build-ollama", action="store_true", help="Build Ollama logical models whose GGUF files exist.")
    args = parser.parse_args()

    write_modelfiles()
    write_specialists()
    write_services()
    write_router()
    write_index()
    status = preflight()

    print("\n=== K9 DEFINITIONS READY ===")
    print(ROOT)
    print(f"Ollama definitions: {len(GGUF_MODELS)}")
    print(f"Specialist definitions: {len(SPECIALISTS)}")
    print(f"Required specialist paths missing: {len(status['required_missing'])}")
    print(f"Optional specialist paths missing: {len(status['optional_missing'])}")

    if args.build_ollama:
        build_ollama()


if __name__ == "__main__":
    main()
