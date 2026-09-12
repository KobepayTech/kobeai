"""Capability routing for the FastAPI runtime (app.py).

Model *locations* are not defined here. Every path, every completeness rule and
every root comes from the one registry, config/k9-models.json, through
k9_models.Registry — the same file scripts/k9-models.mjs, the api-server and
services/k9-runtime/server.py read. This module only decides *which* model
answers a capability, and maps the runtime's model names onto registry ids.

To move a model, edit config/k9-models.json. To change routing, edit
CAPABILITY_ROUTES below.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

from k9_models import COMPLETE_MARKER, Registry

_registry: Registry | None = None


def registry() -> Registry:
    """The shared registry, loaded once."""
    global _registry
    if _registry is None:
        _registry = Registry()
    return _registry


def default_model_root() -> Path:
    """K9's model root. K9_MODEL_ROOT still wins so existing deployments keep working."""
    configured = os.getenv("K9_MODEL_ROOT", "").strip()
    if configured:
        return Path(configured).expanduser()
    return registry().roots["k9"]


@dataclass(frozen=True)
class ModelSpec:
    """One runtime-visible model. `registry_id` is its id in config/k9-models.json."""

    name: str
    task: str
    registry_id: str
    loader: str
    persistent: bool = False
    optional: bool = False
    notes: str = ""

    @property
    def relative_path(self) -> str:
        entry = registry().entry(self.registry_id)
        return str(entry["path"])

    def path(self, root: Path | None = None) -> Path:
        """Where the model lives, per the registry. `root` is accepted for
        compatibility with callers that pass one, and honoured only when it
        differs from the registry's own root (tests use a temporary tree)."""
        resolved = registry().path_of(self.registry_id)
        if root is None:
            return resolved
        k9_root = registry().roots["k9"]
        base = registry().roots[registry().entry(self.registry_id).get("root", "k9")]
        if Path(root) == base:
            return resolved
        # Re-root: keep the registry's relative layout under the given root.
        try:
            return Path(root) / resolved.relative_to(base)
        except ValueError:
            return Path(root) / resolved.relative_to(k9_root)

    def status(self, root: Path | None = None) -> str:
        """"ready" | "partial" | "missing", by the registry's rules."""
        if root is None:
            return registry().status(self.registry_id)
        path = self.path(root)
        if not path.exists():
            return "missing"
        # Same shape as Registry.status for a re-rooted copy: a file must be
        # non-empty; a folder must hold what the entry says to expect.
        entry = registry().entry(self.registry_id)
        if entry["kind"] == "file":
            return "ready" if path.stat().st_size > 0 else "partial"
        if entry["kind"] == "repo":
            return "ready" if (path / ".git").exists() else "partial"
        if entry["kind"] == "files":
            return "ready" if all(path.joinpath(*f.split("/")).exists() for f in entry["files"]) else "partial"
        import fnmatch

        names = os.listdir(path)
        expected = all(
            any(fnmatch.fnmatch(name.lower(), pattern.lower()) for name in names)
            for pattern in entry.get("expect", [])
        )
        # Downloads the K9 installer made are marked complete; folders installed
        # from outside it (Qwen) have no marker, so the expected files decide.
        marker_ok = entry["source"]["type"] == "external" or COMPLETE_MARKER in names
        return "ready" if names and expected and marker_ok else "partial"

    def to_dict(self, root: Path | None = None) -> dict:
        path = self.path(root)
        state = self.status(root)
        payload = asdict(self)
        payload.update(
            {
                "relative_path": self.relative_path,
                "path": str(path),
                "present": path.exists(),
                "complete": state == "ready",
                "status": state,
            }
        )
        return payload


# name used by app.py and the HTTP API  ->  registry id in config/k9-models.json
MODEL_SPECS: tuple[ModelSpec, ...] = (
    ModelSpec("qwen-gguf", "chat", "qwen", "llama_cpp", True, notes="KobeOS Qwen2.5-7B; first GGUF fallback brain"),
    ModelSpec("qwen3-vl-8b", "multimodal_reasoning", "qwen3_vl_8b", "transformers_vlm", True, notes="K9's brain: text and images"),
    ModelSpec("deepseek-gguf", "reasoning", "deepseek", "llama_cpp"),
    ModelSpec("llama3-gguf", "chat", "llama3", "llama_cpp"),
    ModelSpec("mistral-gguf", "chat", "mistral", "llama_cpp"),
    ModelSpec("phi3-gguf", "chat", "phi3", "llama_cpp"),
    ModelSpec("youtu-llm-2b", "agent", "youtu_llm_2b", "transformers_text", True),
    ModelSpec("hunyuan-4b-instruct", "reasoning", "hunyuan_4b_instruct", "transformers_text", notes="Tencent text/reasoning fallback"),
    ModelSpec("youtu-vl-4b", "vision_language", "youtu_vl_4b_instruct", "transformers_vlm", True),
    ModelSpec("hunyuan-ocr-1.5", "ocr", "hunyuan_ocr_1_5", "transformers_vlm"),
    ModelSpec("tencentdb-agent-memory", "memory", "tencentdb_agent_memory", "python_plugin"),
    ModelSpec("romem", "memory", "romem", "python_plugin"),
    ModelSpec("yolo26m", "detection", "yolo26m", "ultralytics", True),
    ModelSpec("yolo26m-pose", "pose", "yolo26m_pose", "ultralytics", True),
    ModelSpec("bytetrack", "tracking", "bytetrack", "bytetrack", True),
    ModelSpec("osnet-ain", "reid", "osnet_ain_x1_0_msmt17", "osnet", True),
    ModelSpec("deep-person-reid", "reid_code", "deep_person_reid", "python_plugin"),
    ModelSpec("yunet", "face_detection", "yunet", "opencv_yunet", True),
    ModelSpec("sface", "face_recognition", "sface", "opencv_sface", True),
    ModelSpec("pp-ocr-v6-medium-det", "ocr_detection", "pp_ocr_v6_medium_det", "paddle_component"),
    ModelSpec("pp-ocr-v6-medium-rec", "ocr_recognition", "pp_ocr_v6_medium_rec", "paddle_component"),
    ModelSpec("silero-vad", "vad", "silero_vad", "silero", True),
    ModelSpec("whisper-large-v3-turbo", "asr", "whisper_large_v3_turbo", "transformers_asr", True),
    ModelSpec("titanet-large", "speaker_id", "titanet_large", "titanet"),
    ModelSpec("pyannote-segmentation-3.0", "speaker_segmentation", "pyannote_segmentation_3_0", "pyannote"),
    ModelSpec("pyannote-speaker-diarization-3.1", "diarization", "pyannote_speaker_diarization_3_1", "pyannote"),
    ModelSpec("bge-m3", "embedding", "bge_m3", "sentence_transformers", True),
    ModelSpec("kokoro-82m", "tts", "kokoro_82m", "kokoro"),
    ModelSpec("piper-swahili", "tts_sw", "piper_swahili", "piper", True),
    ModelSpec("rtdetr-v2-r50vd", "detection", "rtdetr_v2_r50vd", "transformers_detection", optional=True),
    ModelSpec("locateanything-3b", "grounding", "locate_anything_3b", "transformers_vlm", optional=True),
    ModelSpec("paddleocr-vl-1.6", "ocr", "paddleocr_vl_1_6", "transformers_vlm", optional=True),
)


BY_NAME = {spec.name: spec for spec in MODEL_SPECS}


# The brain leads the text routes: Qwen3-VL reads images too, so it also heads
# vision. Every list is "best first"; an incomplete model is skipped.
CAPABILITY_ROUTES: dict[str, tuple[str, ...]] = {
    "chat": ("qwen3-vl-8b", "qwen-gguf", "youtu-llm-2b", "mistral-gguf", "llama3-gguf", "phi3-gguf"),
    "reasoning": ("deepseek-gguf", "qwen3-vl-8b", "hunyuan-4b-instruct", "qwen-gguf"),
    "agent": ("youtu-llm-2b", "qwen3-vl-8b", "qwen-gguf"),
    "vision": ("qwen3-vl-8b", "youtu-vl-4b"),
    "multimodal_reasoning": ("qwen3-vl-8b", "youtu-vl-4b"),
    "ocr": ("qwen3-vl-8b", "hunyuan-ocr-1.5", "paddleocr-vl-1.6"),
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
    "tts": ("kokoro-82m", "piper-swahili"),
}


def choose_model(capability: str, root: Path | None = None, requested: str | None = None) -> ModelSpec:
    """The best model for a capability that is actually ready to load.

    A model that is merely present is not enough: a folder holding only a README
    (a gated download that never finished) would be chosen and then fail to load.
    """
    if requested:
        spec = BY_NAME.get(requested)
        if not spec:
            raise KeyError(f"unknown_model:{requested}")
        state = spec.status(root)
        if state != "ready":
            raise FileNotFoundError(f"model_not_ready:{requested}:{state}:{spec.path(root)}")
        return spec
    for name in CAPABILITY_ROUTES.get(capability, ()):
        spec = BY_NAME[name]
        if spec.status(root) == "ready":
            return spec
    raise FileNotFoundError(f"no_local_model_for_capability:{capability}")


def statuses(root: Path | None = None) -> Iterable[dict]:
    for spec in MODEL_SPECS:
        yield spec.to_dict(root)
