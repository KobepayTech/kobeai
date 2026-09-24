# Voice identity: measure it before you build on it

Status: proposed • Owner: KobeAI school-server team • Last updated: 2026-09-24

The classroom-intelligence design makes voice the primary way K9 knows who
spoke. Every other part of that design — diarization, the invocation detector,
the question queue, the subject router, the per-subject voices, the five modes —
is ordinary engineering that will work. This one part might not, and nothing
downstream is worth building until we know.

`docs/K9_ARCHITECTURE.md` already says why:

> TitaNet-Large is primarily English-trained. Tanzanian classrooms mix
> English + Kiswahili; fine-tune the speaker component on school-approved
> enrollment recordings before relying on it for attribution.

It is harder than that implies. TitaNet is trained overwhelmingly on adult
speech, and a Form 2 class is forty same-age children whose voices sit closer
together in embedding space than adults' do — higher pitch, narrower formant
spread, far less vocal-tract variation across the cohort. Add a reverberant
room, forty other people talking, and code-switching inside single sentences.

So this ships a measurement before it ships a feature.

## The number that matters is not accuracy

Accuracy over accepted utterances can be made to look excellent by accepting
almost nothing. The question a school is actually buying an answer to is:

> **How much of the class can we attribute, while misattributing under 1%?**

Misattribution is the expensive error. Writing Amina's question onto Joseph's
learning profile corrupts the evidence the skill engine reasons from, it
compounds over a term, and nobody ever finds out. Refusing to attribute is
cheap: the insight still lands at class level, which `POST /v1/classroom/insights`
has done since it was written — it demotes an uncertain attribution rather than
guessing.

`speaker_harness.py` therefore reports **coverage against misattribution**, and
`choose_thresholds` returns the most permissive setting inside a stated budget,
or `None`. `None` is a real answer: it means voice cannot be the primary
identity mechanism for this cohort on this model.

## Two gates, because they catch different failures

| Gate         | Catches                                                                               | What happens without it                                                             |
| ------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `min_score`  | A speaker who is not in the room — a visitor, a teacher, a child who missed enrolment | Their nearest match still beats every rival, so a margin test alone names them      |
| `min_margin` | Two children who genuinely sound alike                                                | Both score highly, the winner is near a coin toss, and it gets written to a profile |

Shipped defaults are `min_score 0.62`, `min_margin 0.12`. **These are starting
points, not findings.** The real numbers come from running the harness on the
school's own enrolled class.

## Running it

```sh
python3 services/k9-runtime/measure_speaker_id.py recordings/form-2a.json
```

The manifest names WAV files, not embeddings, so the measurement covers the
whole chain a classroom actually runs: the microphone, the codec, the room, and
TitaNet. Collect trials the school will really produce — mid-lesson, from the
back, in both languages, on the real hardware. Quiet-room English read from a
card measures a product nobody is buying, which is why the report slices by
`condition` and `language` and flags a slice that collapses rather than letting
a headline average hide it.

**Include utterances from people who are not enrolled.** Nothing else in the
report reveals whether the system maps every stranger onto the nearest child.

## What the answer means

- **Coverage above ~80% inside budget** — build the design as written.
- **Coverage around 50%** — voice can confirm, not decide. Lead with a raised
  hand and the camera, or push-to-talk on the teacher's device, and use voice
  as a second signal. The mic array's direction-of-arrival plus a seating chart
  is a genuinely independent signal worth fusing here.
- **`None`** — attribute at class level only. The teacher-intelligence half of
  the design (misconceptions, what to reteach) still works without naming
  anyone, and it was always the stronger half.

Find this out in a fortnight, not after the agents, the router and the TV are
built on top of it.

## Enrolment

`POST /v1/voice/enroll`, staff only, three to twelve samples. Several, because
a child's voice moves with distance, illness, emotion and microphone position,
and a centroid built from one close-mic sentence matches nothing said from the
back row. Samples are unit-normalised before averaging, so one loud recording
cannot outweigh three quiet ones.

The response returns `weakest_sample_agreement` — the sample least like the
others, which usually means a prompt was misread, cut short, or recorded while
someone else was talking. Re-enrol rather than keep it.

`model` and `model_revision` are part of a profile's identity. Embeddings from
different models are not comparable, so a model upgrade invalidates every
profile rather than silently comparing across spaces.

## Children's biometrics

Voice embeddings of minors are biometric data, and the controls are structural
rather than documented:

- **Consent cannot be skipped.** `consent_reference`, `consent_by` and
  `consent_recorded_at` are `NOT NULL` on `voice_profiles`. There is no code
  path that writes a profile without recording who authorised it. A comment
  saying "get consent first" is not a control; a `NOT NULL` column is.
- **No recordings are kept.** The gateway embeds and discards in the same
  request. `voice_enrollment_samples` holds vectors so a profile can be rebuilt
  or an outlier dropped without asking a child to record again — and so no
  audio has to be retained to make that possible.
- **Retention is set at enrolment**, not remembered later. `expires_at` is
  `NOT NULL`, `rosterFor()` excludes expired rows in the query rather than
  filtering afterwards, and `POST /v1/voice/retention/sweep` deletes them.
- **Deletion is real.** `DELETE /v1/voice/profiles/:student_code` removes the
  centroid and every sample. The audit row is written first and outlives them,
  because "we deleted it" is the entry a parent is most entitled to see.
- **Recognition can be switched off for one child** without destroying their
  enrolment: `POST /v1/voice/profiles/:student_code/active`.

The legal position under Tanzania's data-protection regime needs a proper read
by someone qualified — that is not a judgement this document can make. What it
can do is make the controls cheap to comply with, which is why they are in the
schema rather than in a policy.

## One rule, two languages

The thresholds a school ships are chosen by the Python harness and applied by
the TypeScript API. Two implementations of one rule is a divergence risk, so
`voice-identity.test.ts` runs both over identical fixtures and fails the build
if they disagree. If the live gate ever stopped matching the measured gate, the
number the school was given would stop describing what its classroom does.

## Roster scope

Identification compares against **the class in the room**, never the whole
school. Every extra enrolled voice is another chance at a closer false match,
and the timetable already says who is meant to be there. Forty-two comparisons,
not five thousand.
