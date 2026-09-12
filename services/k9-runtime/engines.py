"""Model engines for the K9 runtime.

Every weight and code path comes from the K9 registry (config/k9-models.json)
through k9_models.Registry. Engines load lazily on first use, so memory is only
spent on the models a school actually calls. Models the runtime can't run yet
are still listed, with exactly what they need.
"""

from __future__ import annotations

import importlib.util
import inspect
import io
import os
import threading
import time
import wave
from pathlib import Path
from typing import Any

import numpy as np

from k9_models import Registry


class EngineUnavailable(RuntimeError):
    """The engine can't run on this machine: a package or model is missing."""


def _cpu_threads() -> int:
    return max(1, (os.cpu_count() or 2) // 2)


class Engine:
    name = ""
    models: tuple[str, ...] = ()
    requires: tuple[str, ...] = ()
    note = ""

    def __init__(self, registry: Registry):
        self.registry = registry
        self._load_lock = threading.Lock()
        self._model: Any = None
        self.error: str | None = None

    def missing_packages(self) -> list[str]:
        return [package for package in self.requires if importlib.util.find_spec(package) is None]

    def missing_models(self) -> list[str]:
        return [model_id for model_id in self.models if self.registry.status(model_id) != "ready"]

    def state(self) -> str:
        if self.missing_packages():
            return "blocked"
        if self.missing_models():
            return "missing"
        if self._model is not None:
            return "loaded"
        return "error" if self.error else "available"

    def describe(self) -> dict[str, Any]:
        return {
            "state": self.state(),
            "models": list(self.models),
            "needs_packages": self.missing_packages(),
            "missing_models": self.missing_models(),
            "error": self.error,
            "note": self.note,
        }

    def model(self) -> Any:
        with self._load_lock:
            if self._model is None:
                needs = self.missing_packages()
                if needs:
                    raise EngineUnavailable(f"{self.name} needs Python packages that aren't installed: {', '.join(needs)}")
                missing = self.missing_models()
                if missing:
                    raise EngineUnavailable(f"{self.name} is missing models: {', '.join(missing)}")
                try:
                    self._model = self.load()
                    self.error = None
                except Exception as exc:
                    self.error = f"{type(exc).__name__}: {exc}"
                    raise
            return self._model

    def load(self) -> Any:
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Vision: YOLO26 detection / segmentation / classification / pose
# ---------------------------------------------------------------------------


class YoloEngine(Engine):
    requires = ("ultralytics", "torch")

    def __init__(self, registry: Registry, name: str, model_id: str, task: str):
        super().__init__(registry)
        self.name = name
        self.models = (model_id,)
        self.task = task
        self.note = f"Ultralytics YOLO26 {task}"
        self._infer_lock = threading.Lock()

    def load(self) -> Any:
        import torch
        from ultralytics import YOLO

        torch.set_num_threads(_cpu_threads())
        return YOLO(str(self.registry.weights_of(self.models[0])), task=self.task)

    def predict(self, image: np.ndarray, conf: float = 0.25, imgsz: int = 640) -> Any:
        model = self.model()
        with self._infer_lock:
            return model.predict(image, conf=conf, imgsz=imgsz, verbose=False)[0]


def serialize_result(result: Any, task: str, max_polygon_points: int = 64) -> dict[str, Any]:
    names = result.names
    if task == "classify":
        probs = result.probs
        return {
            "top": [
                {"cls": int(i), "label": names[int(i)], "conf": round(float(probs.data[int(i)]), 4)}
                for i in probs.top5
            ]
        }

    detections: list[dict[str, Any]] = []
    boxes = result.boxes
    if boxes is None or len(boxes) == 0:
        return {"detections": detections}
    xyxy = boxes.xyxy.cpu().numpy()
    confs = boxes.conf.cpu().numpy()
    classes = boxes.cls.cpu().numpy().astype(int)
    for i in range(len(xyxy)):
        item: dict[str, Any] = {
            "box": [round(float(v), 1) for v in xyxy[i]],
            "conf": round(float(confs[i]), 4),
            "cls": int(classes[i]),
            "label": names[int(classes[i])],
        }
        if task == "segment" and result.masks is not None:
            polygon = result.masks.xy[i]
            step = max(1, len(polygon) // max_polygon_points)
            item["polygon"] = [[round(float(px), 1), round(float(py), 1)] for px, py in polygon[::step]]
        if task == "pose" and result.keypoints is not None:
            item["keypoints"] = [
                [round(float(kx), 1), round(float(ky), 1), round(float(kc), 3)]
                for kx, ky, kc in result.keypoints.data[i].cpu().numpy()
            ]
        detections.append(item)
    return {"detections": detections}


# ---------------------------------------------------------------------------
# Tracking: ByteTrack per camera
# ---------------------------------------------------------------------------


class TrackingEngine(Engine):
    name = "tracking"
    requires = ("ultralytics", "torch", "scipy")
    note = "ByteTrack (Ultralytics implementation) over YOLO26m detections, one tracker per camera"
    IDLE_SECONDS = 600

    def __init__(self, registry: Registry, detector: YoloEngine):
        super().__init__(registry)
        self.detector = detector
        self.models = detector.models + ("bytetrack",)
        self._trackers: dict[str, tuple[Any, float]] = {}
        self._track_lock = threading.Lock()

    def load(self) -> Any:
        from ultralytics.utils.checks import check_yaml

        try:
            from ultralytics.utils import YAML

            return YAML.load(check_yaml("bytetrack.yaml"))
        except ImportError:
            from ultralytics.utils import yaml_load

            return yaml_load(check_yaml("bytetrack.yaml"))

    def track(self, camera_id: str, image: np.ndarray, conf: float = 0.25, frame_rate: int = 30) -> list[dict[str, Any]]:
        from ultralytics.trackers.byte_tracker import BYTETracker
        from ultralytics.utils import IterableSimpleNamespace

        settings = self.model()
        result = self.detector.predict(image, conf=conf)
        detections = result.boxes.cpu().numpy()
        with self._track_lock:
            now = time.time()
            for camera, (_, seen) in list(self._trackers.items()):
                if now - seen > self.IDLE_SECONDS:
                    del self._trackers[camera]
            tracker = self._trackers.get(camera_id, (None, 0.0))[0]
            if tracker is None:
                # Ultralytics 8.4 reads frame_rate from args; older releases take it as a keyword.
                args = IterableSimpleNamespace(**{**settings, "frame_rate": frame_rate})
                if "frame_rate" in inspect.signature(BYTETracker).parameters:
                    tracker = BYTETracker(args, frame_rate=frame_rate)
                else:
                    tracker = BYTETracker(args)
            self._trackers[camera_id] = (tracker, now)
            if len(detections) == 0:
                return []
            tracks = tracker.update(detections, result.orig_img)
        names = result.names
        return [
            {
                "track_id": int(t[4]),
                "box": [round(float(v), 1) for v in t[:4]],
                "conf": round(float(t[5]), 4),
                "cls": int(t[6]),
                "label": names[int(t[6])],
            }
            for t in tracks
        ]


# ---------------------------------------------------------------------------
# Faces: YuNet detection + SFace embeddings
# ---------------------------------------------------------------------------


class FaceEngine(Engine):
    name = "faces"
    models = ("yunet", "sface")
    requires = ("cv2",)
    note = "YuNet face detection + SFace 128-d face embeddings (OpenCV)"
    MATCH_COSINE = 0.363  # OpenCV's recommended SFace cosine threshold

    def load(self) -> Any:
        import cv2

        detector = cv2.FaceDetectorYN.create(str(self.registry.weights_of("yunet")), "", (320, 320), 0.8, 0.3, 5000)
        recognizer = cv2.FaceRecognizerSF.create(str(self.registry.weights_of("sface")), "")
        return detector, recognizer, threading.Lock()

    def detect(self, image: np.ndarray, embed: bool = True) -> list[dict[str, Any]]:
        detector, recognizer, lock = self.model()
        height, width = image.shape[:2]
        faces_out: list[dict[str, Any]] = []
        with lock:
            detector.setInputSize((width, height))
            _, faces = detector.detect(image)
            for face in faces if faces is not None else []:
                x, y, w, h = (float(v) for v in face[:4])
                item: dict[str, Any] = {
                    "box": [round(x, 1), round(y, 1), round(x + w, 1), round(y + h, 1)],
                    "score": round(float(face[14]), 4),
                    "landmarks": [[round(float(face[4 + 2 * i]), 1), round(float(face[5 + 2 * i]), 1)] for i in range(5)],
                }
                if embed:
                    feature = recognizer.feature(recognizer.alignCrop(image, face)).reshape(-1)
                    feature = feature / (np.linalg.norm(feature) or 1.0)
                    item["embedding"] = [round(float(v), 6) for v in feature]
                faces_out.append(item)
        return faces_out

    @classmethod
    def match(cls, a: Any, b: Any) -> dict[str, Any]:
        va = np.asarray(a, dtype=np.float32).reshape(-1)
        vb = np.asarray(b, dtype=np.float32).reshape(-1)
        if va.size == 0 or va.shape != vb.shape:
            raise ValueError("a and b must be embeddings of the same length")
        cosine = float(np.dot(va, vb) / ((np.linalg.norm(va) * np.linalg.norm(vb)) or 1.0))
        return {"cosine": round(cosine, 4), "same_person": cosine >= cls.MATCH_COSINE, "threshold": cls.MATCH_COSINE}


# ---------------------------------------------------------------------------
# Person re-identification: OSNet-AIN
# ---------------------------------------------------------------------------

_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class ReIDEngine(Engine):
    name = "reid"
    models = ("deep_person_reid", "osnet_ain_x1_0_msmt17")
    requires = ("torch", "cv2")
    note = "OSNet-AIN x1.0 (MSMT17) 512-d person re-identification embeddings"

    def load(self) -> Any:
        import torch

        torch.set_num_threads(_cpu_threads())
        spec = importlib.util.spec_from_file_location("k9_osnet_ain", self.registry.code_of("deep_person_reid"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        checkpoint = torch.load(self.registry.weights_of("osnet_ain_x1_0_msmt17"), map_location="cpu", weights_only=False)
        state = checkpoint.get("state_dict", checkpoint) if isinstance(checkpoint, dict) else checkpoint
        state = {key.removeprefix("module."): value for key, value in state.items()}
        model = module.osnet_ain_x1_0(num_classes=state["classifier.weight"].shape[0], pretrained=False, loss="softmax")
        model.load_state_dict(state, strict=True)
        model.eval()
        return model, threading.Lock()

    def embed(self, image: np.ndarray, boxes: list[list[float]] | None = None) -> list[list[float]]:
        import cv2
        import torch

        model, lock = self.model()
        height, width = image.shape[:2]
        crops = []
        for box in boxes or [[0, 0, width, height]]:
            if len(box) != 4:
                raise ValueError("each box must be [x1, y1, x2, y2]")
            x1, y1 = max(0, int(box[0])), max(0, int(box[1]))
            x2, y2 = min(width, int(box[2])), min(height, int(box[3]))
            if x2 - x1 < 4 or y2 - y1 < 4:
                raise ValueError(f"box is too small: {[x1, y1, x2, y2]}")
            crop = cv2.cvtColor(cv2.resize(image[y1:y2, x1:x2], (128, 256)), cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
            crops.append((crop - _IMAGENET_MEAN) / _IMAGENET_STD)
        batch = torch.from_numpy(np.stack(crops).transpose(0, 3, 1, 2)).float()
        with lock, torch.inference_mode():
            features = torch.nn.functional.normalize(model(batch), dim=1).numpy()
        return [[round(float(v), 6) for v in feature] for feature in features]


# ---------------------------------------------------------------------------
# Audio: Silero voice activity detection
# ---------------------------------------------------------------------------


def read_wav_mono(data: bytes, rate: int = 16000) -> np.ndarray:
    with wave.open(io.BytesIO(data)) as wav:
        if wav.getsampwidth() != 2:
            raise ValueError("audio must be 16-bit PCM WAV")
        channels, source_rate = wav.getnchannels(), wav.getframerate()
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if source_rate != rate and samples.size:
        duration = samples.size / source_rate
        samples = np.interp(np.linspace(0, duration, int(duration * rate), endpoint=False), np.arange(samples.size) / source_rate, samples)
    return samples.astype(np.float32)


def speech_segments(probs: list[float], window: int, rate: int, total_samples: int, threshold: float = 0.5,
                    min_speech_ms: int = 250, min_silence_ms: int = 100, pad_ms: int = 30) -> list[dict[str, float]]:
    negative = max(threshold - 0.15, 0.01)
    min_speech = rate * min_speech_ms / 1000
    min_silence = rate * min_silence_ms / 1000
    pad = rate * pad_ms / 1000
    spans: list[tuple[float, float]] = []
    start: float | None = None
    silence_from: float | None = None
    for index, prob in enumerate(probs):
        position = index * window
        if prob >= threshold:
            silence_from = None
            if start is None:
                start = position
        elif start is not None and prob < negative:
            if silence_from is None:
                silence_from = position
            if position - silence_from >= min_silence:
                if silence_from - start >= min_speech:
                    spans.append((start, silence_from))
                start, silence_from = None, None
    if start is not None and total_samples - start >= min_speech:
        spans.append((start, total_samples))
    return [
        {"start": round(max(0.0, s - pad) / rate, 3), "end": round(min(total_samples, e + pad) / rate, 3)}
        for s, e in spans
    ]


class VADEngine(Engine):
    name = "vad"
    models = ("silero_vad",)
    requires = ("torch",)
    note = "Silero VAD speech segments (16 kHz)"
    RATE = 16000
    WINDOW = 512

    def load(self) -> Any:
        import torch

        model = torch.jit.load(str(self.registry.weights_of("silero_vad")), map_location="cpu")
        model.eval()
        return model, threading.Lock()

    def segments(self, wav_bytes: bytes, threshold: float = 0.5) -> tuple[list[dict[str, float]], float]:
        import torch

        audio = read_wav_mono(wav_bytes, self.RATE)
        model, lock = self.model()
        probs: list[float] = []
        with lock, torch.inference_mode():
            model.reset_states()
            for start in range(0, len(audio), self.WINDOW):
                chunk = audio[start:start + self.WINDOW]
                if len(chunk) < self.WINDOW:
                    chunk = np.pad(chunk, (0, self.WINDOW - len(chunk)))
                probs.append(float(model(torch.from_numpy(chunk).unsqueeze(0), self.RATE).item()))
        return speech_segments(probs, self.WINDOW, self.RATE, len(audio), threshold), round(len(audio) / self.RATE, 3)


# ---------------------------------------------------------------------------
# Models the runtime lists but cannot run yet
# ---------------------------------------------------------------------------


class PlannedEngine(Engine):
    def __init__(self, registry: Registry, name: str, models: tuple[str, ...], requires: tuple[str, ...], note: str):
        super().__init__(registry)
        self.name, self.models, self.requires, self.note = name, models, requires, note

    def state(self) -> str:
        return "blocked" if self.missing_packages() else "not_integrated"

    def load(self) -> Any:
        raise EngineUnavailable(f"{self.name} is not integrated in the K9 runtime yet")


PLANNED_ENGINES: tuple[tuple[str, tuple[str, ...], tuple[str, ...], str], ...] = (
    ("open_vocabulary", ("yoloe_26m_seg",), (), "YOLOE open-prompt segmentation needs a MobileCLIP text encoder that isn't in the registry"),
    ("ocr", ("pp_ocr_v6_medium_det", "pp_ocr_v6_medium_rec"), ("paddleocr",), "PP-OCRv6 paper and board text (Paddle inference models)"),
    ("speech_to_text", ("whisper_large_v3_turbo",), ("transformers",), "Whisper large-v3-turbo transcription"),
    ("speaker_id", ("titanet_large",), ("nemo",), "TitaNet enrolled speaker recognition (.nemo)"),
    ("diarization", ("pyannote_segmentation_3_0", "pyannote_speaker_diarization_3_1"), ("pyannote",), "who spoke when (gated models)"),
    ("embeddings", ("bge_m3",), ("transformers",), "BGE-M3 school knowledge retrieval"),
    ("tts_english", ("kokoro_82m",), ("kokoro",), "Kokoro English voice"),
    ("tts_swahili", ("piper_swahili",), ("piper",), "Piper Swahili voice"),
    ("agents", ("youtu_llm_2b", "hunyuan_4b_instruct"), ("transformers", "accelerate"), "Tencent agent models (safetensors)"),
    ("vision_language", ("youtu_vl_4b_instruct",), ("transformers", "accelerate"), "Youtu-VL camera and frame questions"),
    ("hard_ocr", ("hunyuan_ocr_1_5",), ("transformers", "accelerate"), "HunyuanOCR difficult handwriting and layouts"),
    ("memory", ("tencentdb_agent_memory", "romem"), (), "agent memory services"),
)


def build_engines(registry: Registry) -> dict[str, Engine]:
    detector = YoloEngine(registry, "detect", "yolo26m", "detect")
    engines: dict[str, Engine] = {
        "detect": detector,
        "segment": YoloEngine(registry, "segment", "yolo26m_seg", "segment"),
        "classify": YoloEngine(registry, "classify", "yolo26m_cls", "classify"),
        "pose": YoloEngine(registry, "pose", "yolo26m_pose", "pose"),
        "tracking": TrackingEngine(registry, detector),
        "faces": FaceEngine(registry),
        "reid": ReIDEngine(registry),
        "vad": VADEngine(registry),
    }
    for name, models, requires, note in PLANNED_ENGINES:
        engines[name] = PlannedEngine(registry, name, models, requires, note)
    return engines
