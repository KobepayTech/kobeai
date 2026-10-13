# Two gates: identity, then attribution

Status: adopted • Owner: KobeAI school-server team • Last updated: 2026-09-24

K9 makes two separate decisions about a speaking child, and they are not the
same decision at different confidence levels.

```
        speaker embedding
                │
    GATE 1 · IDENTITY        who is probably speaking?
                │            → 91% · Amani
                │
    GATE 2 · ATTRIBUTION     is this good enough to write to
                │            Amani's permanent learning profile?
                │
     attributable   personalised   anonymous
```

## Why two

The costs of being wrong are not comparable.

Calling Amani by the wrong name for one turn is embarrassing and
self-correcting — she says so, or the moment passes. Writing a misconception
onto the wrong child's permanent record is **silent**, compounds over a term,
and surfaces months later as a teacher planning a lesson around a weakness that
child never had. Nobody ever finds out it was wrong.

So the attribution gate is strictly harder to pass, and failing it is the normal
case rather than an error. `attribution.test.ts` fails the build if the two
thresholds ever converge, because at that point the two-gate design has quietly
become one gate.

## The three outcomes

| Outcome | K9 answers | K9 records |
|---|---|---|
| `attributable` | as Amani | to Amani's profile |
| `personalised` | as Amani | anonymously, at class level |
| `anonymous` | as a guest | anonymously |

`personalised` is the interesting one and the one the design exists for: K9 can
be confident enough to continue a conversation as Amani while refusing to
attach that interaction to her academic record.

## Sources, in descending authority

| Source | Authoritative | Note |
|---|---|---|
| `tablet_session` | yes | She signed in. The session *is* the identity |
| `teacher_confirmed` | yes | A teacher named her |
| `device_session` | yes | Selected on a shared device |
| `face` | no | Needs a confidence figure |
| `voice_corroborated` | no | Voice plus an independent second signal |
| `voice` | no | Shared classroom microphone |
| `none` | — | Open-set: "none of these" is a valid answer |

**A tablet session is not a guess.** Running voice recognition over an
authenticated session would replace a certainty with an inference — strictly
worse, and it puts a child's biometrics in the loop for no gain. K9 should not
run voice recognition merely because it can.

## The rule that does not bend

**Voice alone cannot write to a permanent profile until the school has measured
its own classrooms.** `VOICE_ATTRIBUTION_MEASURED` defaults to false, and while
it is false even a 99% match is answered personally and recorded anonymously.

This is not a UI setting or an admin convenience. Classroom diarization on
spontaneous, overlapping, noisy speech is genuinely hard, and open-set speaker
identification has to be able to reject a speaker as unknown rather than force
them onto the nearest enrolled child. A school that has not run
`measure_speaker_id.py` (see `K9_VOICE_IDENTITY.md`) on its own rooms has no
basis for letting a microphone write to a child's record.

Threshold choice trades false acceptance against false rejection. Here the two
are not symmetric, so the harness optimises for **false attribution**, not
overall accuracy — a false rejection costs one anonymous event, a false
acceptance costs a corrupted profile that nothing will correct.

## Evidence, and what may move mastery

The gates decide *whose* record. `lib/evidence.ts` decides *whether this is a
measurement at all*.

The distinction is **independence**, not source:

| Moves mastery | Never moves mastery |
|---|---|
| Teacher-marked work | A question asked |
| Unaided diagnostic | An explanation requested |
| Quiz, exam | A hint accepted |
| Independent attempt | Any attempt made after a hint |
| | "I understand ✓" |

A child who gets it wrong, takes a hint, and then gets it right has shown that
**the hint worked**. That is worth recording and worth nothing as a measure of
what they can do alone. Counting it would mean the more help K9 gives, the
cleverer every child appears — the precise failure that makes an AI tutor's
numbers worthless.

`assessSession()` applies this across a whole interaction, because a sequence
ending in a correct answer after a hint *feels* like learning happened. It did.
It is still not evidence of what the child can now do unaided, and the right
response is to offer a short diagnostic later, which is what
`suggest_assessment` is for.

## What this buys

Every strong signal reduces the need for a weak one:

```
authenticated tablet + timetable + lesson + interaction
  + assessment results + teacher evidence
  + voice/face where it actually helps
              ↓
     student learning profile
```

The tablet is authoritative for tablet activity. Voice matters for the shared
room and ambient interaction — which is exactly where the attribution gate
earns its place.
