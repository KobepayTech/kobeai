"""K9 camera worker — turns an IP camera or NVR channel into student sightings.

    camera (RTSP/HTTP)  ->  K9 model runtime /v1/faces  ->  face gallery match
                        ->  POST /api/v1/presence/event

Nothing here owns a model or a path. Faces come from the K9 runtime (YuNet +
SFace, the same engines Teacher Lens uses), the enrolled students come from the
api-server's face gallery, and every model location lives in
config/k9-models.json. Frames are processed in memory and never written to disk.

Configure with a local file that is not in Git (see cameras.example.json):

    set K9_CAMERAS_FILE=C:\\KobeOS\\k9-cameras.json
    set KOBEVISION_SHARED_SECRET=<the api-server's worker secret>
    set K9_RUNTIME_SECRET=<the runtime secret>
    py services\\k9-camera\\camera_worker.py

RTSP URLs hold camera passwords, so they belong in that file (or the
environment), never in the repository or the K9 database.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

LOG = logging.getLogger("k9-camera")

# OpenCV's recommended SFace threshold — the same constant the runtime and the
# vision worker use. Below this, two faces are not the same person.
SFACE_MATCH_COSINE = 0.363
# The presence checkpoint engine treats a sighting as confident at >= 0.86
# (PRESENCE_MATCH_THRESHOLD). Cosine lives on a different scale, so map it:
# the decision point lands just under that bar and a perfect match reaches 1.0.
PRESENCE_CONFIDENT_AT = 0.86


def presence_confidence(cosine: float) -> float:
    """Map an SFace cosine onto the scale the checkpoint engine expects."""
    if cosine <= SFACE_MATCH_COSINE:
        return round(max(0.0, cosine / SFACE_MATCH_COSINE) * PRESENCE_CONFIDENT_AT * 0.9, 4)
    span = 1.0 - SFACE_MATCH_COSINE
    above = (cosine - SFACE_MATCH_COSINE) / span if span > 0 else 1.0
    return round(min(1.0, PRESENCE_CONFIDENT_AT + above * (1.0 - PRESENCE_CONFIDENT_AT)), 4)


@dataclass
class CameraConfig:
    camera_id: str
    url: str
    sample_fps: float = 1.0
    name: str = ""
    zone_code: str = ""


@dataclass
class Settings:
    api_base: str
    api_secret: str
    runtime_url: str
    runtime_secret: str
    cameras: list[CameraConfig] = field(default_factory=list)
    dedup_seconds: float = 15.0
    gallery_ttl_seconds: float = 30.0
    min_face_score: float = 0.8

    @classmethod
    def load(cls, path: str | None = None) -> "Settings":
        raw: dict[str, Any] = {}
        config_path = path or os.getenv("K9_CAMERAS_FILE", "").strip()
        if config_path:
            raw = json.loads(Path(config_path).read_text(encoding="utf-8"))
        cameras = [
            CameraConfig(
                camera_id=str(item["camera_id"]).strip(),
                url=str(item["url"]).strip(),
                sample_fps=max(0.1, float(item.get("sample_fps", 1.0))),
                name=str(item.get("name", "")).strip(),
                zone_code=str(item.get("zone_code", "")).strip(),
            )
            for item in raw.get("cameras", [])
            if str(item.get("camera_id", "")).strip() and str(item.get("url", "")).strip()
        ]
        return cls(
            api_base=(raw.get("api_base") or os.getenv("KOBEAI_API_BASE", "http://127.0.0.1:8088")).rstrip("/"),
            api_secret=raw.get("api_secret") or os.getenv("KOBEVISION_SHARED_SECRET", ""),
            runtime_url=(raw.get("runtime_url") or os.getenv("K9_RUNTIME_URL", "http://127.0.0.1:8766")).rstrip("/"),
            runtime_secret=raw.get("runtime_secret") or os.getenv("K9_RUNTIME_SECRET", ""),
            cameras=cameras,
            dedup_seconds=float(raw.get("dedup_seconds", 15.0)),
            gallery_ttl_seconds=float(raw.get("gallery_ttl_seconds", 30.0)),
            min_face_score=float(raw.get("min_face_score", 0.8)),
        )


def _post_json(url: str, payload: dict[str, Any], headers: dict[str, str], timeout: float) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("content-type", "application/json")
    for key, value in headers.items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        text = response.read().decode("utf-8", "replace")
    return json.loads(text) if text else {}


def _get_json(url: str, headers: dict[str, str], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(url, method="GET")
    for key, value in headers.items():
        request.add_header(key, value)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "replace") or "{}")


def cosine(a: list[float], b: list[float]) -> float:
    if not a or len(a) != len(b):
        return -1.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return dot / ((na * nb) or 1.0)


class K9Client:
    """Talks to the K9 runtime (faces) and the api-server (gallery, presence)."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._gallery: list[dict[str, Any]] = []
        self._gallery_at = 0.0
        self._lock = threading.Lock()

    def faces(self, jpeg: bytes) -> list[dict[str, Any]]:
        import base64

        headers = {}
        if self.settings.runtime_secret:
            headers["x-k9-runtime-secret"] = self.settings.runtime_secret
        payload = {"image": base64.b64encode(jpeg).decode("ascii"), "embed": True}
        body = _post_json(f"{self.settings.runtime_url}/v1/faces", payload, headers, timeout=60.0)
        return body.get("faces", [])

    def gallery(self, refresh: bool = False) -> list[dict[str, Any]]:
        with self._lock:
            fresh = time.time() - self._gallery_at < self.settings.gallery_ttl_seconds
            if self._gallery and fresh and not refresh:
                return self._gallery
        students = _get_json(
            f"{self.settings.api_base}/api/v1/vision/face-gallery",
            {"x-kobevision-secret": self.settings.api_secret},
            timeout=15.0,
        ).get("students", [])
        with self._lock:
            self._gallery = students
            self._gallery_at = time.time()
        return students

    def best_match(self, embedding: list[float]) -> dict[str, Any] | None:
        best: dict[str, Any] | None = None
        for student in self.gallery():
            for enrolled in student.get("embeddings", []):
                score = cosine(embedding, enrolled)
                if best is None or score > best["cosine"]:
                    best = {"student_code": student["student_code"], "name": student.get("name"), "cosine": score}
        if best and best["cosine"] < SFACE_MATCH_COSINE:
            # Someone may have been enrolled since the gallery was cached.
            for student in self.gallery(refresh=True):
                for enrolled in student.get("embeddings", []):
                    score = cosine(embedding, enrolled)
                    if score > best["cosine"]:
                        best = {"student_code": student["student_code"], "name": student.get("name"), "cosine": score}
        return best

    def presence_event(self, camera_id: str, match: dict[str, Any], face: dict[str, Any], captured_at: float) -> None:
        payload = {
            "student_code": match["student_code"],
            "camera_id": camera_id,
            "confidence": presence_confidence(match["cosine"]),
            "face_quality": round(float(face.get("score", 0.0)), 4),
            "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(captured_at)),
            "model_version": "k9-runtime:yunet+sface",
            "metadata": {
                # The raw score is kept so a reviewer sees the real evidence,
                # not only the mapped confidence.
                "sface_cosine": round(float(match["cosine"]), 4),
                "sface_threshold": SFACE_MATCH_COSINE,
                "box": face.get("box"),
                "worker": "k9-camera",
            },
        }
        _post_json(
            f"{self.settings.api_base}/api/v1/presence/event",
            payload,
            {"x-kobevision-secret": self.settings.api_secret},
            timeout=10.0,
        )


class CameraWorker:
    """One thread per camera: grab, recognise, report."""

    def __init__(self, settings: Settings, client: K9Client):
        self.settings = settings
        self.client = client
        self.stopping = threading.Event()
        self._last_event: dict[tuple[str, str], float] = {}
        self._dedup_lock = threading.Lock()
        self.threads: list[threading.Thread] = []

    def should_emit(self, camera_id: str, student_code: str, now: float) -> bool:
        with self._dedup_lock:
            previous = self._last_event.get((camera_id, student_code), 0.0)
            if now - previous < self.settings.dedup_seconds:
                return False
            self._last_event[(camera_id, student_code)] = now
            return True

    def handle_frame(self, camera: CameraConfig, jpeg: bytes, now: float | None = None) -> list[dict[str, Any]]:
        """Recognise everyone in one frame and report new sightings."""
        now = time.time() if now is None else now
        reported: list[dict[str, Any]] = []
        for face in self.client.faces(jpeg):
            if float(face.get("score", 0.0)) < self.settings.min_face_score:
                continue
            embedding = face.get("embedding") or []
            match = self.client.best_match(embedding) if embedding else None
            if not match or match["cosine"] < SFACE_MATCH_COSINE:
                continue
            if not self.should_emit(camera.camera_id, match["student_code"], now):
                continue
            try:
                self.client.presence_event(camera.camera_id, match, face, now)
                reported.append({**match, "camera_id": camera.camera_id})
                LOG.info(
                    "%s seen on %s (cosine %.3f -> confidence %.3f)",
                    match.get("name") or match["student_code"],
                    camera.camera_id,
                    match["cosine"],
                    presence_confidence(match["cosine"]),
                )
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "replace")[:200]
                LOG.warning("presence event refused for %s: HTTP %s %s", camera.camera_id, exc.code, detail)
            except Exception as exc:  # network blip — the next frame retries
                LOG.warning("presence event failed for %s: %s", camera.camera_id, exc)
        return reported

    def run_camera(self, camera: CameraConfig) -> None:
        import cv2

        interval = 1.0 / camera.sample_fps
        while not self.stopping.is_set():
            capture = cv2.VideoCapture(camera.url)
            if not capture.isOpened():
                LOG.warning("cannot open %s (%s) — retrying in 5s", camera.camera_id, camera.url.split("@")[-1])
                capture.release()
                self.stopping.wait(5.0)
                continue
            LOG.info("streaming %s at %.2f fps", camera.camera_id, camera.sample_fps)
            try:
                while not self.stopping.is_set():
                    ok, frame = capture.read()
                    if not ok:
                        LOG.warning("stream %s dropped — reconnecting", camera.camera_id)
                        break
                    ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
                    if ok:
                        try:
                            self.handle_frame(camera, buffer.tobytes())
                        except Exception as exc:
                            LOG.warning("frame from %s not processed: %s", camera.camera_id, exc)
                    self.stopping.wait(interval)
            finally:
                capture.release()

    def start(self) -> None:
        for camera in self.settings.cameras:
            thread = threading.Thread(target=self.run_camera, args=(camera,), name=f"camera-{camera.camera_id}", daemon=True)
            thread.start()
            self.threads.append(thread)

    def stop(self) -> None:
        self.stopping.set()
        for thread in self.threads:
            thread.join(timeout=5.0)


def main() -> int:
    parser = argparse.ArgumentParser(description="K9 camera worker: IP camera -> student sightings")
    parser.add_argument("--config", help="cameras JSON file (default: K9_CAMERAS_FILE)")
    parser.add_argument("--check", action="store_true", help="open each camera once, report what is seen, then exit")
    args = parser.parse_args()
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="[k9-camera] %(message)s")

    settings = Settings.load(args.config)
    if not settings.cameras:
        LOG.error("no cameras configured — point K9_CAMERAS_FILE at a file like services/k9-camera/cameras.example.json")
        return 2
    if not settings.api_secret:
        LOG.error("KOBEVISION_SHARED_SECRET (or api_secret in the config) is required to post sightings")
        return 2

    client = K9Client(settings)
    worker = CameraWorker(settings, client)

    if args.check:
        import cv2

        failures = 0
        for camera in settings.cameras:
            capture = cv2.VideoCapture(camera.url)
            opened = capture.isOpened()
            ok, frame = capture.read() if opened else (False, None)
            capture.release()
            if not ok:
                LOG.error("%s: could not read a frame", camera.camera_id)
                failures += 1
                continue
            ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            faces = client.faces(buffer.tobytes()) if ok else []
            LOG.info("%s: frame %sx%s, %s face(s)", camera.camera_id, frame.shape[1], frame.shape[0], len(faces))
            for face in faces:
                match = client.best_match(face.get("embedding") or [])
                if match and match["cosine"] >= SFACE_MATCH_COSINE:
                    LOG.info(
                        "    %s (cosine %.3f -> confidence %.3f)",
                        match.get("name") or match["student_code"],
                        match["cosine"],
                        presence_confidence(match["cosine"]),
                    )
                else:
                    LOG.info("    unrecognised face (best cosine %.3f)", match["cosine"] if match else -1.0)
        return 1 if failures else 0

    worker.start()
    LOG.info("watching %s camera(s); Ctrl+C to stop", len(settings.cameras))
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        LOG.info("stopping")
    finally:
        worker.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
