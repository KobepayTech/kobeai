"""Subject agents: the per-subject voice and teaching style.

This file used to also hold `ClassroomVoiceRegistry`, an in-memory speaker
store. It was removed in favour of the persisted path in the school server
(`voice_profiles`, `artifacts/api-server/src/lib/voice-identity.ts`), for three
reasons worth writing down so it is not reinvented:

1. **It scored max-over-samples, not against a centroid.** Taking the best
   cosine across a student's enrolment samples biases towards whichever sample
   happened to be recorded in conditions like the query, and it rewards having
   more samples: a child enrolled with eight utterances outscores one enrolled
   with three on sample count alone. A unit-normalised centroid is comparable
   across students no matter how many samples each gave.

2. **It had one threshold and no margin test.** A single cutoff cannot tell
   "this is clearly Amina" from "this is Amina or Joseph, both at 0.74". In a
   class of forty same-age children the second case is the common one, and it
   is exactly the case that must not be written to a profile. See
   `docs/K9_VOICE_IDENTITY.md`.

3. **It lost everything on restart, and had no consent record, retention or
   audit.** `consent: bool` says a box was ticked; it does not say who
   authorised a child's biometrics, when, or for how long.

Identity therefore lives where the roster, the consent record and the audit
trail are. The runtime turns audio into vectors and stays stateless.
"""

from __future__ import annotations

#: Students come to associate a voice with a subject, which is worth more than
#: it sounds: it tells a class whose question is being answered before a word of
#: the answer arrives. One TTS engine, several voice profiles — not one model
#: per subject.
SUBJECT_AGENTS: dict[str, dict[str, str]] = {
    "mathematics": {"voice": "teacher-a", "style": "step_by_step"},
    "physics": {"voice": "teacher-b", "style": "concept_then_example"},
    "chemistry": {"voice": "teacher-c", "style": "safety_first_experimental"},
    "biology": {"voice": "teacher-d", "style": "visual_explanatory"},
    "english": {"voice": "teacher-e", "style": "language_coach"},
    "kiswahili": {"voice": "teacher-f", "style": "kiswahili_teacher"},
    "history": {"voice": "teacher-g", "style": "story_evidence"},
    "geography": {"voice": "teacher-h", "style": "maps_systems"},
    "civics": {"voice": "teacher-i", "style": "neutral_civic_education"},
    "computer_science": {"voice": "teacher-j", "style": "code_and_concepts"},
}

DEFAULT_AGENT = {"voice": "teacher-a", "style": "general_teacher"}


def agent_for(subject: str | None) -> dict[str, str]:
    """The voice and style for a subject, falling back to the general one.

    Unknown subjects fall back rather than raising: a timetable entry spelled
    "Basic Mathematics" should still get a teacher, and silence in a classroom
    is a worse failure than a slightly generic voice.
    """
    if not subject:
        return dict(DEFAULT_AGENT)
    return dict(SUBJECT_AGENTS.get(subject.strip().lower().replace(" ", "_"), DEFAULT_AGENT))
