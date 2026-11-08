"""Measure whether voice can identify a child in one real classroom.

    python3 services/k9-runtime/measure_speaker_id.py recordings/form-2a.json

The manifest names WAV files, never embeddings, because the point is to measure
the whole chain a classroom will actually run: microphone, codec, room, TitaNet.

    {
      "model": "titanet-large",
      "enrol":  [{"student": "STU-001", "wav": "enrol/STU-001-1.wav"}, ...],
      "trials": [{"student": "STU-001", "wav": "lesson/0031.wav",
                  "condition": "lesson", "language": "sw"}, ...]
    }

A trial with `"student": null` is an utterance by someone not enrolled — a
visitor, a teacher, a child who missed enrolment day. Include them. A system
that maps every stranger onto the nearest enrolled child is worse than no
system, and nothing else in the report will reveal that failure.

Collect trials the school will actually produce: mid-lesson, from the back of
the room, in both languages, on the real microphone. Quiet-room English read
from a card measures a product nobody is buying.

The audio is read, embedded, and not kept. This script writes embeddings and
counts, never recordings.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from speaker_harness import Trial, centroid, report  # noqa: E402

SCORE_THRESHOLDS = (0.40, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85)
MARGIN_THRESHOLDS = (0.00, 0.05, 0.10, 0.15, 0.20, 0.25)


def embed_all(paths: list[Path]) -> list[list[float]]:
    """Embed WAV files with the runtime's TitaNet engine."""
    from engines import build_engines
    from k9_models import Registry

    engine = build_engines(Registry())["speaker_id"]
    vectors = []
    for path in paths:
        vectors.append(engine.embedding(path.read_bytes()))
    return vectors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument(
        "--budget",
        type=float,
        default=0.01,
        help="misattribution budget: the share of ALL utterances allowed to land "
        "on the wrong child's profile (default 0.01)",
    )
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text())
    root = args.manifest.parent

    enrolments: dict[str, list[Path]] = {}
    for entry in manifest["enrol"]:
        enrolments.setdefault(entry["student"], []).append(root / entry["wav"])
    trials_in = manifest["trials"]

    flat = [path for paths in enrolments.values() for path in paths]
    vectors = embed_all(flat + [root / entry["wav"] for entry in trials_in])
    enrol_vectors, trial_vectors = vectors[: len(flat)], vectors[len(flat) :]

    roster: dict[str, list[float]] = {}
    cursor = 0
    for student, paths in enrolments.items():
        roster[student] = centroid(enrol_vectors[cursor : cursor + len(paths)])
        cursor += len(paths)

    trials = [
        Trial(
            truth=entry.get("student"),
            embedding=vector,
            condition=entry.get("condition", "unspecified"),
            language=entry.get("language", "unspecified"),
        )
        for entry, vector in zip(trials_in, trial_vectors)
    ]

    result = report(trials, roster, SCORE_THRESHOLDS, MARGIN_THRESHOLDS, args.budget)
    if args.json:
        print(json.dumps(result.as_dict(), indent=2))
        return 0 if result.overall else 1

    print(f"roster: {len(roster)} enrolled  ·  trials: {len(trials)}")
    print(f"misattribution budget: {args.budget:.1%} of all utterances\n")
    if result.overall is None:
        print(result.verdict())
        return 1
    chosen = result.overall
    print(f"thresholds   min_score {chosen.min_score:.2f}  min_margin {chosen.min_margin:.2f}")
    print(f"coverage     {chosen.coverage:.1%} of utterances attributed")
    print(f"precision    {chosen.precision:.1%} of those attributions correct")
    print(f"misattributed {chosen.misattributed}  false-accept {chosen.false_accept}"
          f"  declined {chosen.declined}")
    for name, group in result.slices.items():
        print(f"\nby {name}:")
        for value, outcome in group.items():
            print(
                f"  {value:<14} coverage {outcome.coverage:>6.1%}   "
                f"wrong {outcome.wrong:>3}/{outcome.total:<4} "
                f"({outcome.misattribution_rate:.1%})"
            )
    print(f"\n{result.verdict()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
