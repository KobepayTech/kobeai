"""Turning a room's audio into speech turns worth acting on.

Everything here is pure and standard-library only, so the rules that decide
what becomes a question — and what is thrown away — are checkable without a
microphone, a GPU or a model. `gateway.py` does the I/O.

The pipeline is deliberately lossy. A classroom produces far more speech than
it produces questions, and most of the work is deciding what *not* to send on.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

#: A diarizer splits one spoken sentence into several turns whenever the
#: speaker breathes. Merging same-speaker turns closer than this keeps "why do
#: we... move the 5 over there?" as one question instead of two fragments.
MERGE_GAP_SECONDS = 0.7

#: TitaNet needs enough voiced material for a stable embedding. Below this a
#: turn can still be transcribed and merged, but must never be identified: a
#: half-second "ndiyo" matched against forty children is the classic false
#: match.
MIN_IDENTIFY_SECONDS = 0.5

#: Nothing shorter than this is worth sending anywhere.
MIN_USEFUL_SECONDS = 0.35

#: How much of a turn may be covered by another speaker before the audio is no
#: longer cleanly one person's. Overlapped speech is asked to be repeated
#: rather than attributed to whoever the embedding happened to favour.
MAX_OVERLAP_RATIO = 0.25

#: A single turn longer than this is a teacher talking, not a question.
MAX_TURN_SECONDS = 30.0


@dataclass(frozen=True)
class Turn:
    start: float
    end: float
    speaker: str

    @property
    def seconds(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass(frozen=True)
class Candidate:
    """A turn that survived, and what may be done with it."""

    turn: Turn
    #: Enough clean, long-enough audio to attempt speaker identification.
    identifiable: bool
    #: Another speaker was talking over this one.
    overlapped: bool
    reason: str


def overlap_seconds(a: Turn, b: Turn) -> float:
    return max(0.0, min(a.end, b.end) - max(a.start, b.start))


def merge_adjacent(turns: list[Turn], gap: float = MERGE_GAP_SECONDS) -> list[Turn]:
    """Join consecutive turns from the same speaker separated by a short pause.

    Only consecutive ones: if another speaker spoke in between, the two are a
    genuine exchange and joining them would put someone else's words inside
    this speaker's turn.
    """
    ordered = sorted(turns, key=lambda t: (t.start, t.end, t.speaker))
    merged: list[Turn] = []
    for turn in ordered:
        if merged and merged[-1].speaker == turn.speaker and turn.start - merged[-1].end <= gap:
            merged[-1] = replace(merged[-1], end=max(merged[-1].end, turn.end))
        else:
            merged.append(turn)
    return merged


def clip_to_speech(turns: list[Turn], speech: list[tuple[float, float]]) -> list[Turn]:
    """Keep only the parts of each turn where the VAD actually heard speech.

    Diarization runs over whatever it is given and will happily assign a label
    to the hum of a fan. The VAD is cheap and runs first, so its segments are
    the ground truth for "was anyone talking at all".
    """
    kept: list[Turn] = []
    for turn in turns:
        for start, end in speech:
            overlap_start, overlap_end = max(turn.start, start), min(turn.end, end)
            if overlap_end - overlap_start >= MIN_USEFUL_SECONDS:
                kept.append(Turn(round(overlap_start, 3), round(overlap_end, 3), turn.speaker))
    return merge_adjacent(kept)


def candidates(
    turns: list[Turn],
    speech: list[tuple[float, float]],
    max_overlap_ratio: float = MAX_OVERLAP_RATIO,
) -> list[Candidate]:
    """The turns worth sending on, each with what may be done with it.

    Nothing is silently discarded for being overlapped or short: the caller
    still transcribes those and can show "we did not catch who said that".
    Dropping them entirely would make the room look quieter than it was.
    """
    cleaned = clip_to_speech(turns, speech)
    out: list[Candidate] = []
    for turn in cleaned:
        if turn.seconds < MIN_USEFUL_SECONDS:
            continue
        if turn.seconds > MAX_TURN_SECONDS:
            # Almost certainly the teacher. Keep it, never identify it: a long
            # stretch of teaching is not a question anyone asked.
            out.append(Candidate(turn, False, False, "too_long_to_be_a_question"))
            continue
        covered = sum(
            overlap_seconds(turn, other)
            for other in cleaned
            if other.speaker != turn.speaker
        )
        overlapped = turn.seconds > 0 and (covered / turn.seconds) > max_overlap_ratio
        if overlapped:
            out.append(Candidate(turn, False, True, "overlapped_speech"))
        elif turn.seconds < MIN_IDENTIFY_SECONDS:
            out.append(Candidate(turn, False, False, "too_short_to_identify"))
        else:
            out.append(Candidate(turn, True, False, "clean"))
    return out


@dataclass
class Backoff:
    """Retry policy for the school server going away mid-lesson.

    A classroom PC that stops trying is a classroom with no KobeAI for the rest
    of the day, so it never gives up — it just stops hammering.
    """

    base: float = 1.0
    cap: float = 30.0
    attempt: int = 0

    def failure(self) -> float:
        self.attempt += 1
        return min(self.cap, self.base * (2 ** (self.attempt - 1)))

    def success(self) -> None:
        self.attempt = 0
