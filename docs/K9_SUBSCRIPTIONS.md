# Subscriptions: provision, show, then enforce

Status: adopted (enforcement off by default) • Owner: KobeAI school-server team
• Last updated: 2026-09-12

A KobeAI subscription is the operator's TSh-per-student-per-month. It is **not**
the school's own fees (`docs/K9_BURSAR_AI.md`) — different money, owed by
different people to different people, and the two are never netted against each
other.

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

## 4. Enforcement, when the school is ready

`requireActiveSubscription()` is now mounted — on exactly two endpoints:

```
POST /v1/student/market/questions/:id/lock     gated
POST /v1/student/market/questions/:id/answer   gated
```

Spending and earning KP is discretionary, so it is a fair thing to gate.
Everything else stays open, on purpose:

- **Browsing the market and reading your own balance are not gated.** A lapsed
  student should see what they are missing and why. A blank screen teaches
  nobody to go and renew.
- **Nothing academic is gated anywhere in K9.** Sitting an exam, the
  timetable, results, the classroom assistant — never. Withholding a child's
  exam over a parent's arrears is a decision a headteacher may take, and some
  do; it is not a decision an environment variable should take for them.

The gate is inert until `ENFORCE_SUBSCRIPTIONS=true`, and even then it fails
open until the first successful central sync, so a brand-new school is never
locked out of itself.

Note the structural limit, honestly: K9 has no student devices, so only three
surfaces carry a student JWT at all. The classroom TV runs on a kiosk secret
and Teacher Lens is staff-side. Per-student billing enforcement is
intrinsically weak on this architecture, and collection pressure belongs on
the bursar's arrears desk far more than on a 402.

## 5. A failure mode enforcement would have made live

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
| `SUBSCRIPTION_MONTHLY_TSH` | Price written onto a new subscription (default 5000) |
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
