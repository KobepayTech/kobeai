"""Tests for the speaker-identification harness.

Standard library only, so the arithmetic that decides whether voice can be the
classroom's identity mechanism is checkable in CI without weights or a GPU.
"""

from __future__ import annotations

import math
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from speaker_harness import (  # noqa: E402
    Trial,
    centroid,
    choose_thresholds,
    cosine,
    evaluate,
    identify,
    normalise,
    rank,
    report,
    sweep,
)


def voice(seed: int, width: int = 16, jitter: float = 0.0) -> list[float]:
    """A deterministic pseudo-embedding, optionally perturbed.

    `jitter` stands in for the same child on a different day: same underlying
    voice, moved by distance, illness and mic position.
    """
    rng = random.Random(seed)
    base = [rng.gauss(0, 1) for _ in range(width)]
    if jitter:
        noise = random.Random(seed * 7919 + 13)
        base = [value + noise.gauss(0, jitter) for value in base]
    return normalise(base)


class TestVectorMath(unittest.TestCase):
    def test_cosine_is_bounded_and_symmetric(self):
        a, b = voice(1), voice(2)
        self.assertAlmostEqual(cosine(a, a), 1.0, places=9)
        self.assertAlmostEqual(cosine(a, b), cosine(b, a), places=12)
        self.assertLessEqual(cosine(a, b), 1.0)
        self.assertGreaterEqual(cosine(a, b), -1.0)

    def test_opposed_vectors_score_minus_one(self):
        a = voice(3)
        self.assertAlmostEqual(cosine(a, [-value for value in a]), -1.0, places=9)

    def test_zero_vector_scores_zero_rather_than_dividing_by_zero(self):
        self.assertEqual(cosine(voice(4), [0.0] * 16), 0.0)
        self.assertEqual(normalise([0.0, 0.0]), [0.0, 0.0])

    def test_length_mismatch_is_refused(self):
        with self.assertRaises(ValueError):
            cosine([1.0, 0.0], [1.0, 0.0, 0.0])

    def test_centroid_is_unit_length_and_near_its_samples(self):
        samples = [voice(10, jitter=0.25) for _ in range(5)]
        profile = centroid(samples)
        self.assertAlmostEqual(math.sqrt(sum(v * v for v in profile)), 1.0, places=9)
        for sample in samples:
            self.assertGreater(cosine(profile, sample), 0.5)

    def test_centroid_refuses_zero_samples_and_ragged_samples(self):
        with self.assertRaises(ValueError):
            centroid([])
        with self.assertRaises(ValueError):
            centroid([[1.0, 0.0], [1.0, 0.0, 0.0]])

    def test_loud_sample_cannot_outweigh_the_others(self):
        # Averaging AFTER normalising is the whole point: a close-mic sample
        # arrives with a larger magnitude, and must not drag the profile to it.
        quiet = [voice(20), voice(20, jitter=0.1), voice(20, jitter=0.1)]
        loud = [value * 50 for value in voice(21)]
        self.assertGreater(cosine(centroid(quiet + [loud]), quiet[0]), 0.5)


class TestRanking(unittest.TestCase):
    def test_ranks_best_first_and_breaks_ties_deterministically(self):
        shared = voice(30)
        roster = {"STU-B": shared, "STU-A": shared, "STU-C": voice(31)}
        ranked = rank(shared, roster)
        # Equal scores must not depend on dict insertion order.
        self.assertEqual([c.student_code for c in ranked[:2]], ["STU-A", "STU-B"])
        self.assertGreaterEqual(ranked[0].score, ranked[-1].score)

    def test_margin_on_a_roster_of_one_is_the_score_itself(self):
        profile = voice(40)
        decision = identify(profile, {"STU-1": profile}, min_score=0.5, min_margin=0.1)
        self.assertIsNone(decision.runner_up)
        self.assertAlmostEqual(decision.margin, decision.top.score, places=9)
        self.assertTrue(decision.accepted)

    def test_empty_roster_declines(self):
        decision = identify(voice(41), {}, min_score=0.0, min_margin=0.0)
        self.assertFalse(decision.accepted)
        self.assertIsNone(decision.student_code)


class TestGates(unittest.TestCase):
    """The two gates catch different failures and both are needed."""

    def test_margin_gate_refuses_two_children_who_sound_alike(self):
        # Both score highly; the winner is close to a coin toss.
        twin = voice(50)
        roster = {"STU-1": twin, "STU-2": [v + 0.02 for v in twin]}
        decision = identify(twin, roster, min_score=0.5, min_margin=0.15)
        self.assertGreater(decision.top.score, 0.9, "both should match strongly")
        self.assertFalse(decision.accepted, "a near-tie must not be written to a profile")

    def test_score_gate_refuses_a_speaker_who_is_not_in_the_room(self):
        # A stranger's best match can still beat every rival, so the margin
        # test alone would accept them. Only the score gate catches this.
        roster = {"STU-1": voice(60), "STU-2": voice(61)}
        stranger = voice(999)
        by_margin_only = identify(stranger, roster, min_score=0.0, min_margin=0.05)
        by_both = identify(stranger, roster, min_score=0.75, min_margin=0.05)
        self.assertTrue(by_margin_only.accepted, "margin alone lets the stranger through")
        self.assertFalse(by_both.accepted, "the score gate is what stops them")


class TestOutcome(unittest.TestCase):
    def setUp(self):
        self.roster = {f"STU-{i}": voice(100 + i) for i in range(4)}

    def test_counts_every_trial_exactly_once(self):
        trials = [
            Trial("STU-0", voice(100, jitter=0.1)),
            Trial("STU-1", voice(101, jitter=0.1)),
            Trial(None, voice(900)),
        ]
        outcome = evaluate(trials, self.roster, min_score=0.5, min_margin=0.1)
        self.assertEqual(outcome.total, len(trials))

    def test_misattribution_rate_is_over_all_trials_not_accepted_ones(self):
        # A system that accepts almost nothing must not be able to report a
        # flattering rate. One wrong attribution out of ten utterances is 10%,
        # even if only that one utterance was accepted.
        roster = {"STU-1": voice(200), "STU-2": voice(201)}
        # Nine utterances nothing will accept, one that lands on the wrong child.
        trials = [Trial("STU-1", [0.0] * 16) for _ in range(9)]
        trials.append(Trial("STU-1", voice(201)))
        outcome = evaluate(trials, roster, min_score=0.9, min_margin=0.1)
        self.assertEqual(outcome.accepted, 1)
        self.assertEqual(outcome.misattributed, 1)
        self.assertAlmostEqual(outcome.precision, 0.0)
        self.assertAlmostEqual(outcome.misattribution_rate, 0.1)

    def test_unenrolled_speaker_accepted_counts_as_false_accept(self):
        trials = [Trial(None, voice(100))]  # exactly STU-0's profile, but unenrolled truth
        outcome = evaluate(trials, self.roster, min_score=0.5, min_margin=0.05)
        self.assertEqual(outcome.false_accept, 1)
        self.assertEqual(outcome.misattributed, 0)
        self.assertEqual(outcome.wrong, 1)

    def test_declining_an_enrolled_child_is_separate_from_declining_a_stranger(self):
        trials = [Trial("STU-0", [0.0] * 16), Trial(None, [0.0] * 16)]
        outcome = evaluate(trials, self.roster, min_score=0.9, min_margin=0.5)
        self.assertEqual(outcome.declined, 1)
        self.assertEqual(outcome.correctly_unknown, 1)
        self.assertEqual(outcome.wrong, 0)

    def test_empty_trial_set_reports_zeroes_rather_than_dividing_by_zero(self):
        outcome = evaluate([], self.roster, min_score=0.5, min_margin=0.1)
        self.assertEqual(outcome.total, 0)
        self.assertEqual(outcome.coverage, 0.0)
        self.assertEqual(outcome.precision, 0.0)
        self.assertEqual(outcome.misattribution_rate, 0.0)


class TestThresholdChoice(unittest.TestCase):
    def setUp(self):
        self.roster = {f"STU-{i}": voice(300 + i) for i in range(6)}
        self.trials = [
            Trial(f"STU-{i}", voice(300 + i, jitter=0.35), condition="lesson", language="sw")
            for i in range(6)
        ] + [
            Trial(f"STU-{i}", voice(300 + i, jitter=0.05), condition="quiet", language="en")
            for i in range(6)
        ] + [Trial(None, voice(4000 + i), condition="lesson", language="sw") for i in range(3)]

    def test_chooses_the_highest_coverage_setting_inside_the_budget(self):
        outcomes = sweep(self.trials, self.roster, [0.3, 0.5, 0.7, 0.9], [0.0, 0.1, 0.2])
        chosen = choose_thresholds(outcomes, misattribution_budget=0.10)
        self.assertIsNotNone(chosen)
        self.assertLessEqual(chosen.misattribution_rate, 0.10)
        best_safe = max(
            o.coverage for o in outcomes if o.misattribution_rate <= 0.10
        )
        self.assertAlmostEqual(chosen.coverage, best_safe)

    def test_an_impossible_budget_returns_none_rather_than_a_bad_setting(self):
        # Refusing to answer is the answer: voice cannot carry identity here.
        outcomes = sweep(self.trials, self.roster, [0.0], [0.0])
        self.assertIsNone(choose_thresholds(outcomes, misattribution_budget=0.0))

    def test_ties_on_coverage_break_towards_the_stricter_setting(self):
        outcomes = sweep(self.trials, self.roster, [0.0, 0.1], [0.0])
        tied = [o for o in outcomes if o.coverage == outcomes[0].coverage]
        if len(tied) > 1:
            chosen = choose_thresholds(tied, misattribution_budget=1.0)
            self.assertEqual(chosen.min_score, max(o.min_score for o in tied))

    def test_report_measures_slices_at_the_chosen_thresholds(self):
        result = report(self.trials, self.roster, [0.3, 0.5, 0.7], [0.0, 0.1], 0.10)
        self.assertIsNotNone(result.overall)
        self.assertIn("condition", result.slices)
        self.assertIn("language", result.slices)
        for group in result.slices.values():
            for outcome in group.values():
                self.assertEqual(outcome.min_score, result.overall.min_score)
                self.assertEqual(outcome.min_margin, result.overall.min_margin)

    def test_report_flags_a_collapsing_slice_rather_than_hiding_it(self):
        # Quiet English is easy, mid-lesson Kiswahili is not. A headline number
        # that averages them is the failure this exists to prevent.
        result = report(self.trials, self.roster, [0.3, 0.5, 0.7], [0.0, 0.1], 0.10)
        coverages = [o.coverage for o in result.slices["condition"].values()]
        if min(coverages) < result.overall.coverage / 2:
            self.assertIn("collapses", result.verdict())

    def test_verdict_is_explicit_when_nothing_is_safe_enough(self):
        result = report(self.trials, self.roster, [0.0], [0.0], misattribution_budget=0.0)
        self.assertIsNone(result.overall)
        self.assertIn("cannot be the primary identity mechanism", result.verdict())
        self.assertIsNone(result.as_dict()["recommended"])


if __name__ == "__main__":
    unittest.main()
