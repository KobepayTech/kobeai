# Skill profiles from teacher marking

Status: adopted • Owner: KobeAI school-server team • Last updated: 2026-09-12

**K9 does not mark papers. Teachers do, exactly as they always have, and K9
reads the marking they already did.**

That is the whole design, and it is deliberate. An AI that independently marks
every exam has to be right about every answer before anyone can trust any of
it, and it puts a machine between a teacher and their own judgement. An AI
that *observes* marking inherits the teacher's authority for free, is useful
from the first paper, and fails safely: the worst case is a question mapped to
the wrong skill, which a teacher can see and correct — not a wrong mark on a
child's report.

## Why skills and not subjects

"62% in Chemistry" is a number. It is not something a teacher can act on.

Two students can both sit on 62% and need completely opposite interventions:
one has the concepts and keeps dropping arithmetic, the other has never
understood balancing equations and is carried by everything else. A subject
average hides exactly the thing a teacher needs.

So K9 models **skills**:

```
Asha — Mathematics
────────────────────────────────
Fractions                    92%   ▇▇▇▇▇▇▇▇▇▏
Linear equations             84%   ▇▇▇▇▇▇▇▇▏
Graph interpretation         68%   ▇▇▇▇▇▇▏
Geometry                     43%   ▇▇▇▇▏   calculation slips
Trigonometry                 31%   ▇▇▇▏    concept not understood

Help with these first:
  1. Trigonometry   (31%, 9 questions, not improving)
  2. Geometry       (43%, 12 questions, mostly calculation slips)
  3. Graphs         (68%, 6 questions, improving +14)
```

## The pipeline

```
 teacher marks the paper as usual
            │
            ▼
 phone / scanner captures it        (Teacher Lens, existing)
            │
            ▼
 graded_paper_items                 (existing: question, answer, tick/cross,
            │                        part marks, teacher comment)
            ▼
 map question → skill               keywords first, model second
            │
            ▼
 classify WHY the mark was lost     rules first, model second
            │
            ▼
 skill_observations                 append-only evidence, one row per question
            │
            ▼
 student_skill_mastery              decayed rolling score, a pure cache
            │
            ├──► the student's profile and what to teach them next
            ├──► the Teacher Lens whisper ("weak in balancing equations")
            └──► the head teacher's form-wide view
```

`lib/skill-engine.ts` is the engine, `lib/skill-taxonomy.ts` the curriculum.

## The taxonomy

A fixed, curated list of ~70 skills across the NECTA O-level core
(Mathematics, Physics, Chemistry, Biology, Geography, History, Civics,
English, Kiswahili, Computer Studies), each with a stable code, a strand, and
the keywords that identify it in a question.

It is curated rather than free-form for three reasons:

1. **A profile is only useful if the same skill has the same name every time.**
   "Balancing equations", "balancing chemical equations" and "equation
   balancing" as three separate weak topics is a worse answer than one.
2. **It is the model's closed vocabulary.** The mapper prompt hands the model
   the list and takes back a code. A model that can only choose an existing
   skill cannot invent one, and cannot drift the taxonomy over a term.
3. **A head teacher comparing four Form 3 streams needs the streams counting
   the same thing.**

Adding a skill is safe at any time: it seeds on boot, existing observations
keep their mapping, and `POST /v1/skills/reindex` re-attributes old papers to
it. `GET /v1/skills/unmapped` is the taxonomy's own to-do list — a question
nobody can attribute is a missing skill, not a student problem.

## Mapping

**Keywords first.** Each skill's keywords are scored against the question text
and whatever topic the marking pass wrote. A multi-word phrase scores three
times a bare word, because "balance the equation" discriminates and "equation"
does not. A topic string that names the skill outright wins outright.

**The model only sees what the keywords miss** — and it is also asked when two
skills score about equally, because that means the keywords did not actually
discriminate and a guess would be worse than a question.

Questions repeat across a class set — thirty papers, the same twenty
questions — so mappings are cached by subject and text. One class costs twenty
model calls, not six hundred.

**A school with no model box still gets a skill profile.** That is the point of
doing the keyword pass properly rather than treating it as a fallback.

## Why the mark was lost

Correct/incorrect is not enough. A student who understands a topic and keeps
dropping arithmetic needs drill; one who has never grasped it needs
re-teaching; and a bare "wrong" cannot tell a teacher which. So every lost
mark is classified:

| Type | Means |
|---|---|
| `concept` | has not understood the idea |
| `calculation` | right method, arithmetic slip |
| `careless` | knew it, mis-read or mis-copied |
| `incomplete` | correct as far as it goes, stopped early |
| `terminology` | right idea, wrong or imprecise vocabulary |
| `formula` | used the wrong formula or law |
| `reasoning` | steps do not follow, weak justification |
| `language` | meaning lost to spelling or expression |
| `unanswered` | nothing attempted |

Rules run first and are not negotiable: full marks is never an error, and a
**blank answer is always `unanswered`, never `concept`**. A teacher reading
"concept not understood" against a question the student never attempted would
rightly stop trusting the whole profile.

## Mastery, confidence and trend

```
mastery     time-decayed weighted mean of per-question mark ratios, 0-100
confidence  how much evidence is behind that number, 0-100
trend       recent half minus older half, in points
```

Three properties worth stating:

**Part marks matter.** The ratio is `marks_awarded / marks_possible`, not a
tick or a cross. "Nearly right" and "no idea" are different diagnoses and
binary correctness throws that away.

**Recency wins.** A 60-day half-life (`SKILL_HALF_LIFE_DAYS`) means a student
who has fixed their fractions stops carrying October's failures into
February. Four failures six months ago and four passes this week reads as ~80%
and a strongly positive trend, which is the truth.

**One question is a hint, not a diagnosis.** 20% off one question and 20% off
nine are the same score and completely different standing. Confidence
saturates at about three *effective* (decay-weighted) observations, and the UI
shows "not much evidence yet" below 40% so a teacher can tell which they are
looking at. Trend is not reported below four observations at all — fewer than
that is noise.

**Priority** ranks what to teach next:

```
priority = gap × (confidence/100) × momentum
```

A well-evidenced 43% outranks an uncertain 20%, because sending a teacher
after a rumour wastes the intervention a real gap had earned. A student
already climbing is discounted; one sliding is boosted.

## The teacher is always right

Where a scan proposed a mark and the teacher awarded a different one:

- **the teacher's number is what gets recorded.** Every time, without
  argument. There is no path in the code where K9's reading overrides it.
- the disagreement is written to `marking_feedback` with the question, the
  answer, both marks, and the subject.
- `GET /v1/skills/agreement` publishes the agreement rate, overall and per
  subject, with the most recent disagreements attached.

That number is the only honest measure of whether K9's reading of an answer
matches what teachers actually accept. It would have to be very high, for a
long time, across many schools, before anyone should even discuss letting K9
mark anything by itself — and publishing it is what keeps that conversation
honest instead of hopeful.

The contract: the lens sends `metadata.ai_is_correct` / `metadata.ai_marks_awarded`
on an item alongside the teacher's own values. If it sends nothing, nothing is
recorded and nothing is lost.

## The school-wide view

`GET /v1/skills/gaps?form_level=Form%203` answers the question a head teacher
actually has: **which skills is a whole form failing?**

> 68% of Form 3 are below half on simultaneous equations

That is a remedial lesson somebody can timetable next week, before the
national exam rather than after it. A list of 180 individual scores is not.

Skills with fewer than three students, or where the evidence is thin
(confidence < 30), are excluded: a score nobody has evidence for should not
drive a whole form's timetable.

`GET /v1/skills/:id/cohort` drills into one skill — who is where, and what
kind of mistake each of them is making.

## Evidence is truth, mastery is a cache

`skill_observations` is append-only and is the record. `student_skill_mastery`
is derived from it and nothing else: delete the table and
`POST /v1/skills/reindex` rebuilds it from the marked papers. Same discipline
as the fee ledger's balances, for the same reason — a number a teacher cannot
see the working behind is a number they will eventually stop believing.

Re-ingesting a paper updates its observations rather than duplicating them: a
unique index on `paper_item_id` means a re-index never double-counts a tick.

## Endpoints

| Method | Path | Who |
|---|---|---|
| `GET` | `/v1/skills` | staff — taxonomy, error vocabulary, thresholds |
| `GET` | `/v1/skills/students/:studentCode` | staff |
| `GET` | `/v1/student/skills` | the student, for their own screen |
| `GET` | `/v1/skills/gaps` | staff — the form-wide view |
| `GET` | `/v1/skills/:id/cohort` | staff |
| `GET` | `/v1/skills/agreement` | staff — teacher vs K9 |
| `GET` | `/v1/skills/unmapped` | staff — the taxonomy's to-do list |
| `POST` | `/v1/skills/reindex` | admin |

Nothing writes a skill except a teacher marking a paper
(`POST /v1/teacher-lens/paper-graded` → `ingestGradedPaper`). The value of the
profile rests entirely on it being the teacher's own judgement, recorded.

## Schema

| Table | What it holds |
|---|---|
| `skills` | The taxonomy: code, name, strand, subject, keywords |
| `skill_observations` | Append-only evidence, one row per marked question |
| `student_skill_mastery` | The derived rolling score, confidence, trend, dominant error |
| `marking_feedback` | Where K9's reading and the teacher's mark differed |

## Configuration

| Var | Purpose |
|---|---|
| `SKILL_HALF_LIFE_DAYS` | Decay half-life, default 60 (≈ a term) |
| `AI_PROVIDER=ollama` | Enables the model mapper and error classifier; without it the keyword and rule paths carry the load |

## Tests

`lib/skill-engine.test.ts` — 19 cases over the parts that must be right
without a database: taxonomy integrity, the offline mapper against the exact
questions in this brief (balancing equations, algebraic rearrangement, graph
interpretation, map reading), the blank-answer rule, decay, confidence
saturation, trend thresholds, dominant-error weighting, and the priority
ordering that decides who gets helped first.

## What this is not

It is **not** auto-marking, and nothing here is a step towards switching
auto-marking on quietly. If that is ever built it starts from the agreement
rate above, in the open, with a school choosing to opt in.

It is also not a ranking. Mastery is per skill and per student; there is no
league table in this subsystem and adding one would change what teachers mark
for.
