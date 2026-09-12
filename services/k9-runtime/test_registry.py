from __future__ import annotations

import unittest
from pathlib import Path

from k9_models import Registry
from model_registry import BY_NAME, CAPABILITY_ROUTES, MODEL_SPECS, choose_model, registry, statuses


class RegistryTests(unittest.TestCase):
    """The FastAPI runtime routes capabilities; config/k9-models.json owns paths."""

    def test_every_spec_maps_to_a_registry_entry(self) -> None:
        known = set(registry().models)
        unknown = sorted(spec.registry_id for spec in MODEL_SPECS if spec.registry_id not in known)
        self.assertEqual(unknown, [], "every runtime model must exist in config/k9-models.json")

    def test_paths_come_from_the_registry_not_this_file(self) -> None:
        for name in ("qwen-gguf", "hunyuan-4b-instruct", "rtdetr-v2-r50vd", "locateanything-3b", "paddleocr-vl-1.6"):
            spec = BY_NAME[name]
            self.assertEqual(spec.path(), registry().path_of(spec.registry_id))
            self.assertEqual(spec.relative_path, registry().entry(spec.registry_id)["path"])

    def test_the_brain_leads_chat_and_vision(self) -> None:
        self.assertEqual(CAPABILITY_ROUTES["chat"][0], "qwen3-vl-8b")
        self.assertEqual(CAPABILITY_ROUTES["vision"][0], "qwen3-vl-8b")
        self.assertIn("hunyuan-4b-instruct", CAPABILITY_ROUTES["reasoning"])

    def test_manifest_contains_core_k9_models(self) -> None:
        required = {
            "qwen3-vl-8b",
            "youtu-llm-2b",
            "hunyuan-4b-instruct",
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


class CompletenessTests(unittest.TestCase):
    """A folder that merely exists is not a usable model."""

    def setUp(self) -> None:
        self.registry = registry()

    def _spec_root(self, name: str) -> Path:
        entry = self.registry.entry(BY_NAME[name].registry_id)
        return self.registry.roots[entry.get("root", "k9")]

    def test_a_gated_folder_without_weights_is_not_complete(self) -> None:
        import tempfile

        spec = BY_NAME["pyannote-segmentation-3.0"]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = spec.path(root)
            folder.mkdir(parents=True)
            (folder / "README.md").write_text("gated model card", encoding="utf-8")
            (folder / ".k9_complete").touch()
            # The entry expects pytorch_model.bin; a README and a marker are not it.
            self.assertNotEqual(spec.status(root), "ready")
            (folder / "pytorch_model.bin").write_bytes(b"weights")
            self.assertEqual(spec.status(root), "ready")

    def test_routing_skips_an_incomplete_model_for_a_working_one(self) -> None:
        import tempfile

        kokoro = BY_NAME["kokoro-82m"]
        piper = BY_NAME["piper-swahili"]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Piper exists but holds nothing the entry expects; Kokoro is complete.
            piper.path(root).mkdir(parents=True)
            kokoro_dir = kokoro.path(root)
            kokoro_dir.mkdir(parents=True)
            (kokoro_dir / ".k9_complete").touch()
            for pattern in self.registry.entry(kokoro.registry_id).get("expect", []):
                (kokoro_dir / pattern.replace("*", "model")).write_bytes(b"weights")
            chosen = choose_model("tts", root)
            self.assertEqual(chosen.name, "kokoro-82m", "an empty Piper folder must not win the tts route")

    def test_requesting_an_incomplete_model_fails_loudly(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileNotFoundError) as caught:
                choose_model("asr", Path(tmp), "whisper-large-v3-turbo")
            self.assertIn("model_not_ready", str(caught.exception))

    def test_unknown_model_is_a_key_error(self) -> None:
        with self.assertRaises(KeyError):
            choose_model("chat", None, "not-a-model")

    def test_statuses_cover_every_spec(self) -> None:
        rows = list(statuses())
        self.assertEqual(len(rows), len(MODEL_SPECS))
        for row in rows:
            self.assertIn(row["status"], {"ready", "partial", "missing"})
            self.assertEqual(row["complete"], row["status"] == "ready")


if __name__ == "__main__":
    unittest.main()
