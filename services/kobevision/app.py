from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import httpx
import numpy as np
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile

logger = logging.getLogger("kobevision")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

APP_VERSION = "kobevision-1"
MODEL_PACK = os.getenv("VISION_MODEL_PACK", "antelopev2").strip()
MODEL_ROOT = Path(os.getenv("VISION_MODEL_ROOT", "/state/insightface")).expanduser()
TEMPLATE_PATH = Path(os.getenv("VISION_TEMPLATE_STORE", "/state/templates.enc"))
MATCH_THRESHOLD = float(os.getenv("VISION_MATCH_THRESHOLD", "0.60"))
DETECTION_THRESHOLD = float(os.getenv("VISION_DETECTION_THRESHOLD", "0.60"))
DET_SIZE = int(os.getenv("VISION_DET_SIZE", "640"))
EXECUTION_PROVIDER = os.getenv("VISION_EXECUTION_PROVIDER", "CUDAExecutionProvider").strip()
KOBEAI_BASE_URL = os.getenv("KOBEAI_BASE_URL", "http://backend:8000").rstrip("/")
SERVICE_SECRET = os.getenv("KOBEVISION_SHARED_SECRET", "").strip()
EVENT_DEDUP_SECONDS = max(1.0, float(os.getenv("VISION_EVENT_DEDUP_SECONDS", "15")))
CAMERA_SAMPLE_FPS = max(0.1, float(os.getenv("VISION_CAMERA_SAMPLE_FPS", "1.0")))

app = FastAPI(title="KobeVision", version=APP_VERSION)


def _constant_time_equal(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    import hmac

    return hmac.compare_digest(a.encode(), b.encode())


def require_secret(
    authorization: str | None = Header(default=None),
    x_kobevision_secret: str | None = Header(default=None),
) -> None:
    if not SERVICE_SECRET:
        raise HTTPException(status_code=503, detail="KOBEVISION_SHARED_SECRET is not configured")
    supplied = x_kobevision_secret or ""
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()
    if not supplied or not _constant_time_equal(SERVICE_SECRET, supplied):
        raise HTTPException(status_code=401, detail="invalid KobeVision service credential")


def _normalize(embedding: np.ndarray) -> np.ndarray:
    vector = embedding.astype(np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    if norm <= 0:
        raise ValueError("zero_length_embedding")
    return vector / norm


class TemplateStore:
    """Encrypted local face-template store.

    Only normalized embeddings, student codes, consent metadata and sample counts
    are persisted. Raw enrollment photos are never written to disk by KobeVision.
    """

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._records: dict[str, dict[str, Any]] = {}
        self._codes: list[str] = []
        self._matrix = np.zeros((0, 512), dtype=np.float32)
        self._fernet = self._build_fernet()
        self._load()

    def _build_fernet(self) -> Fernet | None:
        key = os.getenv("VISION_TEMPLATE_KEY", "").strip()
        if not key:
            logger.warning("VISION_TEMPLATE_KEY is unset; enrollment and recognition will remain disabled")
            return None
        try:
            return Fernet(key.encode())
        except Exception as exc:
            raise RuntimeError("VISION_TEMPLATE_KEY must be a valid Fernet key") from exc

    @property
    def ready(self) -> bool:
        return self._fernet is not None

    def _load(self) -> None:
        if not self.path.exists():
            self._rebuild_index()
            return
        if not self._fernet:
            logger.warning("Encrypted template store exists but no key is configured")
            return
        try:
            raw = self._fernet.decrypt(self.path.read_bytes())
            payload = json.loads(raw.decode("utf-8"))
            if isinstance(payload, dict):
                self._records = payload
            self._rebuild_index()
        except (InvalidToken, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError("Unable to decrypt or parse the KobeVision template store") from exc

    def _save(self) -> None:
        if not self._fernet:
            raise RuntimeError("VISION_TEMPLATE_KEY is required before storing biometric templates")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        clear = json.dumps(self._records, separators=(",", ":")).encode("utf-8")
        encrypted = self._fernet.encrypt(clear)
        temp = self.path.with_suffix(self.path.suffix + ".tmp")
        temp.write_bytes(encrypted)
        os.replace(temp, self.path)

    def _rebuild_index(self) -> None:
        codes: list[str] = []
        embeddings: list[np.ndarray] = []
        for code, record in self._records.items():
            embedding = record.get("embedding")
            if not isinstance(embedding, list):
                continue
            vector = np.asarray(embedding, dtype=np.float32)
            if vector.ndim != 1 or vector.size == 0:
                continue
            codes.append(code)
            embeddings.append(_normalize(vector))
        self._codes = codes
        if embeddings:
            self._matrix = np.vstack(embeddings).astype(np.float32)
        else:
            self._matrix = np.zeros((0, 512), dtype=np.float32)

    def enroll(self, student_code: str, embedding: np.ndarray, consent_status: str) -> dict[str, Any]:
        if consent_status.lower() != "granted":
            raise ValueError("biometric_consent_must_be_granted")
        if not self._fernet:
            raise RuntimeError("VISION_TEMPLATE_KEY is required before enrollment")
        code = student_code.strip()
        if not code:
            raise ValueError("student_code_required")
        vector = _normalize(embedding)
        with self._lock:
            existing = self._records.get(code)
            previous_count = int(existing.get("sample_count", 0)) if existing else 0
            if existing and isinstance(existing.get("embedding"), list):
                old = _normalize(np.asarray(existing["embedding"], dtype=np.float32))
                # Keep a stable centroid while allowing additional enrollment angles.
                vector = _normalize(old * min(previous_count, 4) + vector)
            sample_count = min(previous_count + 1, 5)
            self._records[code] = {
                "embedding": vector.tolist(),
                "sample_count": sample_count,
                "consent_status": "granted",
                "updated_at": time.time(),
                "model_pack": MODEL_PACK,
            }
            self._save()
            self._rebuild_index()
            return {
                "student_code": code,
                "sample_count": sample_count,
                "model_pack": MODEL_PACK,
            }

    def delete(self, student_code: str) -> bool:
        with self._lock:
            removed = self._records.pop(student_code, None)
            if removed is None:
                return False
            self._save()
            self._rebuild_index()
            return True

    def match(self, embedding: np.ndarray) -> tuple[str | None, float]:
        vector = _normalize(embedding)
        with self._lock:
            if self._matrix.shape[0] == 0:
                return None, 0.0
            scores = self._matrix @ vector
            index = int(np.argmax(scores))
            score = float(scores[index])
            if score < MATCH_THRESHOLD:
                return None, score
            return self._codes[index], score

    def count(self) -> int:
        with self._lock:
            return len(self._codes)


class FaceEngine:
    def __init__(self):
        self._lock = threading.RLock()
        self._analysis = None
        self._error: str | None = None

    @property
    def ready(self) -> bool:
        return self._analysis is not None

    @property
    def error(self) -> str | None:
        return self._error

    def load(self) -> None:
        with self._lock:
            if self._analysis is not None:
                return
            pack_dir = MODEL_ROOT / "models" / MODEL_PACK
            if not pack_dir.exists():
                self._error = (
                    f"Model pack not found at {pack_dir}. KobeAI does not auto-download face "
                    "models because production deployment must use properly licensed weights."
                )
                logger.warning(self._error)
                return
            try:
                from insightface.app import FaceAnalysis

                providers = [EXECUTION_PROVIDER]
                if EXECUTION_PROVIDER != "CPUExecutionProvider":
                    providers.append("CPUExecutionProvider")
                analysis = FaceAnalysis(
                    name=MODEL_PACK,
                    root=str(MODEL_ROOT),
                    providers=providers,
                    allowed_modules=["detection", "recognition"],
                )
                ctx_id = -1 if EXECUTION_PROVIDER == "CPUExecutionProvider" else 0
                analysis.prepare(ctx_id=ctx_id, det_size=(DET_SIZE, DET_SIZE), det_thresh=DETECTION_THRESHOLD)
                self._analysis = analysis
                self._error = None
                logger.info("Loaded face model pack %s with providers %s", MODEL_PACK, providers)
            except Exception as exc:
                self._error = f"Failed to load face model: {exc}"
                logger.exception(self._error)

    def faces(self, frame: np.ndarray):
        if self._analysis is None:
            self.load()
        if self._analysis is None:
            raise RuntimeError(self._error or "face_model_not_ready")
        with self._lock:
            return self._analysis.get(frame)


store = TemplateStore(TEMPLATE_PATH)
engine = FaceEngine()


def decode_image(data: bytes) -> np.ndarray:
    array = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("invalid_image")
    return image


def recognize_frame(frame: np.ndarray) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for face in engine.faces(frame):
        det_score = float(getattr(face, "det_score", 0.0) or 0.0)
        embedding = getattr(face, "normed_embedding", None)
        if embedding is None or det_score < DETECTION_THRESHOLD:
            continue
        student_code, score = store.match(np.asarray(embedding, dtype=np.float32))
        bbox = getattr(face, "bbox", None)
        results.append(
            {
                "student_code": student_code,
                "match_score": score,
                "det_score": det_score,
                "bbox": [float(x) for x in bbox] if bbox is not None else None,
            }
        )
    return results


def post_presence_event(camera_id: str, match: dict[str, Any], captured_at: float) -> None:
    student_code = match.get("student_code")
    if not student_code:
        return
    if not SERVICE_SECRET:
        logger.error("Cannot post presence event: KOBEVISION_SHARED_SECRET is not configured")
        return
    payload = {
        "student_code": student_code,
        "camera_id": camera_id,
        "confidence": float(match["match_score"]),
        "face_quality": float(match["det_score"]),
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(captured_at)),
        "model_version": f"insightface:{MODEL_PACK}",
        "metadata": {"vision_service": APP_VERSION},
    }
    try:
        with httpx.Client(timeout=4.0) as client:
            response = client.post(
                f"{KOBEAI_BASE_URL}/api/v1/presence/event",
                headers={"x-kobevision-secret": SERVICE_SECRET},
                json=payload,
            )
            response.raise_for_status()
    except Exception as exc:
        logger.warning("Presence event post failed for %s on %s: %s", student_code, camera_id, exc)


@dataclass
class CameraConfig:
    camera_id: str
    url: str
    sample_fps: float = CAMERA_SAMPLE_FPS


class CameraSupervisor:
    def __init__(self):
        self._threads: list[threading.Thread] = []
        self._stopping = threading.Event()
        self._dedup_lock = threading.Lock()
        self._last_event: dict[tuple[str, str], float] = {}

    def configs(self) -> list[CameraConfig]:
        raw = os.getenv("VISION_CAMERAS_JSON", "").strip()
        if not raw:
            return []
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            logger.error("VISION_CAMERAS_JSON is invalid JSON: %s", exc)
            return []
        if not isinstance(payload, list):
            logger.error("VISION_CAMERAS_JSON must be a JSON list")
            return []
        configs: list[CameraConfig] = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            camera_id = str(item.get("camera_id", "")).strip()
            url = str(item.get("url", "")).strip()
            if not camera_id or not url:
                continue
            sample_fps = max(0.1, float(item.get("sample_fps", CAMERA_SAMPLE_FPS)))
            configs.append(CameraConfig(camera_id=camera_id, url=url, sample_fps=sample_fps))
        return configs

    def start(self) -> None:
        for config in self.configs():
            thread = threading.Thread(
                target=self._run_camera,
                args=(config,),
                name=f"camera-{config.camera_id}",
                daemon=True,
            )
            thread.start()
            self._threads.append(thread)
            logger.info("Started RTSP worker for camera %s", config.camera_id)

    def _should_emit(self, camera_id: str, student_code: str, now: float) -> bool:
        key = (camera_id, student_code)
        with self._dedup_lock:
            previous = self._last_event.get(key, 0.0)
            if now - previous < EVENT_DEDUP_SECONDS:
                return False
            self._last_event[key] = now
            return True

    def _run_camera(self, config: CameraConfig) -> None:
        sample_interval = 1.0 / config.sample_fps
        while not self._stopping.is_set():
            capture = cv2.VideoCapture(config.url)
            if not capture.isOpened():
                logger.warning("Unable to open camera %s; retrying", config.camera_id)
                capture.release()
                self._stopping.wait(5.0)
                continue
            last_sample = 0.0
            try:
                while not self._stopping.is_set():
                    ok, frame = capture.read()
                    if not ok or frame is None:
                        break
                    now = time.time()
                    if now - last_sample < sample_interval:
                        continue
                    last_sample = now
                    try:
                        matches = recognize_frame(frame)
                    except Exception as exc:
                        logger.warning("Vision inference failed for camera %s: %s", config.camera_id, exc)
                        self._stopping.wait(2.0)
                        continue
                    for match in matches:
                        student_code = match.get("student_code")
                        if student_code and self._should_emit(config.camera_id, student_code, now):
                            post_presence_event(config.camera_id, match, now)
            finally:
                capture.release()
            self._stopping.wait(2.0)

    def stop(self) -> None:
        self._stopping.set()


supervisor = CameraSupervisor()


@app.on_event("startup")
def startup() -> None:
    engine.load()
    supervisor.start()


@app.on_event("shutdown")
def shutdown() -> None:
    supervisor.stop()


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model_ready": engine.ready,
        "model_error": engine.error,
        "model_pack": MODEL_PACK,
        "execution_provider": EXECUTION_PROVIDER,
        "templates_ready": store.ready,
        "enrolled_students": store.count(),
        "match_threshold": MATCH_THRESHOLD,
        "detection_threshold": DETECTION_THRESHOLD,
        "configured_cameras": len(supervisor.configs()),
        "raw_images_retained": False,
    }


@app.post("/v1/enroll", dependencies=[Depends(require_secret)])
async def enroll(
    image: UploadFile = File(...),
    student_code: str = Form(...),
    consent_status: str = Form(...),
) -> dict[str, Any]:
    if consent_status.lower() != "granted":
        raise HTTPException(status_code=400, detail="biometric consent must be granted before enrollment")
    try:
        frame = decode_image(await image.read())
        faces = engine.faces(frame)
        candidates = [face for face in faces if float(getattr(face, "det_score", 0.0) or 0.0) >= DETECTION_THRESHOLD]
        if len(candidates) != 1:
            raise HTTPException(status_code=422, detail="enrollment image must contain exactly one clear face")
        embedding = getattr(candidates[0], "normed_embedding", None)
        if embedding is None:
            raise HTTPException(status_code=422, detail="face embedding could not be produced")
        profile = store.enroll(student_code, np.asarray(embedding, dtype=np.float32), consent_status)
        return {"enrolled": True, "profile": profile}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.delete("/v1/enroll/{student_code}", dependencies=[Depends(require_secret)])
def delete_enrollment(student_code: str) -> dict[str, Any]:
    return {"deleted": store.delete(student_code)}


@app.post("/v1/recognize", dependencies=[Depends(require_secret)])
async def recognize(image: UploadFile = File(...)) -> dict[str, Any]:
    try:
        frame = decode_image(await image.read())
        return {"faces": recognize_frame(frame), "model": f"insightface:{MODEL_PACK}"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/v1/frame", dependencies=[Depends(require_secret)])
async def frame_ingest(
    camera_id: str = Form(...),
    image: UploadFile = File(...),
) -> dict[str, Any]:
    """Recognize one camera frame and forward matched identities to KobeAI.

    This is useful when an NVR/edge agent pushes JPEG frames instead of letting
    KobeVision pull the RTSP stream directly. The frame is processed in memory
    and is not persisted.
    """
    try:
        frame = decode_image(await image.read())
        matches = recognize_frame(frame)
        now = time.time()
        posted = 0
        for match in matches:
            student_code = match.get("student_code")
            if student_code and supervisor._should_emit(camera_id, student_code, now):
                post_presence_event(camera_id, match, now)
                posted += 1
        return {"camera_id": camera_id, "faces": matches, "events_posted": posted}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
