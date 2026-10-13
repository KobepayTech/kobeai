"""Plug-and-play model warehouse — a view over the one canonical registry.

This began as a second registry with its own `config/model-warehouse.json`, its
own root and its own env var. Two registries is how a school ends up with a
model that one half of the system can see and the other half cannot, and how a
weight gets shipped that nobody checked the licence on. So the warehouse keeps
its interface — `scan()`, `route()`, categories, a licence gate — and reads
`config/k9-models.json`, which stays the single source of truth for every path,
root and download.

What it adds to that registry, and what the merge was worth keeping:

- **`capability`** — a stable vocabulary ("speech-to-text", "speaker-id") that
  callers route on, so a model swap is a registry edit rather than a code
  change.
- **`use`** — the licence position for shipping a weight in a paid build.
  `route()` returns only `commercial`. A weight whose terms have not been read
  cannot reach a school because somebody wired it up in a hurry — which is
  exactly how the HeyCyan SDK came to be compiled into every Rokid build.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from k9_models import Registry

#: Licence positions. Only the first may be shipped.
SHIPPABLE = "commercial"
USE_VALUES = (SHIPPABLE, "review", "restricted")


class ModelNotReady(RuntimeError):
    """No model can serve this capability on this machine, and why."""


class ModelWarehouse:
    def __init__(self, registry: Registry | None = None):
        self.registry = registry or Registry()

    @property
    def roots(self) -> dict[str, Path]:
        return dict(self.registry.roots)

    def describe(self, model_id: str) -> dict[str, Any]:
        entry = self.registry.entry(model_id)
        status = self.registry.status(model_id)
        use = entry.get("use", SHIPPABLE)
        return {
            "id": model_id,
            "category": entry.get("category"),
            "capability": entry.get("capability"),
            "role": entry.get("role"),
            "path": str(self.registry.path_of(model_id)),
            "use": use,
            # A present-but-unshippable weight is "blocked", not "ready": it is
            # on disk and deliberately unavailable, which is a different thing
            # for an operator to see than "missing".
            "status": "blocked" if status == "ready" and use != SHIPPABLE else status,
            "gated": bool(entry.get("gated")),
            "required": bool(entry.get("required")),
        }

    def scan(self) -> list[dict[str, Any]]:
        return [self.describe(model_id) for model_id in self.registry.models]

    def capabilities(self) -> list[str]:
        seen = {
            entry.get("capability")
            for entry in self.registry.models.values()
            if entry.get("capability")
        }
        return sorted(seen)

    def route(self, capability: str) -> dict[str, Any]:
        """The model that will serve this capability, or why none can.

        Deliberately not "the first that exists": a weight on disk whose licence
        forbids shipping is worse than a missing one, because it works.
        """
        candidates = [m for m in self.scan() if m["capability"] == capability]
        if not candidates:
            raise ModelNotReady(f"no model in the registry serves {capability!r}")
        for model in candidates:
            if model["status"] == "ready":
                return model
        blocked = [m["id"] for m in candidates if m["status"] == "blocked"]
        if blocked:
            raise ModelNotReady(
                f"{capability}: {', '.join(blocked)} present but not licensed for a "
                f"shipped build (use != {SHIPPABLE})"
            )
        missing = ", ".join(m["id"] for m in candidates)
        raise ModelNotReady(f"{capability}: not downloaded ({missing})")


warehouse = ModelWarehouse()
