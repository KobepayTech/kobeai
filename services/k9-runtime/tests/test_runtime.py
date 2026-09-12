"""Tests for the K9 model runtime.

    python -m unittest discover -s services/k9-runtime/tests

Unit tests always run. Set K9_RUNTIME_MODELS=1 to also load the real models
from the registry and run them on Ultralytics' sample photos (slow; needs the
vision-env packages and the downloaded models).
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import lap_shim  # noqa: E402
from engines import FaceEngine, speech_segments  # noqa: E402
from k9_models import COMPLETE_MARKER, Registry  # noqa: E402


def silent_wav(seconds: float, rate: int = 16000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(np.zeros(int(seconds * rate), dtype="<i2").tobytes())
    return buffer.getvalue()


class LapShimTest(unittest.TestCase):
    def test_matches_within_the_cost_limit_and_leaves_the_rest_unassigned(self):
        cost = np.array([[0.1, 0.9], [0.8, 0.95]])
        _, x, y = lap_shim.lapjv(cost, extend_cost=True, cost_limit=0.5)
        self.assertEqual(list(x), [0, -1])
        self.assertEqual(list(y), [0, -1])

    def test_prefers_the_cheapest_full_assignment(self):
        cost = np.array([[0.2, 0.1], [0.1, 0.4]])
        total, x, y = lap_shim.lapjv(cost, extend_cost=True, cost_limit=0.5)
        self.assertEqual(list(x), [1, 0])
        self.assertAlmostEqual(total, 0.2)

    def test_handles_empty_matrices(self):
        _, x, y = lap_shim.lapjv(np.zeros((0, 3)), extend_cost=True, cost_limit=0.5)
        self.assertEqual((len(x), len(y)), (0, 3))


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="k9-runtime-"))
        (self.tmp / "k9" / "face" / "yunet").mkdir(parents=True)
        (self.tmp / "k9" / "reid").mkdir(parents=True)
        self.config = self.tmp / "k9-models.json"
        self.config.write_text(json.dumps({
            "version": 2,
            "roots": {"base": {"path": "C:\\nope", "env": "T_BASE"}, "k9": {"path": "C:\\nope\\k9", "env": "T_K9"}},
            "models": {
                "yunet": {"category": "face", "role": "x", "path": "face/yunet", "weights": "face.onnx", "kind": "dir", "required": True, "source": {"type": "hf"}},
                "osnet": {"category": "reid", "role": "x", "path": "reid/osnet.pth", "kind": "file", "required": True, "source": {"type": "gdown"}},
            },
        }))
        self.registry = Registry(self.config, env={"T_BASE": str(self.tmp), "T_K9": str(self.tmp / "k9")})

    def test_paths_come_from_the_registry_roots(self):
        self.assertEqual(self.registry.path_of("yunet"), self.tmp / "k9" / "face" / "yunet")
        self.assertEqual(self.registry.weights_of("yunet"), self.tmp / "k9" / "face" / "yunet" / "face.onnx")
        self.assertEqual(self.registry.weights_of("osnet"), self.tmp / "k9" / "reid" / "osnet.pth")

    def test_a_folder_is_only_ready_with_its_marker_and_its_weights_file(self):
        folder = self.tmp / "k9" / "face" / "yunet"
        self.assertEqual(self.registry.status("yunet"), "partial")
        (folder / COMPLETE_MARKER).write_text("")
        self.assertEqual(self.registry.status("yunet"), "partial", "the weights file named in the registry is missing")
        (folder / "face.onnx").write_bytes(b"onnx")
        self.assertEqual(self.registry.status("yunet"), "ready")
        self.assertEqual(self.registry.status("osnet"), "missing")

    def test_unknown_models_raise_a_clear_error(self):
        with self.assertRaisesRegex(KeyError, "not in the K9 model registry"):
            self.registry.path_of("nope")

    def test_shipping_registry_names_every_runtime_file(self):
        registry = Registry()
        self.assertTrue(str(registry.weights_of("yunet")).endswith(".onnx"))
        self.assertTrue(str(registry.weights_of("sface")).endswith(".onnx"))
        self.assertTrue(str(registry.weights_of("silero_vad")).endswith(".jit"))
        self.assertTrue(str(registry.code_of("deep_person_reid")).endswith("osnet_ain.py"))


class PureLogicTest(unittest.TestCase):
    def test_face_match_uses_the_sface_cosine_threshold(self):
        self.assertTrue(FaceEngine.match([1, 0], [1, 0])["same_person"])
        self.assertFalse(FaceEngine.match([1, 0], [0, 1])["same_person"])
        with self.assertRaises(ValueError):
            FaceEngine.match([1, 0], [1, 0, 0])

    def test_speech_segments_merge_windows_and_drop_short_blips(self):
        window, rate = 512, 16000
        probs = [0.0] * 10 + [0.9] * 20 + [0.0] * 10 + [0.9] * 2 + [0.0] * 10
        segments = speech_segments(probs, window, rate, total_samples=len(probs) * window)
        self.assertEqual(len(segments), 1)
        self.assertAlmostEqual(segments[0]["start"], 10 * window / rate - 0.03, places=2)


class ServerTest(unittest.TestCase):
    def test_requests_need_the_shared_secret_and_health_lists_every_engine(self):
        from http.server import ThreadingHTTPServer

        from server import Runtime, make_handler

        runtime = Runtime(Registry(), secret="test-secret")
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(runtime))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{httpd.server_address[1]}/health"
        try:
            with self.assertRaises(urllib.error.HTTPError) as denied:
                urllib.request.urlopen(url, timeout=10)
            self.assertEqual(denied.exception.code, 401)
            request = urllib.request.Request(url, headers={"x-k9-runtime-secret": "test-secret"})
            with urllib.request.urlopen(request, timeout=30) as response:
                engines = json.load(response)["engines"]
            for name in ("detect", "tracking", "faces", "reid", "vad", "speech_to_text", "ocr"):
                self.assertIn(name, engines)
        finally:
            httpd.shutdown()


@unittest.skipUnless(os.environ.get("K9_RUNTIME_MODELS") == "1", "set K9_RUNTIME_MODELS=1 to run the real models")
class RealModelsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import ultralytics

        from server import Runtime

        cls.runtime = Runtime(Registry())
        assets = Path(ultralytics.__file__).parent / "assets"
        cls.bus = base64.b64encode((assets / "bus.jpg").read_bytes()).decode()
        cls.zidane = base64.b64encode((assets / "zidane.jpg").read_bytes()).decode()

    def post(self, path, body):
        status, payload = self.runtime.handle("POST", path, body)
        self.assertEqual(status, 200, payload)
        return payload

    def test_detect_finds_the_people_and_the_bus(self):
        labels = [d["label"] for d in self.post("/v1/detect", {"image": self.bus})["detections"]]
        self.assertGreaterEqual(labels.count("person"), 3, labels)
        self.assertIn("bus", labels)

    def test_pose_returns_17_keypoints_per_person(self):
        people = self.post("/v1/pose", {"image": self.zidane})["detections"]
        self.assertGreaterEqual(len(people), 2)
        self.assertTrue(all(len(p["keypoints"]) == 17 for p in people))

    def test_segment_returns_polygons(self):
        detections = self.post("/v1/segment", {"image": self.bus})["detections"]
        self.assertTrue(detections and all(len(d["polygon"]) >= 3 for d in detections))

    def test_classify_returns_the_top_five_labels(self):
        self.assertEqual(len(self.post("/v1/classify", {"image": self.bus})["top"]), 5)

    def test_tracking_keeps_ids_across_frames(self):
        first = self.post("/v1/track", {"camera_id": "test-cam", "image": self.bus})["tracks"]
        second = self.post("/v1/track", {"camera_id": "test-cam", "image": self.bus})["tracks"]
        self.assertTrue(first)
        self.assertEqual({t["track_id"] for t in first}, {t["track_id"] for t in second})

    def test_faces_are_detected_embedded_and_matched(self):
        faces = self.post("/v1/faces", {"image": self.zidane})["faces"]
        self.assertGreaterEqual(len(faces), 2)
        self.assertTrue(all(len(f["embedding"]) == 128 for f in faces))
        self.assertTrue(self.post("/v1/faces/match", {"a": faces[0]["embedding"], "b": faces[0]["embedding"]})["same_person"])
        self.assertFalse(self.post("/v1/faces/match", {"a": faces[0]["embedding"], "b": faces[1]["embedding"]})["same_person"])

    def test_reid_embeddings_are_512d_unit_vectors(self):
        people = [d["box"] for d in self.post("/v1/detect", {"image": self.bus})["detections"] if d["label"] == "person"]
        embeddings = self.post("/v1/reid", {"image": self.bus, "boxes": people[:2]})["embeddings"]
        self.assertEqual(len(embeddings), 2)
        for vector in embeddings:
            self.assertEqual(len(vector), 512)
            self.assertAlmostEqual(float(np.linalg.norm(vector)), 1.0, places=3)

    def test_vad_finds_no_speech_in_silence(self):
        audio = base64.b64encode(silent_wav(2.0)).decode()
        payload = self.post("/v1/vad", {"audio": audio})
        self.assertEqual(payload["segments"], [])
        self.assertAlmostEqual(payload["duration_seconds"], 2.0, places=2)


if __name__ == "__main__":
    unittest.main()
