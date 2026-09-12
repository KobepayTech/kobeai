"""Resolves K9 model locations from config/k9-models.json.

The Python counterpart of scripts/k9-models.mjs and the api-server's
lib/k9-models.ts. Runtime code must get every model, weight and code path from
here — never hard-code a model path.
"""

from __future__ import annotations

import fnmatch
import json
import os
from pathlib import Path
from typing import Any, Mapping

COMPLETE_MARKER = ".k9_complete"
_HERE = Path(__file__).resolve()


def default_config_path() -> Path:
    explicit = os.environ.get("K9_MODELS_CONFIG")
    if explicit:
        return Path(explicit).resolve()
    candidates = (
        _HERE.parents[2] / "config" / "k9-models.json",  # repo: services/k9-runtime/k9_models.py
        _HERE.parents[1] / "config" / "k9-models.json",  # desktop app: resources/runtime/k9_models.py
    )
    return next((c for c in candidates if c.exists()), candidates[0])


def _has_incomplete_downloads(folder: Path) -> bool:
    cache = folder / ".cache" / "huggingface" / "download"
    return cache.exists() and any(p.name.endswith(".incomplete") for p in cache.rglob("*"))


class Registry:
    def __init__(self, path: str | Path | None = None, env: Mapping[str, str] | None = None):
        self.path = Path(path).resolve() if path else default_config_path()
        self.env = os.environ if env is None else env
        self.config: dict[str, Any] = json.loads(self.path.read_text(encoding="utf-8"))
        self.roots = {
            name: Path((root.get("env") and self.env.get(root["env"])) or root["path"])
            for name, root in self.config["roots"].items()
        }

    @property
    def models(self) -> dict[str, dict[str, Any]]:
        return self.config["models"]

    def runtime(self, key: str, default: Any = None) -> Any:
        return self.config.get("runtime", {}).get(key, default)

    def entry(self, model_id: str) -> dict[str, Any]:
        try:
            return self.models[model_id]
        except KeyError:
            raise KeyError(f"{model_id} is not in the K9 model registry ({self.path})") from None

    def path_of(self, model_id: str) -> Path:
        entry = self.entry(model_id)
        return self.roots[entry.get("root", "k9")].joinpath(*entry["path"].split("/"))

    def weights_of(self, model_id: str) -> Path:
        """The file a runtime loads: the entry's `weights` inside its folder, or the entry itself."""
        entry = self.entry(model_id)
        base = self.path_of(model_id)
        return base.joinpath(*entry["weights"].split("/")) if entry.get("weights") else base

    def code_of(self, model_id: str) -> Path:
        entry = self.entry(model_id)
        if not entry.get("code"):
            raise KeyError(f"{model_id} has no `code` path in the K9 model registry")
        return self.path_of(model_id).joinpath(*entry["code"].split("/"))

    def status(self, model_id: str) -> str:
        """"ready" | "partial" | "missing" — the same rules as scripts/k9-models.mjs."""
        entry = self.entry(model_id)
        path = self.path_of(model_id)
        if not path.exists():
            return "missing"
        kind = entry["kind"]
        if kind == "file":
            return "ready" if path.stat().st_size > 0 else "partial"
        if kind == "repo":
            ready = (path / ".git").exists()
        elif kind == "files":
            ready = all(path.joinpath(*f.split("/")).exists() for f in entry["files"])
        else:
            names = os.listdir(path)
            expected = all(
                any(fnmatch.fnmatch(name.lower(), pattern.lower()) for name in names)
                for pattern in entry.get("expect", [])
            )
            if entry["source"]["type"] == "external":
                ready = bool(names) and expected and not _has_incomplete_downloads(path)
            else:
                ready = COMPLETE_MARKER in names and expected
        if ready and entry.get("weights") and not self.weights_of(model_id).exists():
            return "partial"
        if ready and entry.get("code") and not self.code_of(model_id).exists():
            return "partial"
        return "ready" if ready else "partial"
