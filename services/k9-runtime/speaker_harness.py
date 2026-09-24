"""Does a voice actually identify a child in a Tanzanian classroom?

Everything else in the classroom-intelligence design is ordinary engineering.
This part is a research risk, and `docs/K9_ARCHITECTURE.md` already says why:
TitaNet-Large is trained overwhelmingly on adult English speech, while a Form 2
class is forty same-age children alternating between English and Kiswahili in a
reverberant room. Children's voices sit closer together in embedding space than
adults' do, so the margin between the right child and the next one is the thing
that decides whether any of this works.

This module measures that, and nothing else. It deliberately depends only on the
standard library: the arithmetic that produces the number has to be checkable on
any machine, in CI, without weights, torch or a GPU.

The number it produces is *not* accuracy. Accuracy over accepted utterances can
be made to look excellent by accepting almost nothing. The number that decides
the product is:

    how much of the class can we attribute, while misattributing under X%?

Misattribution is the expensive error. Writing Amina's question onto Joseph's
learning profile corrupts the evidence the skill engine reasons from, and no one
ever finds out. Refusing to attribute is cheap: the insight is still recorded at
class level, which `POST /v1/classroom/insights` already does. So the sweep
reports coverage against misattribution, and `choose_thresholds` picks the most
permissive setting that stays inside a misattribution budget.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Sequence

Vector = Sequence[float]

# An utterance whose true speaker is not enrolled at all — a visitor, a teacher,
# a child who missed enrolment day. These must land as "unknown". A system that
# maps every stranger onto the nearest enrolled child is worse than no system.
UNENROLLED = None


def normalise(vector: Vector) -> list[float]:
    """Unit-length copy. A zero vector stays zero rather than dividing by zero."""
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0.0:
        return [0.0] * len(vector)
    return [value / norm for value in vector]


def cosine(a: Vector, b: Vector) -> float:
    """Cosine similarity, clamped to [-1, 1] against floating-point drift."""
    if len(a) != len(b):
        raise ValueError(f"embedding length mismatch: {len(a)} vs {len(b)}")
    norm_a = math.sqrt(sum(value * value for value in a))
    norm_b = math.sqrt(sum(value * value for value in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    return max(-1.0, min(1.0, dot / (norm_a * norm_b)))


def centroid(vectors: Sequence[Vector]) -> list[float]:
    """The enrolled profile: mean of per-sample embeddings, re-normalised.

    Samples are averaged *after* each is unit-normalised, so one loud close-mic
    sample cannot outweigh three quiet ones. This is why enrolment takes several
    utterances rather than one: a child's voice moves with distance, illness,
    emotion and mic position, and the centroid is only useful if it spans that.
    """
    if not vectors:
        raise ValueError("cannot build a voice profile from zero samples")
    unit = [normalise(vector) for vector in vectors]
    width = len(unit[0])
    if any(len(vector) != width for vector in unit):
        raise ValueError("enrolment samples have inconsistent embedding length")
    return normalise([sum(vector[i] for vector in unit) / len(unit) for i in range(width)])


@dataclass(frozen=True)
class Candidate:
    student_code: str
    score: float


@dataclass(frozen=True)
class Identification:
    """One attribution decision, with the evidence that produced it."""

    top: Candidate | None
    runner_up: Candidate | None
    accepted: bool
    #: top score minus runner-up score. On a roster of one, the margin is the
    #: top score itself — there is nothing to be confused with.
    margin: float

    @property
    def student_code(self) -> str | None:
        return self.top.student_code if (self.accepted and self.top) else None


def rank(embedding: Vector, roster: Mapping[str, Vector]) -> list[Candidate]:
    """Score against this classroom's roster only, best first.

    Scoring one utterance against all 5,000 students in the school is both slower
    and less accurate: every extra enrolled voice is another chance for a closer
    false match. The timetable already says which class is in the room.
    """
    scored = [Candidate(code, cosine(embedding, profile)) for code, profile in roster.items()]
    # Sort by score, then by code, so equal scores rank deterministically rather
    # than by dict insertion order — a tie must not depend on roster ordering.
    scored.sort(key=lambda candidate: (-candidate.score, candidate.student_code))
    return scored


def identify(
    embedding: Vector,
    roster: Mapping[str, Vector],
    min_score: float,
    min_margin: float,
) -> Identification:
    """Attribute an utterance, or refuse to.

    Two gates, because they catch different failures:

    - `min_score` catches a speaker who is not in the room at all. A stranger's
      best match may still beat every rival, so a margin test alone accepts them.
    - `min_margin` catches two children who genuinely sound alike. Both score
      highly; the top one is close to a coin toss, and that is exactly the case
      that must not be written to a profile.
    """
    ranked = rank(embedding, roster)
    if not ranked:
        return Identification(None, None, False, 0.0)
    top = ranked[0]
    runner_up = ranked[1] if len(ranked) > 1 else None
    margin = top.score - runner_up.score if runner_up else top.score
    accepted = top.score >= min_score and margin >= min_margin
    return Identification(top, runner_up, accepted, margin)


@dataclass(frozen=True)
class Trial:
    """One held-out utterance with known ground truth.

    `condition` and `language` exist because a single headline number hides the
    only thing worth knowing. Quiet-room English will flatter the system; mid-
    lesson Kiswahili is what a school actually buys.
    """

    truth: str | None
    embedding: Vector
    condition: str = "unspecified"
    language: str = "unspecified"


@dataclass
class Outcome:
    """What one threshold pair did to a set of trials."""

    min_score: float
    min_margin: float
    correct: int = 0
    #: Accepted, but attributed to the wrong enrolled child. The expensive error.
    misattributed: int = 0
    #: Accepted an utterance whose speaker is not enrolled at all. Also expensive:
    #: a visitor's question lands on some child's permanent record.
    false_accept: int = 0
    #: Declined to attribute an enrolled child. Cheap — the insight still lands
    #: at class level — but too many of these and the feature is not worth having.
    declined: int = 0
    #: Correctly declined an unenrolled speaker.
    correctly_unknown: int = 0

    @property
    def total(self) -> int:
        return self.correct + self.misattributed + self.false_accept + self.declined + self.correctly_unknown

    @property
    def accepted(self) -> int:
        return self.correct + self.misattributed + self.false_accept

    @property
    def wrong(self) -> int:
        """Every accepted attribution that was not the right child."""
        return self.misattributed + self.false_accept

    @property
    def coverage(self) -> float:
        """Share of all utterances that got attributed to a student."""
        return self.accepted / self.total if self.total else 0.0

    @property
    def misattribution_rate(self) -> float:
        """Share of ALL utterances that landed on the wrong child's profile.

        Measured over every trial, not just accepted ones, because that is the
        rate at which a running classroom corrupts its own evidence. Quoting it
        over accepted utterances alone flatters a system that accepts little.
        """
        return self.wrong / self.total if self.total else 0.0

    @property
    def precision(self) -> float:
        """Of the attributions made, the share that were right."""
        return self.correct / self.accepted if self.accepted else 0.0

    def as_dict(self) -> dict[str, float | int]:
        return {
            "min_score": round(self.min_score, 4),
            "min_margin": round(self.min_margin, 4),
            "trials": self.total,
            "correct": self.correct,
            "misattributed": self.misattributed,
            "false_accept": self.false_accept,
            "declined": self.declined,
            "correctly_unknown": self.correctly_unknown,
            "coverage": round(self.coverage, 4),
            "precision": round(self.precision, 4),
            "misattribution_rate": round(self.misattribution_rate, 4),
        }


def evaluate(
    trials: Iterable[Trial],
    roster: Mapping[str, Vector],
    min_score: float,
    min_margin: float,
) -> Outcome:
    outcome = Outcome(min_score=min_score, min_margin=min_margin)
    for trial in trials:
        decision = identify(trial.embedding, roster, min_score, min_margin)
        chosen = decision.student_code
        if chosen is None:
            if trial.truth is UNENROLLED:
                outcome.correctly_unknown += 1
            else:
                outcome.declined += 1
        elif trial.truth is UNENROLLED:
            outcome.false_accept += 1
        elif chosen == trial.truth:
            outcome.correct += 1
        else:
            outcome.misattributed += 1
    return outcome


def sweep(
    trials: Sequence[Trial],
    roster: Mapping[str, Vector],
    score_thresholds: Sequence[float],
    margin_thresholds: Sequence[float],
) -> list[Outcome]:
    return [
        evaluate(trials, roster, score, margin)
        for score in score_thresholds
        for margin in margin_thresholds
    ]


def choose_thresholds(outcomes: Sequence[Outcome], misattribution_budget: float) -> Outcome | None:
    """The most permissive setting that stays inside the budget.

    "Most permissive" means highest coverage, because coverage is the product:
    an identity layer that attributes 20% of what is said is not an identity
    layer. Ties break towards the higher score threshold, then the higher margin,
    so that two settings which cover the same share of the class resolve to the
    more conservative one. Returns None when no setting is safe enough, which is
    itself the answer: voice cannot be the primary identity mechanism here.
    """
    safe = [o for o in outcomes if o.misattribution_rate <= misattribution_budget]
    if not safe:
        return None
    return max(safe, key=lambda o: (o.coverage, o.min_score, o.min_margin))


def by_slice(trials: Sequence[Trial], attribute: str) -> dict[str, list[Trial]]:
    """Split trials by `condition` or `language` for a per-slice report."""
    if attribute not in {"condition", "language"}:
        raise ValueError("can only slice by condition or language")
    groups: dict[str, list[Trial]] = {}
    for trial in trials:
        groups.setdefault(getattr(trial, attribute), []).append(trial)
    return groups


@dataclass
class Report:
    overall: Outcome | None
    slices: dict[str, dict[str, Outcome]] = field(default_factory=dict)
    budget: float = 0.01

    def as_dict(self) -> dict[str, object]:
        return {
            "misattribution_budget": self.budget,
            "recommended": self.overall.as_dict() if self.overall else None,
            "verdict": self.verdict(),
            "slices": {
                name: {value: outcome.as_dict() for value, outcome in group.items()}
                for name, group in self.slices.items()
            },
        }

    def verdict(self) -> str:
        if self.overall is None:
            return (
                "No threshold keeps misattribution inside the budget. Voice cannot be the "
                "primary identity mechanism for this cohort on this model; attribute at "
                "class level and identify by another route."
            )
        worst = min(
            (outcome.coverage for group in self.slices.values() for outcome in group.values()),
            default=self.overall.coverage,
        )
        if worst < self.overall.coverage / 2:
            return (
                f"Usable overall ({self.overall.coverage:.0%} coverage) but one slice collapses "
                f"to {worst:.0%}. Report per slice before trusting the headline."
            )
        return f"Usable: {self.overall.coverage:.0%} of utterances attributed within budget."


def report(
    trials: Sequence[Trial],
    roster: Mapping[str, Vector],
    score_thresholds: Sequence[float],
    margin_thresholds: Sequence[float],
    misattribution_budget: float = 0.01,
) -> Report:
    """Run the full sweep, pick a setting, then re-measure each slice at it.

    The slices are evaluated at the *chosen* thresholds rather than at their own
    best ones, because a school runs one configuration. Knowing that Kiswahili
    would be fine at some other threshold is not useful if the room is set to
    this one.
    """
    outcomes = sweep(trials, roster, score_thresholds, margin_thresholds)
    chosen = choose_thresholds(outcomes, misattribution_budget)
    result = Report(overall=chosen, budget=misattribution_budget)
    if chosen is None:
        return result
    for attribute in ("condition", "language"):
        groups = by_slice(trials, attribute)
        if len(groups) > 1:
            result.slices[attribute] = {
                value: evaluate(group, roster, chosen.min_score, chosen.min_margin)
                for value, group in sorted(groups.items())
            }
    return result
