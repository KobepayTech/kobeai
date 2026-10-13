"""Tests for the classroom gateway's turn pipeline."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline import (  # noqa: E402
    MAX_TURN_SECONDS,
    MIN_IDENTIFY_SECONDS,
    Backoff,
    Turn,
    candidates,
    clip_to_speech,
    merge_adjacent,
    overlap_seconds,
)

ALL_SPEECH = [(0.0, 120.0)]


class TestMerging(unittest.TestCase):
    def test_a_breath_does_not_split_one_question_into_two(self):
        turns = [Turn(0.0, 1.5, "A"), Turn(1.9, 3.4, "A")]
        merged = merge_adjacent(turns)
        self.assertEqual(len(merged), 1)
        self.assertEqual((merged[0].start, merged[0].end), (0.0, 3.4))

    def test_a_real_pause_stays_two_turns(self):
        merged = merge_adjacent([Turn(0.0, 1.5, "A"), Turn(5.0, 6.0, "A")])
        self.assertEqual(len(merged), 2)

    def test_an_exchange_is_never_merged_across_the_other_speaker(self):
        # Joining A's two turns would swallow B's words into A's audio.
        turns = [Turn(0.0, 1.0, "A"), Turn(1.1, 2.0, "B"), Turn(2.1, 3.0, "A")]
        merged = merge_adjacent(turns)
        self.assertEqual([t.speaker for t in merged], ["A", "B", "A"])

    def test_merging_is_order_independent(self):
        forward = [Turn(0.0, 1.0, "A"), Turn(1.2, 2.0, "A")]
        self.assertEqual(merge_adjacent(forward), merge_adjacent(list(reversed(forward))))


class TestClipping(unittest.TestCase):
    def test_a_turn_over_silence_is_dropped(self):
        # Diarization will label a fan hum; the VAD is the ground truth for
        # whether anyone was talking at all.
        self.assertEqual(clip_to_speech([Turn(10.0, 12.0, "A")], [(0.0, 5.0)]), [])

    def test_a_turn_is_trimmed_to_the_speech_inside_it(self):
        clipped = clip_to_speech([Turn(0.0, 10.0, "A")], [(2.0, 4.0)])
        self.assertEqual((clipped[0].start, clipped[0].end), (2.0, 4.0))

    def test_a_sliver_of_overlap_is_not_a_turn(self):
        self.assertEqual(clip_to_speech([Turn(0.0, 5.0, "A")], [(4.9, 5.2)]), [])


class TestCandidates(unittest.TestCase):
    def test_a_clean_turn_may_be_identified(self):
        [candidate] = candidates([Turn(0.0, 3.0, "A")], ALL_SPEECH)
        self.assertTrue(candidate.identifiable)
        self.assertEqual(candidate.reason, "clean")

    def test_overlapping_speech_is_kept_but_never_attributed(self):
        # The architecture's rule: ask for it to be repeated rather than assign
        # it to whoever the embedding happened to favour.
        turns = [Turn(0.0, 3.0, "A"), Turn(0.5, 3.0, "B")]
        results = candidates(turns, ALL_SPEECH)
        self.assertEqual(len(results), 2, "neither speaker is discarded")
        for candidate in results:
            self.assertTrue(candidate.overlapped)
            self.assertFalse(candidate.identifiable)
            self.assertEqual(candidate.reason, "overlapped_speech")

    def test_a_brief_interjection_over_a_long_turn_does_not_spoil_it(self):
        # "mm" from the next desk must not cost a whole question its identity.
        turns = [Turn(0.0, 8.0, "A"), Turn(3.0, 3.4, "B")]
        by_speaker = {c.turn.speaker: c for c in candidates(turns, ALL_SPEECH)}
        self.assertTrue(by_speaker["A"].identifiable)

    def test_a_short_turn_is_transcribed_but_not_identified(self):
        # A half-second "ndiyo" matched against forty children is the classic
        # false match.
        [candidate] = candidates([Turn(0.0, MIN_IDENTIFY_SECONDS - 0.05, "A")], ALL_SPEECH)
        self.assertFalse(candidate.identifiable)
        self.assertEqual(candidate.reason, "too_short_to_identify")

    def test_a_long_stretch_of_teaching_is_not_a_question(self):
        [candidate] = candidates([Turn(0.0, MAX_TURN_SECONDS + 5, "A")], [(0.0, 200.0)])
        self.assertFalse(candidate.identifiable)
        self.assertEqual(candidate.reason, "too_long_to_be_a_question")

    def test_nothing_is_silently_dropped_for_being_hard(self):
        # A room that looks quieter than it was is worse than one that says
        # "we did not catch who said that".
        turns = [Turn(0.0, 3.0, "A"), Turn(0.2, 3.0, "B"), Turn(6.0, 9.0, "C")]
        self.assertEqual(len(candidates(turns, ALL_SPEECH)), 3)

    def test_silence_produces_nothing(self):
        self.assertEqual(candidates([], []), [])
        self.assertEqual(candidates([Turn(0.0, 3.0, "A")], []), [])


class TestOverlapMath(unittest.TestCase):
    def test_disjoint_turns_do_not_overlap(self):
        self.assertEqual(overlap_seconds(Turn(0, 1, "A"), Turn(2, 3, "B")), 0.0)

    def test_touching_turns_do_not_overlap(self):
        self.assertEqual(overlap_seconds(Turn(0, 1, "A"), Turn(1, 2, "B")), 0.0)

    def test_containment_overlaps_by_the_inner_turn(self):
        self.assertEqual(overlap_seconds(Turn(0, 10, "A"), Turn(3, 5, "B")), 2.0)


class TestBackoff(unittest.TestCase):
    def test_it_slows_down_but_never_gives_up(self):
        # A classroom PC that stops trying is a classroom with no KobeAI for
        # the rest of the day.
        backoff = Backoff()
        waits = [backoff.failure() for _ in range(10)]
        self.assertEqual(waits[:4], [1.0, 2.0, 4.0, 8.0])
        self.assertTrue(all(w <= backoff.cap for w in waits))
        self.assertGreater(waits[-1], 0)

    def test_one_success_clears_the_penalty(self):
        backoff = Backoff()
        backoff.failure()
        backoff.failure()
        backoff.success()
        self.assertEqual(backoff.failure(), 1.0)


if __name__ == "__main__":
    unittest.main()
