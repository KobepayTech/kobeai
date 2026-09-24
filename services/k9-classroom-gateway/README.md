# K9 classroom gateway

The loop that joins a room's microphone to the school.

```
mic array ─► VAD ─► diarize ─► transcribe ─► embed
                                    │           │
                                    │           └─► POST /v1/voice/identify
                                    │
                                    └─► POST /v1/classroom/utterance   (the queue)
                                        POST /v1/classroom/insights    (the record)
                                    ◄── GET  /v1/classroom/queue       (TV + speaker)
```

Two services, and the split is the point:

- **`services/k9-runtime/server.py`**, on this same PC, owns the models. It
  returns evidence — speech spans, turns, text, a vector — and never an
  identity.
- **The school server** owns the roster, the consent record and the audit
  trail, so it is the only thing that decides *who* spoke and whether that may
  be written down. See `docs/K9_ATTRIBUTION_GATES.md`.

## Audio never leaves this machine

Segments live in memory for as long as it takes to produce a transcript and a
vector, then they are dropped. What crosses the LAN is text and numbers. That
is the whole reason a school can say it does not keep recordings of its
children, and `test_gateway.py` asserts it rather than describing it: no bytes
appear in anything the gateway sends.

## What gets thrown away, and why

A classroom produces far more speech than it produces questions, so most of the
work is deciding what *not* to send on (`pipeline.py`):

| Rule | Why |
|---|---|
| Merge same-speaker turns < 0.7s apart | A diarizer splits one sentence wherever the speaker breathes; "why do we… move the 5 over there?" is one question |
| Never merge across another speaker | Joining would put someone else's words inside this speaker's audio |
| Clip turns to VAD speech | Diarization will happily label a fan hum |
| Turns > 25% overlapped: transcribe, never identify | The architecture's rule — ask for it to be repeated rather than attribute it to whoever the embedding happened to favour |
| Turns < 0.5s: transcribe, never identify | A half-second "ndiyo" matched against forty children is the classic false match |
| Turns > 30s: never identify | That is a teacher talking, not a question |

Nothing is silently dropped for being hard. An overlapped or unidentifiable
turn is still transcribed and still recorded, because a room that looks quieter
than it was is worse than one that says "we did not catch who said that".

## Microphone

A **USB microphone array** is strongly preferred over one ordinary microphone.
It separates speakers in different parts of the room far better, and its
direction of arrival is the independent second signal that turns `voice` into
`voice_corroborated` at the attribution gate — the difference between a match
K9 may write down and one it may only speak to.

## Running it

```sh
set K9_RUNTIME_URL=http://127.0.0.1:8766
set K9_RUNTIME_SECRET=<runtime secret>
set K9_SCHOOL_URL=https://school.example
set CLASSROOM_KIOSK_SECRET=<the api-server's kiosk secret>
set K9_CLASS_ID=12
py services\k9-classroom-gateway\gateway.py --device 1
```

`pip install sounddevice` for capture. Everything else is standard library, so
the rules in `pipeline.py` and the wiring in `handle_window` are testable with
no microphone, no models and no school server:

```sh
python3 -m unittest discover -s services/k9-classroom-gateway/tests
```

## Before a school runs this

`docs/K9_VOICE_IDENTITY.md` sets the order. Until `measure_speaker_id.py` has
been run on that school's own class, `VOICE_ATTRIBUTION_MEASURED` stays false
and voice identification personalises answers without writing to any child's
permanent profile. The gateway works exactly the same either way — that is
deliberate.
