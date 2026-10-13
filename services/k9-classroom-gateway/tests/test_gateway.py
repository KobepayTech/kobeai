"""The gateway loop, end to end, against fakes.

No microphone, no models, no school server. What is being tested is the wiring:
which service is asked what, in which order, and — most importantly — what is
*not* sent.
"""

from __future__ import annotations

import io
import sys
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gateway import handle_window, slice_wav  # noqa: E402
from pipeline import Turn  # noqa: E402


def wav_of(seconds: float, rate: int = 16_000) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as sink:
        sink.setnchannels(1)
        sink.setsampwidth(2)
        sink.setframerate(rate)
        sink.writeframes(b"\x00\x01" * int(seconds * rate))
    return out.getvalue()


class FakeRuntime:
    def __init__(self, turns, speech=((0.0, 20.0),), text="Kobe, why is the sky blue?"):
        self._turns, self._speech, self._text = turns, list(speech), text
        self.embeddings_taken = 0
        self.transcribed = 0

    def speech(self, wav):
        return self._speech

    def turns(self, wav, max_speakers=None):
        return self._turns

    def transcribe(self, wav, language=None):
        self.transcribed += 1
        return self._text

    def embedding(self, wav):
        self.embeddings_taken += 1
        return [0.1] * 8


class FakeSchool:
    def __init__(self, address_as="K9-001", invoked=True):
        self._address_as, self._invoked = address_as, invoked
        self.identified = 0
        self.utterances: list[dict] = []
        self.recorded: list[dict] = []

    def identify(self, embedding, class_id, model):
        self.identified += 1
        return {"score": 0.91, "attribution": {"address_as": self._address_as, "attribute_to": None}}

    def utterance(self, body):
        self.utterances.append(body)
        return {"invoked": self._invoked, "queued": self._invoked, "id": 1}

    def insights(self, body):
        self.recorded.append(body)
        return {"inserted": [1]}


class TestSlicing(unittest.TestCase):
    def test_a_slice_is_a_valid_wav_of_the_right_length(self):
        clip = slice_wav(wav_of(10), 2.0, 4.0)
        with wave.open(io.BytesIO(clip)) as handle:
            self.assertEqual(handle.getnchannels(), 1)
            self.assertEqual(handle.getsampwidth(), 2)
            self.assertAlmostEqual(handle.getnframes() / handle.getframerate(), 2.0, places=2)

    def test_a_slice_past_the_end_does_not_explode(self):
        clip = slice_wav(wav_of(1), 5.0, 9.0)
        with wave.open(io.BytesIO(clip)) as handle:
            self.assertEqual(handle.getnframes(), 0)


class TestWindow(unittest.TestCase):

    def test_a_clean_turn_is_transcribed_identified_and_queued(self):
        runtime = FakeRuntime([Turn(0.0, 3.0, "SPEAKER_00")])
        school = FakeSchool()
        [result] = handle_window(wav_of(10), runtime, school, class_id=7)
        self.assertTrue(result["identified"])
        self.assertTrue(result["queued"])
        self.assertEqual(school.utterances[0]["class_id"], 7)
        self.assertEqual(school.utterances[0]["speaker"], "SPEAKER_00")
        self.assertEqual(school.utterances[0]["identity_source"], "voice")

    def test_overlapping_speech_is_never_sent_for_identification(self):
        # The rule from the architecture: repeat it rather than attribute it to
        # whoever the embedding happened to favour.
        runtime = FakeRuntime([Turn(0.0, 3.0, "A"), Turn(0.4, 3.0, "B")])
        school = FakeSchool()
        results = handle_window(wav_of(10), runtime, school, class_id=7)
        self.assertEqual(len(results), 2)
        self.assertEqual(runtime.embeddings_taken, 0, "no embedding is taken from overlapped audio")
        self.assertEqual(school.identified, 0)
        for result in results:
            self.assertTrue(result["overlapped"])
            self.assertFalse(result["identified"])

    def test_a_short_turn_is_transcribed_but_not_identified(self):
        runtime = FakeRuntime([Turn(0.0, 0.4, "A")])
        school = FakeSchool()
        [result] = handle_window(wav_of(10), runtime, school, class_id=7)
        self.assertEqual(runtime.transcribed, 1)
        self.assertEqual(school.identified, 0)
        self.assertFalse(result["identified"])

    def test_silence_costs_nothing_downstream(self):
        runtime = FakeRuntime([Turn(0.0, 3.0, "A")], speech=[])
        school = FakeSchool()
        self.assertEqual(handle_window(wav_of(10), runtime, school, class_id=7), [])
        self.assertEqual(runtime.transcribed, 0)
        self.assertEqual(school.utterances, [])

    def test_an_empty_transcript_is_not_sent_anywhere(self):
        runtime = FakeRuntime([Turn(0.0, 3.0, "A")], text="   ")
        school = FakeSchool()
        self.assertEqual(handle_window(wav_of(10), runtime, school, class_id=7), [])
        self.assertEqual(school.utterances, [])

    def test_a_line_nobody_addressed_to_kobe_is_still_recorded(self):
        # It is evidence of what the class is stuck on even when it was not a
        # question for K9.
        runtime = FakeRuntime([Turn(0.0, 3.0, "A")], text="did you finish number four")
        school = FakeSchool(invoked=False)
        [result] = handle_window(wav_of(10), runtime, school, class_id=7)
        self.assertFalse(result["queued"])
        self.assertEqual(len(school.recorded), 1)
        self.assertEqual(school.recorded[0]["insights"][0]["insight_type"], "theme")

    def test_a_refused_identification_continues_anonymously(self):
        runtime = FakeRuntime([Turn(0.0, 3.0, "A")])
        school = FakeSchool(address_as=None)
        [result] = handle_window(wav_of(10), runtime, school, class_id=7)
        self.assertFalse(result["identified"])
        self.assertIsNone(school.utterances[0]["student_code"])
        self.assertTrue(result["queued"], "an unidentified child still gets an answer")

    def test_the_school_server_going_away_does_not_stop_the_lesson(self):
        import urllib.error

        class Broken(FakeSchool):
            def identify(self, embedding, class_id, model):
                raise urllib.error.URLError("no route to host")

        runtime = FakeRuntime([Turn(0.0, 3.0, "A")])
        school = Broken()
        [result] = handle_window(wav_of(10), runtime, school, class_id=7)
        self.assertFalse(result["identified"])
        self.assertTrue(result["queued"], "the question is still asked")

    def test_no_audio_is_ever_returned_or_forwarded(self):
        # The privacy claim, asserted rather than described: what leaves this
        # machine is text and numbers.
        runtime = FakeRuntime([Turn(0.0, 3.0, "A")])
        school = FakeSchool()
        results = handle_window(wav_of(10), runtime, school, class_id=7)
        for payload in [*results, *school.utterances, *school.recorded]:
            for value in payload.values():
                self.assertNotIsInstance(value, (bytes, bytearray))
        self.assertNotIn("audio", school.utterances[0])


if __name__ == "__main__":
    unittest.main()
