from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


def default_model_root() -> Path:
    configured = os.getenv("K9_MODEL_ROOT", "").strip()
    if configured:
        return Path(configured).expanduser()
    if os.name == "nt":
        return Path(r"C:\KobeOS\Models\k9")
    return Path("/models/k9")


@dataclass(frozen=True)
class ModelSpec:
    name: str
    task: str
    relative_path: str
    loader: str
    persistent: bool = False
    optional: bool = False
    notes: str = ""

    def path(self, root: Path) -> Path:
        return root / Path(self.relative_path)

    def to_dict(self, root: Path) -> dict:
        path = self.path(root)
        present = path.exists()
        complete = False
        if present:
            if path.is_file():
                complete = path.stat().st_size > 0
            else:
                complete = (
                    (path / ".k9_complete").exists()
                    or (path / ".git").exists()
                    or any(path.glob("*.onnx"))
                    or any(path.glob("*.pt"))
                    or any(path.glob("*.pth"))
                    or any(path.glob("*.safetensors"))
                    or any(path.glob("*.json"))
                    or any(path.glob("*.yaml"))
                )
        payload = asdict(self)
        payload.update(
            {
                "path": str(path),
                "present": present,
                "complete": complete,
            }
        )
        return payload


MODEL_SPECS: tuple[ModelSpec, ...] = (
    ModelSpec(
        "qwen-gguf",
        "chat",
        r"brain/existing/qwen.gguf",
        "llama_cpp",
        True,
        notes=(
            "K9 runtime-local path. On Windows, link the existing "
            r"C:\KobeOS\Models\qwen.gguf here instead of duplicating the file."
        ),
    ),
    ModelSpec("deepseek-gguf", "reasoning", r"brain/existing/deepseek.gguf", "llama_cpp"),
    ModelSpec("llama3-gguf", "chat", r"brain/existing/llama3.gguf", "llama_cpp"),
    ModelSpec("mistral-gguf", "chat", r"brain/existing/mistral.gguf", "llama_cpp"),
    ModelSpec("phi3-gguf", "chat", r"brain/existing/phi3.gguf", "llama_cpp"),
    ModelSpec("qwen3-vl-8b", "multimodal_reasoning", r"brain/qwen3-vl-8b", "transformers_vlm"),
    ModelSpec("youtu-llm-2b", "agent", r"tencent/agents/youtu-llm-2b", "transformers_text", True),
    ModelSpec("youtu-vl-4b", "vision_language", r"tencent/vision/youtu-vl-4b-instruct", "transformers_vlm", True),
    ModelSpec("hunyuan-ocr-1.5", "ocr", r"tencent/ocr/hunyuan-ocr-1.5", "transformers_vlm"),
    ModelSpec("tencentdb-agent-memory", "memory", r"tencent/memory/TencentDB-Agent-Memory", "python_plugin"),
    ModelSpec("romem", "memory", r"tencent/memory/RoMem", "python_plugin"),
    ModelSpec("yolo26m", "detection", r"detection/yolo26m.pt", "ultralytics", True),
    ModelSpec("yolo26m-pose", "pose", r"pose/yolo26m-pose.pt", "ultralytics", True),
    ModelSpec("bytetrack", "tracking", r"tracking/ByteTrack", "bytetrack", True),
    ModelSpec("osnet-ain", "reid", r"reid/osnet-ain", "osnet", True),
    ModelSpec("deep-person-reid", "reid_code", r"reid/deep-person-reid", "python_plugin"),
    ModelSpec("yunet", "face_detection", r"face/yunet", "opencv_yunet", True),
    ModelSpec("sface", "face_recognition", r"face/sface", "opencv_sface", True),
    ModelSpec("pp-ocr-v6-medium-det", "ocr_detection", r"ocr/pp-ocr-v6-medium-det", "paddle_component"),
    ModelSpec("pp-ocr-v6-medium-rec", "ocr_recognition", r"ocr/pp-ocr-v6-medium-rec", "paddle_component"),
    ModelSpec("silero-vad", "vad", r"audio/silero-vad", "silero", True),
    ModelSpec("whisper-large-v3-turbo", "asr", r"audio/whisper-large-v3-turbo", "transformers_asr", True),
    ModelSpec("titanet-large", "speaker_id", r"audio/titanet-large", "titanet"),
    ModelSpec("pyannote-segmentation-3.0", "speaker_segmentation", r"audio/pyannote-segmentation-3.0", "pyannote"),
    ModelSpec("pyannote-speaker-diarization-3.1", "diarization", r"audio/pyannote-speaker-diarization-3.1", "pyannote"),
    ModelSpec("bge-m3", "embedding", r"embeddings/bge-m3", "sentence_transformers", True),
    ModelSpec("kokoro-82m", "tts", r"tts/kokoro-82m", "kokoro"),
    ModelSpec("piper-swahili", "tts_sw", r"tts/piper-swahili", "piper", True),
    ModelSpec("rtdetr-v2-r50vd", "detection", r"detection/rtdetr-v2-r50vd", "transformers_detection", optional=True),
    ModelSpec("locateanything-3b", "grounding", r"vision/locateanything-3b", "transformers_vlm", optional=True),
    ModelSpec("paddleocr-vl-1.6", "ocr", r"ocr/paddleocr-vl-1.6", "transformers_vlm", optional=True),
)


BY_NAME = {spec.name: spec for spec in MODEL_SPECS}


CAPABILITY_ROUTES: dict[str, tuple[str, ...]] = {
    "chat": ("qwen-gguf", "youtu-llm-2b", "mistral-gguf", "llama3-gguf", "phi3-gguf"),
    "reasoning": ("deepseek-gguf", "qwen3-vl-8b"),
    "agent": ("youtu-llm-2b", "qwen-gguf"),
    "vision": ("youtu-vl-4b", "qwen3-vl-8b"),
    "multimodal_reasoning": ("qwen3-vl-8b", "youtu-vl-4b"),
    "ocr": ("hunyuan-ocr-1.5", "paddleocr-vl-1.6"),
    "detection": ("yolo26m", "rtdetr-v2-r50vd"),
    "pose": ("yolo26m-pose",),
    "tracking": ("bytetrack",),
    "reid": ("osnet-ain",),
    "face_detection": ("yunet",),
    "face_recognition": ("sface",),
    "asr": ("whisper-large-v3-turbo",),
    "vad": ("silero-vad",),
    "speaker_id": ("titanet-large",),
    "diarization": ("pyannote-speaker-diarization-3.1", "pyannote-segmentation-3.0"),
    "embedding": ("bge-m3",),
    "tts": ("piper-swahili", "kokoro-82m"),
}


def choose_model(capability: str, root: Path, requested: str | None = None) -> ModelSpec:
    if requested:
        spec = BY_NAME.get(requested)
        if not spec:
            raise KeyError(f"unknown_model:{requested}")
        if not spec.path(root).exists():
            raise FileNotFoundError(f"model_not_present:{requested}:{spec.path(root)}")
        return spec
    for name in CAPABILITY_ROUTES.get(capability, ()):
        spec = BY_NAME[name]
        if spec.path(root).exists():
            return spec
    raise FileNotFoundError(f"no_local_model_for_capability:{capability}")


def statuses(root: Path) -> Iterable[dict]:
    for spec in MODEL_SPECS:
        yield spec.to_dict(root)
