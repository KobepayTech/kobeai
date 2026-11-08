# Question Market Agent

Status: adopted • Owner: KobeAI school-server team • Last updated: 2026-09-12

The question market is the part of K9 students touch by choice. They browse
open questions on a shared classroom PC, rent five minutes of exclusive time
on one for 10 KP, answer it, and win the reward if they are right.

It used to be a shelf someone stocked by hand: an operator in Dar typed
questions into a form and every school in the country answered the same ones.
That does not survive ten schools, and it never knew what any particular
school was weak at.

An agent runs it now, on the school's own models.

## The cycle

`artifacts/api-server/src/lib/market-agent.ts`, once every
`cycle_minutes` (default 15), and on demand from the operator console.

```
 sweep  ──► expire what nobody solved inside stale_hours
            release locks whose renter walked away

 read   ──► open questions per subject          (market_questions)
            questions won in the last 24h       (the demand signal)
            weak topics across the school       (student_learning_profile)
            subjects the roster actually takes  (student_subjects)

 plan   ──► [{ subject, topic, difficulty, count, reason }]

 write  ──► generate each batch as strict JSON on the on-prem brain

 verify ──► re-solve every draft with the answer key hidden;
            drop the ones the two passes disagree on

 price  ──► kp_reward = difficulty × scarcity, inside the operator's band

 post   ──► insert, deduped on a normalised prompt fingerprint
```

Every cycle writes one `market_agent_runs` row: the plan, the model, and how
many questions were generated, accepted, rejected and expired. The market
spends students' KP, so it is never a black box.

## Planning

Each subject has a floor (`floor_per_subject`, default 6 open questions). A
subject students are actually clearing gets a deeper shelf — the floor plus
one for every two questions won in the last day, capped at double — so
demand pulls supply instead of an operator guessing.

Topics come from the school, not from a global list:

1. **Weak topics first.** `student_learning_profile.computed_topics_weak` is
   rolled up nightly from marked papers. The agent counts how many students
   share each weak topic and quizzes the ones that come up most.
2. **Attribution is conservative.** A weak topic only counts for a subject if
   the subject is named in it or it shares real words with that subject's
   curriculum entries. Quizzing Biology students on "quadratic equations"
   because the string happened to be in the weak list would be worse than
   using the rotation.
3. **Curriculum rotation otherwise.** A school in week one has no signal yet,
   so the agent walks the NECTA O-level topic list for each subject, rotating
   hourly so it does not mint the same topic every cycle.

Subjects themselves come from `student_subjects` — what the roster actually
takes, read off the photographed subject-option sheets — falling back to a
core O-level set on day one. An operator subject list overrides both.

## Verification

Generation is cheap and wrong often enough to matter. Every draft is sent
back to the model a second time **with the answer key removed**, and the
checker is asked three things: which option is correct, whether exactly one
option is defensible, and how confident it is.

A draft survives only if the checker picks the same index, does not flag the
question as ambiguous, and is at least 60% confident. Anything else is
counted in `rejected` and thrown away.

The structural checks run first and are not negotiable: exactly one correct
index inside range, 2–6 distinct options, no "all of the above", no duplicate
options (two options saying the same thing make a question unanswerable when
only one index scores).

An unreachable brain means "not verified", which means **not posted**. The
agent never posts a question it could not check.

## Pricing

```
base     = reward_min + (reward_max - reward_min) × weight[difficulty]
scarcity = (target - open) / target            clamped to [0, 1]
kp       = clamp(base × (1 + scarcity × 0.5), reward_min, reward_max)
```

`weight` is 0.05 / 0.20 / 0.45 for easy / medium / hard. The subject nobody
has stocked pays best, so the floor refills itself; the band is the
operator's and the agent cannot leave it.

Two things bound the KP the market can create: the band caps any single
question, and `max_open_questions` caps the whole floor. The operator console
shows the resulting **open liability** — what the floor would pay if every
open question were won — next to the KP actually paid out over 24 hours and
7 days, so a band that turns out to be too generous is obvious in a day
rather than a term.

KP still only moves through `kp_ledger`. The agent writes questions; it does
not touch balances.

## Failing closed

| What breaks | What happens |
|---|---|
| No LLM on this deploy (`AI_PROVIDER != ollama`) | Falls back to recycling teacher-authored quiz questions |
| Ollama unreachable, or no suitable model installed | Same fallback |
| Model returns prose instead of JSON | `parseJsonLoose` salvages a fenced or embedded object; otherwise the batch is skipped |
| Drafts all fail verification | Nothing is posted; the run is marked `partial` with the reject count |
| No quiz bank either | Nothing is posted; the run is marked `failed` with a reason |

The quiz-bank fallback is worth more than it sounds: teachers have already
written thousands of multiple-choice questions with answer keys into
`quiz_questions`, and those are syllabus-accurate by construction. A school
with no GPU box still gets a live market.

The sweep runs whether or not a model is available, and whether or not the
agent is enabled — housekeeping the floor needs regardless.

## What students see

- Only `review_status = 'approved'` questions. With `human_review` on, the
  agent parks drafts at `pending` and a human approves them before any
  student sees them.
- Only subjects they take, once their options have been recorded. A student
  with no recorded options sees everything, which is right for Form 1 and 2.
- The agent's one-line explanation after they answer correctly, so winning
  teaches something instead of just paying.
- Whether a question came from the agent or an operator (`source`), because
  "who set this?" should never be a mystery.

## Operator console

`/market-agent` in the dashboard, `super_admin` only —
`/central/v1/admin/market-agent`.

- **Dry run.** The exact plan the next cycle would execute, with the agent's
  reason per line. Nothing is generated to produce it.
- **Settings.** Floor depth, ceiling, cycle interval, stale window, reward
  band, human review, subject override. The interval is re-read every tick,
  so a change takes effect on the next cycle rather than the next reboot.
- **Review queue.** Drafts waiting for a human when review mode is on.
- **Run history.** Every cycle, with its notes or its error.

A school administrator cannot reach any of it. The market decides what
students are asked and what they are paid; that stays with the operator.

## Schema

| Table | What it holds |
|---|---|
| `market_questions` | Extended with `topic`, `difficulty`, `form_level`, `source`, `model`, `agent_run_id`, `explanation`, `fingerprint` (unique), `review_status` |
| `market_agent_runs` | One row per cycle: plan, model, generated / accepted / rejected / expired, notes, error |
| `market_agent_settings` | Singleton operator knobs |

The `fingerprint` unique index is the dedupe: a normalised hash of
`subject|prompt`, so the same question is never posted twice however the model
spaced or capitalised it. Legacy and hand-typed rows leave it null, and a
unique index permits many nulls.

## Configuration

| Var | Purpose |
|---|---|
| `AI_PROVIDER=ollama` | Turns the brain on at all |
| `OLLAMA_BASE_URL` | Where it lives (default `http://localhost:11434`) |
| `OLLAMA_MODEL` | Pins one text model instead of the registry's list |
| `OLLAMA_VISION_MODEL` | Pins one image-reading model |

Model names otherwise come from `config/k9-models.json`
(`runtime.ollama.text_model` / `vision_model` and their fallbacks) — never
hard-code one in a route.

Note that the agent does **not** sit behind `OLLAMA_ENABLE_GENERATION`. That
flag gates per-paper generation cost on the marking path; the market agent
runs a bounded number of calls per cycle and is governed by
`cycle_minutes` and the floor instead.

## Tests

`artifacts/api-server/src/lib/market-agent.test.ts` covers the pure logic
without a database: subject choice, floor and ceiling arithmetic, demand
scaling, weak-topic attribution, the pricing band, draft validation, and
fingerprint normalisation. `kobe-brain.test.ts` covers JSON salvage. Run them
with `pnpm --filter @workspace/api-server run test`.
