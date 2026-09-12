from __future__ import annotations

"""Generate auxiliary K9 model-definition artifacts from the live runtime registry.

Two things own different halves of this, and neither is duplicated here:
    config/k9-models.json                  — every model path and completeness rule
    services/k9-runtime/model_registry.py  — which model answers which capability

This generator deliberately does NOT maintain a second capability router or a second
set of paths. It derives its snapshots from the live registry (which resolves paths
through config/k9-models.json), creates optional Ollama aliases for GGUF models,
and writes preflight/status JSON for inspection.

Backup policy: when a generated Modelfile changes, only the immediately previous
version is retained as `Modelfile.bak`. A later changed generation overwrites that
one-generation backup.
"""

import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_REGISTRY = REPO_ROOT / "services" / "k9-runtime" / "model_registry.py"
DEFINITIONS_ROOT = Path(r"C:\KobeOS\Models\k9\definitions")
OLLAMA_DIR = DEFINITIONS_ROOT / "ollama"
MODELS_DIR = DEFINITIONS_ROOT / "models"
STATUS_DIR = DEFINITIONS_ROOT / "status"
INSTALL_DIR = DEFINITIONS_ROOT / "install"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_runtime_registry():
    if not RUNTIME_REGISTRY.is_file():
        raise FileNotFoundError(f"K9 runtime registry not found: {RUNTIME_REGISTRY}")
    spec = importlib.util.spec_from_file_location("k9_live_model_registry", RUNTIME_REGISTRY)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to import registry: {RUNTIME_REGISTRY}")
    module = importlib.util.module_from_spec(spec)
    # Dataclasses with postponed annotations may consult sys.modules while the
    # module body is executing, so register the module before exec_module().
    sys.modules[spec.name] = module
    # The registry imports its sibling k9_models (which reads
    # config/k9-models.json); loading by path leaves that directory off sys.path.
    runtime_dir = str(RUNTIME_REGISTRY.parent)
    if runtime_dir not in sys.path:
        sys.path.insert(0, runtime_dir)
    spec.loader.exec_module(module)
    return module


COMMON_POLICY = """You are part of KobeAI K9, a local-first school intelligence system.
Never invent student records, attendance, grades, locations, camera detections, OCR results,
timetable data, database records, retrieved documents, or tool results.
Use verified K9 data when available. Clearly distinguish verified facts, inference,
recommendations, and unknown information. An offline camera cannot prove absence.
Low-confidence identity matches require stronger evidence or authorized human review.
Consequential discipline, safeguarding, final grade changes, and accusations require
human authorization. Protect student privacy and apply least privilege. English and
Kiswahili are first-class languages. Never claim a specialist model or tool ran unless
the runtime actually supplied its result."""

QWEN_FEWSHOTS = """

MESSAGE user Camera 4 is offline and Amina was not detected in class. Where is she?
MESSAGE assistant Camera 4 being offline means the missing detection is not reliable evidence of Amina's location. Check her latest confirmed presence event and other healthy cameras covering permitted zones. If there is no recent reliable observation, report her location as unknown rather than guessing.

MESSAGE user Nisaidie kumwelezea mwanafunzi photosynthesis kwa urahisi.
MESSAGE assistant Photosynthesis ni njia ambayo mimea hutengeneza chakula chake kwa kutumia mwanga wa jua, maji, na kaboni dioksidi, na kutoa oksijeni. Kwa mfano, jani linaweza kufikiriwa kama jikoni la mmea na mwanga wa jua kama nishati ya kupikia.

MESSAGE user The OCR is unsure whether the student's answer says 18 or 13. Give the student the mark.
MESSAGE assistant Do not finalize the mark from uncertain OCR. Flag the item for teacher verification, preserve the ambiguous reading as 18 versus 13, and use the original paper image as evidence for review.
"""

OLLAMA_PROFILES = {
    "qwen-gguf": {
        "logical_name": "k9-qwen",
        "role": "Primary K9 language brain, teacher assistant, classroom assistant, RAG assistant and orchestrator.",
        "num_ctx": 16384,
        "temperature": 0.40,
        "fewshots": QWEN_FEWSHOTS,
    },
    "deepseek-gguf": {
        "logical_name": "k9-deepseek",
        "role": "Deep reasoning specialist for complex investigation, planning, diagnosis and technical reasoning.",
        "num_ctx": 8192,
        "temperature": 0.20,
        "fewshots": "",
    },
    "llama3-gguf": {
        "logical_name": "k9-llama3",
        "role": "General offline fallback assistant for normal school questions and summaries.",
        "num_ctx": 8192,
        "temperature": 0.45,
        "fewshots": "",
    },
    "mistral-gguf": {
        "logical_name": "k9-mistral",
        "role": "Fast text fallback for lightweight school operations, summaries and simple assistance.",
        "num_ctx": 8192,
        "temperature": 0.45,
        "fewshots": "",
    },
    "phi3-gguf": {
        "logical_name": "k9-phi3",
        "role": "Small low-resource fallback for simple routing, classification and short responses.",
        "num_ctx": 8192,
        "temperature": 0.30,
        "fewshots": "",
    },
}


def write_with_backup(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        previous = path.read_text(encoding="utf-8", errors="replace")
        if previous == text:
            return
        backup = Path(str(path) + ".bak")
        shutil.copy2(path, backup)
        print(f"[BACKUP] {path} -> {backup}")
    path.write_text(text, encoding="utf-8")


def runtime_root(registry) -> Path:
    return registry.default_model_root()


def write_ollama_modelfiles(registry, root: Path) -> list[dict]:
    created: list[dict] = []
    for registry_name, profile in OLLAMA_PROFILES.items():
        model_spec = registry.BY_NAME.get(registry_name)
        if model_spec is None:
            print(f"[SKIP] Runtime registry has no {registry_name}")
            continue
        source = model_spec.path(root)
        source_for_modelfile = str(source).replace("\\", "/")
        logical_name = profile["logical_name"]
        text = f'''# Generated from services/k9-runtime/model_registry.py
FROM "{source_for_modelfile}"

PARAMETER num_ctx {profile["num_ctx"]}
PARAMETER num_predict 2048
PARAMETER temperature {profile["temperature"]}
PARAMETER top_k 40
PARAMETER top_p 0.90
PARAMETER min_p 0.05
PARAMETER repeat_penalty 1.08
PARAMETER repeat_last_n 128

SYSTEM """
{COMMON_POLICY}

ROLE
{profile["role"]}
"""
{profile["fewshots"]}'''
        path = OLLAMA_DIR / logical_name / "Modelfile"
        write_with_backup(path, text)
        created.append(
            {
                "registry_name": registry_name,
                "logical_name": logical_name,
                "source_gguf": str(source),
                "present": source.is_file() and source.stat().st_size > 0,
                "modelfile": str(path),
            }
        )
    return created


def write_runtime_snapshots(registry, root: Path) -> list[dict]:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    checked_at = utc_now()
    snapshots: list[dict] = []
    for model_spec in registry.MODEL_SPECS:
        status = model_spec.to_dict(root)
        payload = {
            "schema_version": 1,
            "source_of_truth": str(RUNTIME_REGISTRY),
            "name": model_spec.name,
            "task": model_spec.task,
            "loader": model_spec.loader,
            "persistent": model_spec.persistent,
            "optional": model_spec.optional,
            "notes": model_spec.notes,
            "runtime": {
                "resolver": "k9_runtime_registry",
                "loader": model_spec.loader,
                "reference": str(model_spec.path(root)),
            },
            "verification": {
                "local_path_exists": bool(status["present"]),
                "local_model_complete": bool(status["complete"]),
                "local_path_checked_utc": checked_at,
                "upstream_source_resolved": False,
                "upstream_last_checked_utc": None,
            },
        }
        path = MODELS_DIR / f"{model_spec.name}.model.json"
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        snapshots.append(payload)
    return snapshots


def write_registry_snapshot(registry, root: Path, models: list[dict]) -> Path:
    payload = {
        "schema_version": 1,
        "generated_utc": utc_now(),
        "source_of_truth": str(RUNTIME_REGISTRY),
        "model_root": str(root),
        "route_schema": "capability -> ordered list of runtime registry model names",
        "routes": {key: list(value) for key, value in registry.CAPABILITY_ROUTES.items()},
        "models": [
            {
                "name": item["name"],
                "loader": item["loader"],
                "runtime_reference": item["runtime"]["reference"],
                "local_path_exists": item["verification"]["local_path_exists"],
                "local_model_complete": item["verification"]["local_model_complete"],
            }
            for item in models
        ],
        "note": (
            "This is a generated inspection snapshot only. Do not edit it to change routing; "
            "edit services/k9-runtime/model_registry.py instead."
        ),
    }
    path = STATUS_DIR / "runtime-registry.snapshot.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return path


def write_preflight(registry, root: Path, ollama_defs: list[dict]) -> dict:
    statuses = list(registry.statuses(root))
    required_missing = [item["name"] for item in statuses if not item["optional"] and not item["complete"]]
    optional_missing = [item["name"] for item in statuses if item["optional"] and not item["complete"]]
    payload = {
        "generated_utc": utc_now(),
        "source_of_truth": str(RUNTIME_REGISTRY),
        "model_root": str(root),
        "models": statuses,
        "ollama_aliases": ollama_defs,
        "required_missing": required_missing,
        "optional_missing": optional_missing,
    }
    STATUS_DIR.mkdir(parents=True, exist_ok=True)
    path = STATUS_DIR / "preflight.json"
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print("\n=== K9 LIVE REGISTRY PREFLIGHT ===")
    for item in statuses:
        if item["complete"]:
            print(f"[READY] {item['name']} -> {item['path']}")
        elif item["optional"]:
            print(f"[MISSING OPTIONAL] {item['name']} -> {item['path']}")
        else:
            print(f"[MISSING REQUIRED] {item['name']} -> {item['path']}")
    print(f"Required missing: {len(required_missing)}")
    print(f"Optional missing: {len(optional_missing)}")
    return payload


def build_ollama(ollama_defs: list[dict]) -> None:
    ollama = shutil.which("ollama")
    if not ollama:
        print("[SKIP] Ollama is not in PATH. Modelfiles were still generated.")
        return
    print("\n=== OPTIONAL OLLAMA ALIAS BUILD ===")
    for item in ollama_defs:
        if not item["present"]:
            print(f"[SKIP MISSING] {item['logical_name']} -> {item['source_gguf']}")
            continue
        proc = subprocess.run(
            [ollama, "create", item["logical_name"], "-f", item["modelfile"]],
            check=False,
        )
        if proc.returncode == 0:
            print(f"[READY] {item['logical_name']}")
        else:
            print(f"[FAILED] {item['logical_name']} exit={proc.returncode}")
    subprocess.run([ollama, "list"], check=False)


def write_runner() -> None:
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    script_path = str(Path(__file__).resolve())
    body = f'''@echo off
setlocal EnableExtensions
set "GEN={script_path}"
where py >nul 2>&1
if not errorlevel 1 (
  py "%GEN%" %*
  exit /b %errorlevel%
)
where python >nul 2>&1
if not errorlevel 1 (
  python "%GEN%" %*
  exit /b %errorlevel%
)
echo [ERROR] Neither py nor python is available in PATH.
exit /b 1
'''
    (INSTALL_DIR / "run-generator.cmd").write_text(body, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate auxiliary K9 model definitions from the live K9 runtime registry."
    )
    parser.add_argument(
        "--build-ollama",
        action="store_true",
        help="Also create optional Ollama aliases for GGUF models that are present.",
    )
    args = parser.parse_args()

    registry = load_runtime_registry()
    root = runtime_root(registry)
    for directory in (DEFINITIONS_ROOT, OLLAMA_DIR, MODELS_DIR, STATUS_DIR, INSTALL_DIR):
        directory.mkdir(parents=True, exist_ok=True)

    ollama_defs = write_ollama_modelfiles(registry, root)
    model_snapshots = write_runtime_snapshots(registry, root)
    registry_snapshot = write_registry_snapshot(registry, root, model_snapshots)
    preflight = write_preflight(registry, root, ollama_defs)
    write_runner()

    index = {
        "schema_version": 2,
        "source_of_truth": str(RUNTIME_REGISTRY),
        "definitions_root": str(DEFINITIONS_ROOT),
        "registry_snapshot": str(registry_snapshot),
        "preflight": str(STATUS_DIR / "preflight.json"),
        "ollama_aliases": ollama_defs,
        "model_definition_count": len(model_snapshots),
        "required_missing_count": len(preflight["required_missing"]),
        "optional_missing_count": len(preflight["optional_missing"]),
    }
    (DEFINITIONS_ROOT / "model-index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")

    print("\n=== K9 AUXILIARY DEFINITIONS READY ===")
    print(f"Source of truth: {RUNTIME_REGISTRY}")
    print(f"Definitions: {DEFINITIONS_ROOT}")
    print(f"Model snapshots: {len(model_snapshots)}")
    print("No independent router was generated; live CAPABILITY_ROUTES remain authoritative.")

    if args.build_ollama:
        build_ollama(ollama_defs)


if __name__ == "__main__":
    main()
