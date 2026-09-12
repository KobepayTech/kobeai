"""K9 model runtime: serves K9's vision and audio models over local HTTP.

Every model path comes from config/k9-models.json. Start it with
scripts\\k9-runtime.cmd (which uses the Python named in the registry), or:

    python services/k9-runtime/server.py [--host 127.0.0.1] [--port 8766] [--preload]

Env: K9_MODELS_CONFIG, K9_RUNTIME_HOST, K9_RUNTIME_PORT, K9_RUNTIME_SECRET.
When K9_RUNTIME_SECRET is set every request must send it in
`x-k9-runtime-secret`; without a secret the runtime only listens on loopback.

Endpoints (JSON; images and audio are base64):
    GET  /health                          engine states for every registry model
    POST /v1/detect|segment|classify|pose {image, conf?, imgsz?}
    POST /v1/track                        {camera_id, image, conf?}
    POST /v1/faces                        {image, embed?}
    POST /v1/faces/match                  {a, b}
    POST /v1/reid                         {image, boxes?}
    POST /v1/vad                          {audio (16-bit PCM WAV), threshold?}
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Keep Ultralytics from phoning home or pip-installing packages on a school PC.
os.environ.setdefault("YOLO_OFFLINE", "1")
os.environ.setdefault("YOLO_AUTOINSTALL", "false")
os.environ.setdefault("YOLO_VERBOSE", "false")

import lap_shim  # noqa: E402

lap_shim.install()

import argparse  # noqa: E402
import base64  # noqa: E402
import binascii  # noqa: E402
import hmac  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402
from typing import Any  # noqa: E402

import numpy as np  # noqa: E402

from engines import EngineUnavailable, FaceEngine, build_engines, serialize_result  # noqa: E402
from k9_models import Registry  # noqa: E402

MAX_BODY_BYTES = 25 * 1024 * 1024
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
YOLO_TASKS = {"/v1/detect": "detect", "/v1/segment": "segment", "/v1/classify": "classify", "/v1/pose": "pose"}


def decode_base64(value: Any, field: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} (base64) is required")
    if value.startswith("data:"):
        value = value.split(",", 1)[-1]
    try:
        return base64.b64decode(value, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{field} is not valid base64: {exc}") from None


def decode_image(value: Any) -> np.ndarray:
    import cv2

    image = cv2.imdecode(np.frombuffer(decode_base64(value, "image"), np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("image could not be decoded (send a JPEG or PNG)")
    return image


class Runtime:
    def __init__(self, registry: Registry, secret: str = ""):
        self.registry = registry
        self.secret = secret
        self.engines = build_engines(registry)
        self.started = time.time()

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "service": "k9-runtime",
            "registry": str(self.registry.path),
            "python": sys.version.split()[0],
            "device": "cpu",
            "uptime_seconds": round(time.time() - self.started),
            "engines": {name: engine.describe() for name, engine in self.engines.items()},
        }

    def handle(self, method: str, path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if method == "GET" and path in ("/health", "/v1/health"):
            return 200, self.health()
        if method != "POST":
            return 404, {"error": "not_found"}

        started = time.perf_counter()
        if path in YOLO_TASKS:
            task = YOLO_TASKS[path]
            engine = self.engines[task]
            result = engine.predict(decode_image(body.get("image")), conf=float(body.get("conf", 0.25)), imgsz=int(body.get("imgsz", 640)))
            payload: dict[str, Any] = {"model": engine.models[0], "task": task, **serialize_result(result, task)}
        elif path == "/v1/track":
            camera_id = str(body.get("camera_id") or "").strip()
            if not camera_id:
                raise ValueError("camera_id is required")
            tracks = self.engines["tracking"].track(camera_id, decode_image(body.get("image")), conf=float(body.get("conf", 0.25)))
            payload = {"camera_id": camera_id, "tracks": tracks}
        elif path == "/v1/faces":
            payload = {"faces": self.engines["faces"].detect(decode_image(body.get("image")), embed=bool(body.get("embed", True)))}
        elif path == "/v1/faces/match":
            payload = FaceEngine.match(body.get("a"), body.get("b"))
        elif path == "/v1/reid":
            payload = {"embeddings": self.engines["reid"].embed(decode_image(body.get("image")), body.get("boxes"))}
        elif path == "/v1/vad":
            segments, seconds = self.engines["vad"].segments(
                decode_base64(body.get("audio"), "audio"), threshold=float(body.get("threshold", 0.5))
            )
            payload = {
                "segments": segments,
                "duration_seconds": seconds,
                "speech_seconds": round(sum(s["end"] - s["start"] for s in segments), 3),
            }
        else:
            return 404, {"error": "not_found"}
        payload["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 1)
        return 200, payload


def make_handler(runtime: Runtime) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "k9-runtime"

        def log_message(self, fmt: str, *args: Any) -> None:
            sys.stdout.write(f"[k9-runtime] {self.address_string()} {fmt % args}\n")
            sys.stdout.flush()

        def _send(self, status: int, payload: dict[str, Any]) -> None:
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _dispatch(self, method: str) -> None:
            if runtime.secret and not hmac.compare_digest(self.headers.get("x-k9-runtime-secret", ""), runtime.secret):
                self._send(401, {"error": "unauthorized"})
                return
            body: dict[str, Any] = {}
            if method == "POST":
                length = int(self.headers.get("content-length") or 0)
                if length > MAX_BODY_BYTES:
                    self._send(413, {"error": "body_too_large", "max_bytes": MAX_BODY_BYTES})
                    return
                try:
                    body = json.loads(self.rfile.read(length) or b"{}")
                except json.JSONDecodeError:
                    self._send(400, {"error": "invalid_json"})
                    return
                if not isinstance(body, dict):
                    self._send(400, {"error": "body_must_be_an_object"})
                    return
            try:
                status, payload = runtime.handle(method, self.path.split("?", 1)[0], body)
            except EngineUnavailable as exc:
                status, payload = 503, {"error": "engine_unavailable", "detail": str(exc)}
            except (ValueError, TypeError) as exc:
                status, payload = 400, {"error": "bad_request", "detail": str(exc)}
            except Exception as exc:  # keep serving; report the failure to the caller
                traceback.print_exc()
                status, payload = 500, {"error": "runtime_error", "detail": f"{type(exc).__name__}: {exc}"}
            self._send(status, payload)

        def do_GET(self) -> None:  # noqa: N802 (http.server naming)
            self._dispatch("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._dispatch("POST")

    return Handler


def main(argv: list[str] | None = None) -> None:
    registry = Registry()
    defaults = registry.runtime("k9_runtime", {}) or {}
    parser = argparse.ArgumentParser(description="K9 model runtime")
    parser.add_argument("--host", default=os.environ.get("K9_RUNTIME_HOST") or defaults.get("host", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("K9_RUNTIME_PORT") or defaults.get("port", 8766)))
    parser.add_argument("--preload", action="store_true", help="load every runnable engine before serving")
    args = parser.parse_args(argv)

    secret = os.environ.get("K9_RUNTIME_SECRET", "")
    if not secret and args.host not in LOOPBACK_HOSTS:
        parser.error("set K9_RUNTIME_SECRET before listening beyond this PC")

    runtime = Runtime(registry, secret)
    if args.preload:
        for name, engine in runtime.engines.items():
            if engine.state() == "available":
                try:
                    engine.model()
                except Exception as exc:
                    print(f"[k9-runtime] could not preload {name}: {exc}", flush=True)

    server = ThreadingHTTPServer((args.host, args.port), make_handler(runtime))
    print(f"[k9-runtime] registry {registry.path}", flush=True)
    for name, info in runtime.health()["engines"].items():
        detail = ", ".join(info["needs_packages"] or info["missing_models"]) or info["note"]
        print(f"[k9-runtime]   {name:16} {info['state']:15} {detail}", flush=True)
    print(f"[k9-runtime] serving http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
