"""Tests for the model warehouse and subject agents.

Standard library only: these run in CI with no weights, no torch and no
FastAPI, which is the point — the licence gate and the routing rules are the
part that must not be able to break quietly.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from classroom_audio import DEFAULT_AGENT, SUBJECT_AGENTS, agent_for  # noqa: E402
from k9_models import Registry  # noqa: E402
from model_warehouse import SHIPPABLE, ModelNotReady, ModelWarehouse  # noqa: E402

CANONICAL = Path(__file__).resolve().parents[2] / "config" / "k9-models.json"


def warehouse_over(models: dict, root: Path) -> ModelWarehouse:
    """A warehouse over a throwaway registry, so tests never need real weights."""
    config = {
        "version": 1,
        "roots": {"k9": {"path": str(root)}},
        "models": models,
    }
    handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    json.dump(config, handle)
    handle.close()
    return ModelWarehouse(Registry(handle.name))


def spec(capability: str, path: str, use: str = SHIPPABLE) -> dict:
    return {
        "category": "audio",
        "capability": capability,
        "path": path,
        "kind": "dir",
        "use": use,
        "source": {"type": "hf", "repo": "test/fixture"},
    }


def download(root: Path, name: str) -> None:
    """Mark a model folder complete, the way the K9 downloader does."""
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "config.json").write_text("{}")
    (folder / ".k9_complete").write_text("")


class TestCanonicalRegistry(unittest.TestCase):
    """There is one registry. The warehouse is a view, not a second one."""

    def setUp(self):
        self.config = json.loads(CANONICAL.read_text(encoding="utf-8"))

    def test_there_is_no_second_registry_file(self):
        # config/model-warehouse.json was a parallel registry with its own root
        # and env var. Two registries is how a model becomes visible to one half
        # of the system and invisible to the other.
        rival = CANONICAL.parent / "model-warehouse.json"
        self.assertFalse(rival.exists(), "the warehouse must read config/k9-models.json")

    def test_every_model_states_a_licence_position(self):
        for model_id, entry in self.config["models"].items():
            self.assertIn(
                entry.get("use", SHIPPABLE),
                ("commercial", "review", "restricted"),
                f"{model_id} has an unrecognised `use`",
            )

    def test_the_audio_identity_chain_is_routable(self):
        # If any of these lose their capability the classroom voice path has no
        # model to ask for, and the failure would only show up on a school PC.
        capabilities = {
            entry.get("capability")
            for entry in self.config["models"].values()
            if entry.get("capability")
        }
        for needed in ("vad", "speech-to-text", "speaker-id", "diarization"):
            self.assertIn(needed, capabilities, f"nothing serves {needed}")


class TestRouting(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def test_routes_to_a_downloaded_model(self):
        download(self.root, "asr")
        house = warehouse_over({"asr_a": spec("speech-to-text", "asr")}, self.root)
        self.assertEqual(house.route("speech-to-text")["id"], "asr_a")

    def test_a_present_but_unlicensed_weight_is_blocked_not_ready(self):
        # The important case. A research-only weight sitting on disk *works*,
        # which is exactly why it must not be routable: it would ship.
        download(self.root, "asr")
        house = warehouse_over(
            {"asr_a": spec("speech-to-text", "asr", use="restricted")}, self.root
        )
        self.assertEqual(house.describe("asr_a")["status"], "blocked")
        with self.assertRaises(ModelNotReady) as caught:
            house.route("speech-to-text")
        self.assertIn("not licensed", str(caught.exception))

    def test_a_licensed_model_is_preferred_over_a_blocked_one(self):
        for name in ("free", "paid"):
            download(self.root, name)
        house = warehouse_over(
            {
                "blocked_one": spec("speech-to-text", "free", use="restricted"),
                "shippable": spec("speech-to-text", "paid"),
            },
            self.root,
        )
        self.assertEqual(house.route("speech-to-text")["id"], "shippable")

    def test_missing_and_unknown_fail_differently(self):
        house = warehouse_over({"asr_a": spec("speech-to-text", "asr")}, self.root)
        with self.assertRaises(ModelNotReady) as missing:
            house.route("speech-to-text")
        self.assertIn("not downloaded", str(missing.exception))
        with self.assertRaises(ModelNotReady) as unknown:
            house.route("text-to-speech")
        self.assertIn("no model in the registry", str(unknown.exception))


class TestSubjectAgents(unittest.TestCase):
    def test_every_subject_has_a_distinct_voice(self):
        voices = [agent["voice"] for agent in SUBJECT_AGENTS.values()]
        self.assertEqual(len(voices), len(set(voices)), "two subjects share a voice")

    def test_lookup_is_forgiving_about_how_a_timetable_spells_a_subject(self):
        self.assertEqual(agent_for("Mathematics"), agent_for("mathematics"))
        self.assertEqual(agent_for("computer science"), SUBJECT_AGENTS["computer_science"])

    def test_an_unknown_subject_still_gets_a_teacher(self):
        # Silence in a classroom is a worse failure than a generic voice.
        self.assertEqual(agent_for("Basic Mathematics"), DEFAULT_AGENT)
        self.assertEqual(agent_for(None), DEFAULT_AGENT)
        self.assertEqual(agent_for(""), DEFAULT_AGENT)

    def test_callers_cannot_mutate_the_shared_table(self):
        agent_for("mathematics")["voice"] = "tampered"
        self.assertEqual(SUBJECT_AGENTS["mathematics"]["voice"], "teacher-a")


if __name__ == "__main__":
    unittest.main()
