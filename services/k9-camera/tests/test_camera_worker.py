"""Tests for the K9 camera worker: confidence mapping, matching, de-dup, reporting.

No camera and no K9 server are needed — the runtime and api-server are doubled,
so the whole frame-to-sighting path is exercised offline.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from camera_worker import (  # noqa: E402
    PRESENCE_CONFIDENT_AT,
    SFACE_MATCH_COSINE,
    CameraConfig,
    CameraWorker,
    Settings,
    cosine,
    presence_confidence,
)


def settings(**overrides) -> Settings:
    base = dict(
        api_base="http://k9.test",
        api_secret="secret",
        runtime_url="http://runtime.test",
        runtime_secret="rt",
        cameras=[CameraConfig(camera_id="CAM1", url="rtsp://x/1", sample_fps=1.0, zone_code="FORM1A")],
        dedup_seconds=15.0,
    )
    base.update(overrides)
    return Settings(**base)


class FakeClient:
    """Stands in for the K9 runtime + api-server."""

    def __init__(self, faces, gallery):
        self._faces = faces
        self._gallery = gallery
        self.events = []

    def faces(self, jpeg: bytes):
        return self._faces

    def gallery(self, refresh: bool = False):
        return self._gallery

    def best_match(self, embedding):
        best = None
        for student in self._gallery:
            for enrolled in student["embeddings"]:
                score = cosine(embedding, enrolled)
                if best is None or score > best["cosine"]:
                    best = {"student_code": student["student_code"], "name": student.get("name"), "cosine": score}
        return best

    def presence_event(self, camera_id, match, face, captured_at):
        self.events.append(
            {
                "camera_id": camera_id,
                "student_code": match["student_code"],
                "confidence": presence_confidence(match["cosine"]),
                "cosine": match["cosine"],
                "face_quality": face.get("score"),
            }
        )


class ConfidenceMappingTests(unittest.TestCase):
    """SFace cosine and the checkpoint engine use different scales."""

    def test_a_real_match_clears_the_checkpoint_threshold(self):
        # The engine calls a sighting confident at >= 0.86; a genuine match must
        # not be filed as low_confidence.
        self.assertGreaterEqual(presence_confidence(1.0), PRESENCE_CONFIDENT_AT)
        self.assertGreaterEqual(presence_confidence(0.8), PRESENCE_CONFIDENT_AT)
        self.assertEqual(presence_confidence(1.0), 1.0)

    def test_at_the_decision_point_it_sits_just_below_confident(self):
        self.assertLess(presence_confidence(SFACE_MATCH_COSINE), PRESENCE_CONFIDENT_AT)

    def test_a_stranger_scores_low(self):
        self.assertLess(presence_confidence(0.06), 0.3)

    def test_confidence_stays_in_range(self):
        for value in (-1.0, 0.0, 0.2, 0.363, 0.5, 0.9, 1.0):
            mapped = presence_confidence(value)
            self.assertGreaterEqual(mapped, 0.0)
            self.assertLessEqual(mapped, 1.0)


class FrameHandlingTests(unittest.TestCase):
    def setUp(self):
        self.asha = [1.0, 0.0, 0.0]
        self.juma = [0.0, 1.0, 0.0]
        self.gallery = [
            {"student_code": "K9-ASHA", "name": "Asha Mwita", "embeddings": [self.asha]},
            {"student_code": "K9-JUMA", "name": "Juma Ally", "embeddings": [self.juma]},
        ]
        self.camera = CameraConfig(camera_id="CAM1", url="rtsp://x/1", zone_code="FORM1A")

    def worker(self, faces, **overrides):
        client = FakeClient(faces, self.gallery)
        return CameraWorker(settings(**overrides), client), client

    def test_an_enrolled_student_is_reported(self):
        worker, client = self.worker([{"score": 0.95, "box": [0, 0, 10, 10], "embedding": self.asha}])
        reported = worker.handle_frame(self.camera, b"jpeg", now=1000.0)
        self.assertEqual([r["student_code"] for r in reported], ["K9-ASHA"])
        self.assertEqual(len(client.events), 1)
        self.assertGreaterEqual(client.events[0]["confidence"], PRESENCE_CONFIDENT_AT)
        self.assertEqual(client.events[0]["cosine"], 1.0)

    def test_an_unenrolled_face_is_not_reported(self):
        worker, client = self.worker([{"score": 0.95, "embedding": [0.0, 0.0, 1.0]}])
        self.assertEqual(worker.handle_frame(self.camera, b"jpeg", now=1000.0), [])
        self.assertEqual(client.events, [])

    def test_a_blurry_detection_is_skipped(self):
        worker, client = self.worker([{"score": 0.2, "embedding": self.asha}])
        self.assertEqual(worker.handle_frame(self.camera, b"jpeg", now=1000.0), [])
        self.assertEqual(client.events, [])

    def test_the_same_student_is_not_reported_every_frame(self):
        face = {"score": 0.95, "embedding": self.asha}
        worker, client = self.worker([face])
        worker.handle_frame(self.camera, b"jpeg", now=1000.0)
        worker.handle_frame(self.camera, b"jpeg", now=1005.0)  # inside the 15s window
        self.assertEqual(len(client.events), 1, "de-dup should suppress the repeat")
        worker.handle_frame(self.camera, b"jpeg", now=1020.0)  # after the window
        self.assertEqual(len(client.events), 2)

    def test_two_students_in_one_frame_are_both_reported(self):
        worker, client = self.worker(
            [
                {"score": 0.95, "embedding": self.asha},
                {"score": 0.93, "embedding": self.juma},
            ]
        )
        reported = worker.handle_frame(self.camera, b"jpeg", now=1000.0)
        self.assertEqual(sorted(r["student_code"] for r in reported), ["K9-ASHA", "K9-JUMA"])

    def test_a_refused_event_does_not_stop_the_other_faces(self):
        class Refusing(FakeClient):
            def presence_event(self, camera_id, match, face, captured_at):
                if match["student_code"] == "K9-ASHA":
                    raise RuntimeError("camera_not_registered")
                super().presence_event(camera_id, match, face, captured_at)

        client = Refusing(
            [{"score": 0.95, "embedding": self.asha}, {"score": 0.95, "embedding": self.juma}],
            self.gallery,
        )
        worker = CameraWorker(settings(), client)
        reported = worker.handle_frame(self.camera, b"jpeg", now=1000.0)
        self.assertEqual([r["student_code"] for r in reported], ["K9-JUMA"])


class CosineTests(unittest.TestCase):
    def test_identical_embeddings_match(self):
        self.assertAlmostEqual(cosine([1.0, 0.0], [1.0, 0.0]), 1.0)

    def test_orthogonal_embeddings_do_not(self):
        self.assertAlmostEqual(cosine([1.0, 0.0], [0.0, 1.0]), 0.0)

    def test_mismatched_lengths_are_rejected(self):
        self.assertEqual(cosine([1.0, 0.0], [1.0]), -1.0)
        self.assertEqual(cosine([], []), -1.0)


if __name__ == "__main__":
    unittest.main()
