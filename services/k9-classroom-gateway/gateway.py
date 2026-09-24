"""K9 classroom gateway — the loop that joins a room's microphone to the school.

    mic array ─► VAD ─► diarize ─► transcribe ─► embed
                                        │           │
                                        │           └─► POST /v1/voice/identify
                                        │
                                        └─► POST /v1/classroom/utterance   (queue)
                                            POST /v1/classroom/insights    (record)
                                        ◄── GET  /v1/classroom/queue       (TV + speaker)

Two services, and the split matters:

* **services/k9-runtime/server.py** on this same PC owns the models. It returns
  evidence — speech spans, turns, text, a vector — and never an identity.
* **The school server** owns the roster, the consent record and the audit
  trail, so it is the only thing that decides *who* spoke and whether that may
  be written down. See docs/K9_ATTRIBUTION_GATES.md.

**Audio never leaves this machine.** Segments are held in memory for as long as
it takes to turn them into a transcript and a vector, then dropped. What
crosses the LAN is text and numbers — which is the whole reason a school can
say it does not keep recordings of its children.

    set K9_RUNTIME_URL=http://127.0.0.1:8766
    set K9_RUNTIME_SECRET=<runtime secret>
    set K9_SCHOOL_URL=https://school.example
    set CLASSROOM_KIOSK_SECRET=<the api-server's kiosk secret>
    set K9_CLASS_ID=12
    py services\\k9-classroom-gateway\\gateway.py --device 1
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pipeline import Backoff, Turn, candidates  # noqa: E402

LOG = logging.getLogger("k9-classroom")

RUNTIME_URL = os.getenv("K9_RUNTIME_URL", "http://127.0.0.1:8766").rstrip("/")
RUNTIME_SECRET = os.getenv("K9_RUNTIME_SECRET", "")
SCHOOL_URL = os.getenv("K9_SCHOOL_URL", "").rstrip("/")
KIOSK_SECRET = os.getenv("CLASSROOM_KIOSK_SECRET", "")

#: How much room audio to consider at once. Long enough for the diarizer to
#: have something to separate, short enough that a child is not waiting fifteen
#: seconds to be heard.
WINDOW_SECONDS = float(os.getenv("K9_WINDOW_SECONDS", "8"))
SAMPLE_RATE = 16_000


def _post(url: str, headers: dict[str, str], body: dict[str, Any], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def _get(url: str, headers: dict[str, str], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


class Runtime:
    """The models on this PC. Returns evidence, never an identity."""

    def __init__(self, url: str = RUNTIME_URL, secret: str = RUNTIME_SECRET):
        self.url, self.headers = url, ({"x-k9-runtime-secret": secret} if secret else {})

    def _call(self, path: str, body: dict[str, Any], timeout: float = 90.0) -> dict[str, Any]:
        return _post(f"{self.url}{path}", self.headers, body, timeout)

    def speech(self, wav: bytes) -> list[tuple[float, float]]:
        out = self._call("/v1/vad", {"audio": base64.b64encode(wav).decode()})
        return [(float(s["start"]), float(s["end"])) for s in out.get("segments", [])]

    def turns(self, wav: bytes, max_speakers: int | None = None) -> list[Turn]:
        body: dict[str, Any] = {"audio": base64.b64encode(wav).decode()}
        if max_speakers:
            body["max_speakers"] = max_speakers
        out = self._call("/v1/diarize", body)
        return [Turn(float(t["start"]), float(t["end"]), str(t["speaker"])) for t in out.get("turns", [])]

    def transcribe(self, wav: bytes, language: str | None = None) -> str:
        body: dict[str, Any] = {"audio": base64.b64encode(wav).decode()}
        if language:
            body["language"] = language
        return str(self._call("/v1/transcribe", body).get("text", "")).strip()

    def embedding(self, wav: bytes) -> list[float]:
        out = self._call("/v1/speaker/embedding", {"audio": base64.b64encode(wav).decode()})
        return [float(x) for x in out.get("embedding", [])]


class School:
    """The roster, the record, and every decision about a child."""

    def __init__(self, url: str = SCHOOL_URL, secret: str = KIOSK_SECRET):
        self.url = url
        self.headers = {"x-classroom-kiosk-secret": secret} if secret else {}

    def identify(self, embedding: list[float], class_id: int, model: str) -> dict[str, Any]:
        return _post(
            f"{self.url}/api/v1/voice/identify",
            self.headers,
            {"embedding": embedding, "class_id": class_id, "model": model},
            timeout=20.0,
        )

    def utterance(self, body: dict[str, Any]) -> dict[str, Any]:
        return _post(f"{self.url}/api/v1/classroom/utterance", self.headers, body, timeout=20.0)

    def insights(self, body: dict[str, Any]) -> dict[str, Any]:
        return _post(f"{self.url}/api/v1/classroom/insights", self.headers, body, timeout=20.0)

    def queue(self, class_id: int) -> dict[str, Any]:
        return _get(
            f"{self.url}/api/v1/classroom/queue?class_id={class_id}", self.headers, timeout=15.0
        )

    def queue_status(self, item_id: int, status: str, answer: str | None = None) -> None:
        body: dict[str, Any] = {"status": status}
        if answer:
            body["answer"] = answer
        _post(f"{self.url}/api/v1/classroom/queue/{item_id}/status", self.headers, body, timeout=15.0)


def slice_wav(wav: bytes, start: float, end: float, rate: int = SAMPLE_RATE) -> bytes:
    """Cut one turn out of a window, as a fresh 16-bit mono WAV."""
    import io
    import wave

    with wave.open(io.BytesIO(wav)) as source:
        source.setpos(min(source.getnframes(), int(start * rate)))
        frames = source.readframes(max(0, int((end - start) * rate)))
        params = source.getparams()
    out = io.BytesIO()
    with wave.open(out, "wb") as sink:
        sink.setnchannels(params.nchannels)
        sink.setsampwidth(params.sampwidth)
        sink.setframerate(params.framerate)
        sink.writeframes(frames)
    return out.getvalue()


def handle_window(
    wav: bytes,
    runtime: Runtime,
    school: School,
    class_id: int,
    model: str = "titanet-large",
    language: str | None = None,
) -> list[dict[str, Any]]:
    """One window of room audio, end to end.

    Returns what was done with each turn, for the log and for tests. The audio
    is not returned and not kept.
    """
    speech = runtime.speech(wav)
    if not speech:
        return []
    results: list[dict[str, Any]] = []
    for candidate in candidates(runtime.turns(wav), speech):
        turn = candidate.turn
        clip = slice_wav(wav, turn.start, turn.end)
        # Stripped here rather than trusting the transport: a whitespace-only
        # transcript is what a cough or a chair scrape produces, and it would
        # otherwise become an empty card on the classroom TV.
        transcript = (runtime.transcribe(clip, language) or "").strip()
        if not transcript:
            continue

        student_code, confidence = None, None
        if candidate.identifiable:
            try:
                found = school.identify(runtime.embedding(clip), class_id, model)
                # `address_as` is the looser of the two gates and the right one
                # here: the queue only ever addresses a child. Whether this may
                # be written down is decided again, by the school, against the
                # attribution gate.
                student_code = (found.get("attribution") or {}).get("address_as")
                confidence = found.get("score")
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
                LOG.warning("identification unavailable, continuing anonymously: %s", exc)

        queued = school.utterance(
            {
                "class_id": class_id,
                "speaker": turn.speaker,
                "transcript": transcript,
                "student_code": student_code,
                "attribution_confidence": None if confidence is None else round(confidence * 100),
                "identity_source": "voice",
            }
        )

        # Every line goes to the record, invoked or not: a question nobody
        # addressed to KobeAI is still evidence of what the class is stuck on,
        # and it lands at class level when nobody was identified.
        school.insights(
            {
                "class_id": class_id,
                "insights": [
                    {
                        "insight_type": "question" if queued.get("invoked") else "theme",
                        "text": transcript,
                        "student_code": student_code,
                        "attribution_confidence": None
                        if confidence is None
                        else round(confidence * 100),
                    }
                ],
                "identity_source": "voice",
                "source_kiosk": os.getenv("K9_KIOSK_ID", "classroom-gateway"),
            }
        )
        results.append(
            {
                "speaker": turn.speaker,
                "seconds": round(turn.seconds, 2),
                "identified": student_code is not None,
                "overlapped": candidate.overlapped,
                "reason": candidate.reason,
                "invoked": bool(queued.get("invoked")),
                "queued": bool(queued.get("queued")),
            }
        )
    return results


def capture(device: int | None, seconds: float) -> bytes:
    """One window of microphone audio as a 16 kHz mono WAV.

    A USB microphone array is strongly preferred over one ordinary microphone:
    it separates speakers in different parts of the room far better, and its
    direction of arrival is the independent second signal that lets voice
    identification be corroborated rather than trusted alone.
    """
    import io
    import wave

    try:
        import sounddevice
    except ImportError as exc:  # pragma: no cover - depends on the school PC
        raise SystemExit(
            "The gateway needs `sounddevice` for microphone capture: pip install sounddevice"
        ) from exc

    frames = sounddevice.rec(
        int(seconds * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype="int16",
        **({"device": device} if device is not None else {}),
    )
    sounddevice.wait()
    out = io.BytesIO()
    with wave.open(out, "wb") as sink:
        sink.setnchannels(1)
        sink.setsampwidth(2)
        sink.setframerate(SAMPLE_RATE)
        sink.writeframes(frames.tobytes())
    return out.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--class-id", type=int, default=int(os.getenv("K9_CLASS_ID", "0")))
    parser.add_argument("--device", type=int, default=None, help="microphone index")
    parser.add_argument("--window", type=float, default=WINDOW_SECONDS)
    parser.add_argument("--language", default=os.getenv("K9_LANGUAGE") or None)
    parser.add_argument("--once", action="store_true", help="one window, then stop")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not args.class_id:
        parser.error("--class-id (or K9_CLASS_ID) is required")
    if not SCHOOL_URL:
        parser.error("K9_SCHOOL_URL is required")

    runtime, school, backoff = Runtime(), School(), Backoff()
    LOG.info("listening for class %s, %.0fs windows", args.class_id, args.window)
    while True:
        try:
            wav = capture(args.device, args.window)
            for result in handle_window(wav, runtime, school, args.class_id, language=args.language):
                LOG.info("%s", result)
            backoff.success()
        except KeyboardInterrupt:
            LOG.info("stopped")
            return 0
        except Exception as exc:  # the lesson continues whatever went wrong
            wait = backoff.failure()
            LOG.warning("window failed (%s); retrying in %.0fs", exc, wait)
            time.sleep(wait)
        if args.once:
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
