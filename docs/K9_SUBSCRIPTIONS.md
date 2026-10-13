# Subscriptions: provision, show, then enforce

Status: adopted (enforcement off by default) • Owner: KobeAI school-server team
• Last updated: 2026-09-12

A K9 subscription is sold **per student, per year** — TZS 20,000–50,000,
`SUBSCRIPTION_ANNUAL_TSH` (default 30,000). It is **not** the school's own
fees (`docs/K9_BURSAR_AI.md`) — different money, owed by different people to
different people, and the two are never netted against each other.

## What the parent is actually buying

Not access to an app. No student carries a device; the school owns the
cameras, the classroom PCs, the server and the exams, and the teachers do the
marking. What a parent pays for is the **intelligence profile**: K9
continuously working out how their child learns, and helping the school teach
them better.

That makes the enforcement boundary unusually clear, and `lib/entitlements.ts`
is the only place it is drawn:

| Every student, paid or not | Subscribed |
|---|---|
| Attendance and presence | Skill mastery map |
| Identity, face gallery, safety | Deep exam analysis — *why* the mark was lost |
| Timetable, sitting exams | Recommended interventions |
| Marks, report cards, school records | Progress over time |
| | Personalised revision and retests |
| | AI learning plan |
| | Enhanced parent report |

So for an unsubscribed student K9 still says **48% in Mathematics** — that is
the school's record of its own pupil, not a KobeAI product. For a subscribed
one it adds:

```
48% Mathematics
  Algebra         81%
  Fractions       74%
  Geometry        39%
  Trigonometry    27%
Main issue: choosing the right formula
Recommended: 3 targeted lessons + 12 practice questions
Since the last exam: +7%
```

That contrast is the entire commercial argument, and the code renders it
literally: a locked profile returns **200 with the baseline marks attached**,
not a 402 and a blank page. The teacher sees "48% in Mathematics" and, beside
it, exactly what the subscription would have told them. It is the only honest
place to make the case.

### The line that does not move

**A child's attendance, safety and school record are never for sale.** K9 must
still recognise an unpaid student on camera, still mark them present, still
let them sit their exam, and still report their marks. `entitlements.test.ts`
asserts this — if someone moves attendance, presence, safety, identity,
exams, results or records into the premium tier, the build fails.

The KP question market is also **not** gated. It is an engagement feature
funded by KP, and a child who answers a physics question correctly should be
paid for it whether or not their fees are current.

## What was actually broken

`requireActiveSubscription()` had existed in `lib/central-sync.ts` since it was
written, and was mounted nowhere. `grep` returned its own definition and a
comment. Setting `ENFORCE_SUBSCRIPTIONS=true` changed nothing at all.

But mounting it would not have helped either, because the real gap was one
step earlier. Subscriptions live on central, keyed `tenant_id + student_code`,
and **nothing created them**. A school onboarded by photographing its class
lists (`docs/K9_ONBOARDING.md`) ended up with 600 students in `users` and zero
subscription rows. And `/central/v1/payments/initiate` refuses a student with
no subscription:

```
POST /central/v1/payments/initiate → 404 "Subscription not found for student"
```

So enforcement in that state would not have collected a shilling. It would
have locked out an entire school, with the only remedy being a super-admin
typing 600 students into the operator console one at a time — exactly the
"type a list into a computer" problem the onboarding work removed everywhere
else.

**Provisioning first. Then visibility. Then, when the school chooses,
enforcement.**

## 1. Provisioning

`POST /central/v1/roster`, authenticated with the tenant licence key like every
other school→central call.

```
school server                     central
     │  { students: [{student_code, student_name, grade}] }
     ├────────────────────────────────►
     │                                 upsert student_subscriptions
     │                                 status = 'trial'
     │                                 expires_at = now + SUBSCRIPTION_TRIAL_DAYS
     │  ◄────────────────────────────┤ { created, renamed, over_cap[] }
     │  syncOnce() immediately, so the
     │  new students are not "uncached"
```

It runs on the sync timer, and again the moment a roster import commits — a
class photographed at 09:00 is billable at 09:01.

**It is additive.** A student missing from a push is never cancelled. A
half-finished roster import, a class photographed but not yet committed, or a
sync racing a delete must never silently end a paid subscription. Removal
stays an explicit operator action.

**The trial window is the point.** Every new student gets one, so there is
always a runway to collect before anything could be gated, and a parent can
pay from day one.

## 2. The cap finally does something

`tenants.students_cap` was stored and never checked anywhere. The roster push
is where it can actually bite: central provisions up to the cap and returns
the overflow **by student code**. Those students have no subscription, which
under enforcement means they would be blocked — so the school sees the number
and the names rather than discovering it as a mystery 402.

That is a commercial conversation ("your plan covers 500, you have 540"), not
a silent failure in either direction.

## 3. Visibility before enforcement

`GET /v1/subscriptions/state` answers **what would switching this on do
today** — without switching it on:

- students the school has, versus subscriptions cached
- how many are unprovisioned (central has never heard of them)
- counts by status, and everything expiring in the next 14 days
- `would_block`: the number who would lose access right now

The Staff & Students page renders it. `GET /v1/student/subscription` lets a
student's own screen carry the countdown.

This ordering is not politeness, it is what works. A 402 nobody saw coming
produces an angry parent at the school office and a school that turns the
feature off. A countdown visible for two weeks produces a payment.

## 4. How the school collects it

The K9 annual fee goes on the same fee slip as everything else. The bursar
receipts it with the rest — cash, M-Pesa, reconciled off the school phone like
any other payment (`docs/K9_BURSAR_AI.md`) — and then activates the year from
that same receipt:

```
POST /v1/subscriptions/activate
  { student_id, months: 12, fee_transaction_id }
        │
        │  verifies the payment is on THIS student's ledger
        ▼
POST /central/v1/subscriptions/activate   (licence key)
        │
        ▼  status = active, expires_at = max(today, current expiry) + 12 months
        └─ syncOnce(), so the local cache knows before the screen refreshes
```

Paying early adds a year rather than losing the remainder. The activation
records `collected_by = 'school'` and the originating `fee_transactions.id`,
so every active subscription traces back to a specific payment on the school's
own books.

**The subscription is keyed to the student ID, never a phone number or a
device.** It survives a parent changing SIM, two siblings sharing one number,
and a child moving between classes — none of which a phone-keyed subscription
survives.

## 5. Enforcement, when the school is ready

`requirePremium(feature)` gates the intelligence layer on **the subject
student's** subscription — not the caller's. Most of these routes are
staff-facing, and a teacher's own account has nothing to do with whether a
particular child's profile is paid for; getting that backwards would gate
every student on whichever member of staff opened the page.

Gated: the skill profile, curated notes, retests, lesson plans and the
enhanced student magazine. Not gated: everything in the baseline column above,
and the KP market.

A locked route answers **200 with a described lock**, not 402 — every caller
is a dashboard rendering a student's page, and a 402 makes the product look
broken where a described lock makes it look like something the school can fix.

Deep analysis also costs real GPU time, so for an unsubscribed student the
model passes are skipped: the evidence is still recorded from the free keyword
and rule paths, so subscribing later and reindexing fills in everything that
was missed. Nothing is thrown away.

The gate is inert until `ENFORCE_SUBSCRIPTIONS=true`, and even then it fails
open until the first successful central sync, so a brand-new school is never
locked out of itself.

## 6. A failure mode enforcement would have made live

`syncOnce()` replaces the local cache with whatever central returned, deleting
every row absent from the snapshot. With enforcement on and one sync already
recorded, a central bug returning a short or empty list would have emptied the
cache and 402'd **every student in the school at once**.

A snapshot that would drop more than half of what is already cached is now
refused: the existing cache keeps serving, and the rejection is surfaced in
`getSyncStatus()`. A real mass-cancellation is far rarer than a bad response,
and the safe failure is to keep working.

## Configuration

| Var | Purpose |
|---|---|
| `ENFORCE_SUBSCRIPTIONS` | `true` gates the market. Default `false` |
| `SUBSCRIPTION_TRIAL_DAYS` | Trial window for a newly rostered student (default 30) |
| `SUBSCRIPTION_ANNUAL_TSH` | Price per student per year (default 30,000). `monthly_price_tsh` is kept as annual ÷ 12 so every MRR figure in the operator console stays correct |
| `CENTRAL_BASE_URL` / `TENANT_LICENSE_KEY` | Which control plane, and as whom |

## Suggested rollout

1. Deploy. Roster pushes start; every student gets a trial.
2. Watch `GET /v1/subscriptions/state` for a week. `would_block` should fall as
   parents pay, and `unprovisioned` should be zero.
3. Fix the over-cap list — either raise the cap or agree the school is over its
   plan.
4. Let the countdown run on student screens for two weeks.
5. Only then set `ENFORCE_SUBSCRIPTIONS=true`.

Steps 2–4 are not optional in practice. Skipping them is how a school decides
KobeAI is the thing that broke, rather than the thing they had not paid for.


## The numbers

A 1,000-student school at TZS 30,000/year is TZS 30,000,000/year gross at full
participation, before any school revenue share and before operating costs. The
realistic figure is lower — participation will not be 100%, and a school that
collects the fee on its own slip will expect a cut for doing so — but the
shape holds: the revenue scales with students, the cost scales with marked
papers, and both are things the school already produces.

Worth being clear-eyed about two things:

**Participation is the whole variable.** The product has to be visibly worth
30,000 to a parent who has never seen it, which is why the locked profile
shows the baseline marks next to what the subscription would add rather than
just refusing. The first term of a school's data is the sales material.

**A school that collects the fee controls the funnel.** That is the right
trade — a bursar adding one line to a fee slip beats 1,000 parents each
completing a separate M-Pesa flow, by an enormous margin — but it does mean
KobeAI's revenue depends on the school choosing to bill for it. The revenue
share is what makes that alignment real, and it belongs in the tenant record
rather than in code.
