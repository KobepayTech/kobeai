from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from model_registry import BY_NAME, choose_model, statuses


class RegistryTests(unittest.TestCase):
    def test_prefers_first_present_capability_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "tencent" / "vision" / "youtu-vl-4b-instruct"
            target.mkdir(parents=True)
            (target / ".k9_complete").touch()
            chosen = choose_model("vision", root)
            self.assertEqual(chosen.name, "youtu-vl-4b")

    def test_requested_missing_model_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileNotFoundError):
                choose_model("asr", Path(tmp), "whisper-large-v3-turbo")

    def test_status_distinguishes_present_and_complete(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            gguf = root / "brain" / "existing" / "qwen.gguf"
            gguf.parent.mkdir(parents=True)
            gguf.write_bytes(b"model")
            by_name = {item["name"]: item for item in statuses(root)}
            self.assertTrue(by_name["qwen-gguf"]["present"])
            self.assertTrue(by_name["qwen-gguf"]["complete"])
            self.assertFalse(by_name["deepseek-gguf"]["present"])

    def test_manifest_contains_core_k9_models(self) -> None:
        required = {
            "qwen3-vl-8b",
            "youtu-llm-2b",
            "youtu-vl-4b",
            "hunyuan-ocr-1.5",
            "yolo26m",
            "yolo26m-pose",
            "bytetrack",
            "osnet-ain",
            "yunet",
            "sface",
            "whisper-large-v3-turbo",
            "titanet-large",
            "bge-m3",
            "piper-swahili",
        }
        self.assertTrue(required.issubset(BY_NAME))

    def test_registry_uses_canonical_downloader_paths(self) -> None:
        self.assertEqual(BY_NAME["qwen-gguf"].relative_path, r"brain/existing/qwen.gguf")
        self.assertEqual(BY_NAME["rtdetr-v2-r50vd"].relative_path, r"detection/rtdetr-v2-r50vd")
        self.assertEqual(BY_NAME["locateanything-3b"].relative_path, r"vision/locateanything-3b")
        self.assertEqual(BY_NAME["paddleocr-vl-1.6"].relative_path, r"ocr/paddleocr-vl-1.6")


if __name__ == "__main__":
    unittest.main()
