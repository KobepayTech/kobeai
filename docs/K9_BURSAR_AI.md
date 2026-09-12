# The bursar's desk

Status: phases 0–1 adopted, 2–5 proposed • Owner: KobeAI school-server team •
Last updated: 2026-09-12

This started as a discussion of how to make the cashier side "more seamless
with AI". The honest answer began one step earlier than the AI, and that step
is now built.

## What the money surfaces used to be

An audit, kept here because it explains why the rest of this document is
shaped the way it is.

| Surface | Was |
|---|---|
| `GET /v1/bursar/subscription-payments` | **Real.** M-Pesa collections proxied from central over the tenant licence key |
| `…/:id/receipt.pdf` | **Real.** Rendered from the canonical central row |
| `POST /v1/bursar/deposit` | **Wrong ledger.** Credited `student_kp` — the *rewards* balance — at 1:1 with shillings |
| `GET /v1/bursar/students/balances` | **Mock.** `buildBalances()` fabricated eight students and the summary |
| `POST /v1/bursar/invoices/bulk` | **Real call, invented inputs.** Fired real STK pushes at phone numbers *derived from the student id* |
| `GET /v1/bursar/billing/summary` | **Mock.** Hard-coded totals |

Two things followed. There was no school fee ledger: `student_kp` is points a
child won answering a physics question, not shillings the school is owed, and
conflating them is not a shortcut, it is a category error. And an AI layer on
top of that would have been worse than none — a reconciliation agent that
confidently matches a payment to a fabricated balance produces a number a
bursar acts on. The failure mode of a half-built money system is not
"unhelpful", it is "wrong receipt, angry parent, missing shillings".

Hence: **the ledger first, then the agent.** Both are now in.

---

## Phase 0 — the ledger (shipped, no AI)

`lib/fees.ts` and `routes/fees.ts`. Four tables:

```
fee_structures     what a Form 2 owes this term, as named line items
fee_accounts       one per student: charged, paid, waived, balance
fee_transactions   append-only, signed: charge, payment, waiver, reversal
payment_matches    which transaction settled what, how it was matched, who agreed
```

**Sign convention, stated once:** a balance is what the student owes. A charge
is positive, a payment and a waiver are negative, a reversal takes the
opposite sign of the row it undoes.

The rules that make it a ledger rather than a spreadsheet:

- **Everything goes through `post()`.** Routes never touch `fee_accounts` or
  `fee_transactions`. A second place that knows how to move money is a second
  place that can get the balance wrong.
- **One transaction, both writes.** `post()` takes `SELECT … FOR UPDATE` on
  the account, then writes the ledger row and the cached balance together, so
  `fee_accounts.balance_tsh == SUM(fee_transactions.delta_tsh)` always holds.
  Two bursars posting to the same student serialise instead of racing.
- **`GET /v1/fees/verify`** recomputes every balance from the signed history
  and reports disagreements. It should always be empty. It exists because
  "should always" is not a control, and because the first thing anyone asks of
  a computer ledger is how they would know if it were wrong.
- **Nothing is edited or deleted.** A mistake is corrected by a reversal, and
  both rows stay. A reversal states the amount it believes it is undoing and
  is refused if the ledger disagrees — that mismatch means the screen and the
  database are out of step, which is exactly when not to write.
- **One receipt, one payment.** A partial unique index on
  `(reference) WHERE kind = 'payment'` makes double-posting an M-Pesa receipt
  impossible, whether it arrives from a re-photographed statement or a bursar
  who already typed it in.
- **One structure, one charge.** A partial unique index on
  `(student_id, fee_structure_id) WHERE kind = 'charge'` means re-running a
  term's billing is safe.
- **The invoice total comes from its line items,** never from the request, so
  what a parent is shown and what they are charged cannot differ.
- **A waiver needs a stated reason.** It is the one entry an auditor always
  asks about, so it is not writable without one.

Also retired in this phase: `buildBalances()` and the fabricated student list;
the hard-coded billing summary; and the deposit endpoint that wrote to the KP
rewards ledger. Their OpenAPI operations went with them, so no generated
client still points at a fiction.

And bulk invoicing now joins `parent_children` → the parent's user row for a
real phone. A student with no linked parent is **reported, not guessed at** —
that endpoint used to send a real M-Pesa prompt to a real stranger every time
someone pressed the button.

## Phase 1 — the reconciliation agent (shipped)

`lib/payment-reader.ts`, surfaced at **Reconcile** in the dashboard.

What happens in a school office: confirmations arrive as SMS on the school
phone; somebody reads them off the screen and copies the name, the amount and
the receipt into a book. Names arrive mangled — the parent's name, not the
child's; a first name and a clan name in either order. Amounts arrive short,
or in three instalments. It is a skilled, tedious, error-prone afternoon.

```
paste or photograph
        │
        ▼
   read     regex first, model second   →  {receipt, payer, phone, amount, date}
        │
        ▼
   match    phone · name · amount       →  one candidate, with a reason
        │
        ▼
  propose   on screen, per row
        │
        ▼
  CONFIRM   ← a named human, and only then does the ledger move
```

**Reading.** The regex path is primary, not a fallback: M-Pesa text is
machine-generated and highly regular, so the deterministic reader gets the
common case exactly, strips the running balance M-Pesa appends, normalises
every phone shape to `255…`, and dedupes a confirmation forwarded twice. The
vision model is there for printed statement layouts it does not know, and its
rows are **unioned** with the regex rows rather than replacing them — a
payment the regex found for certain must not vanish because a model
reformatted the page. A school with no model box reconciles exactly as well.

**Matching.** Three signals, strongest first:

1. the sending phone is a registered parent's phone (60);
2. the payer's name — the whole of it inside a known name scores 45, two
   shared names 30, one shared name 10, because half a village shares a single
   name;
3. the amount exactly clears one student's balance (20), which corroborates
   but never identifies: on its own it matches every student who owes the same
   termly figure, which in a school is most of a form.

A single candidate over 45, at least 20 clear of the runner-up, is proposed
with the reason spelled out ("Matched on parent phone +255712345678, exactly
clears TSh 120,000"). **Two plausible candidates produce no proposal at all** —
one parent phone and two siblings has no defensible answer, and returning the
slightly-better one would be the worst outcome available: confidently wrong,
and confirmed by a tired human who trusted it. Confidence is capped below 100,
because a number that reads as certainty is how people stop checking.

**Posting.** The confirm endpoint is the only thing in reconciliation that
writes. Rows are posted one at a time on purpose: one duplicate receipt in a
batch of forty must not roll back the thirty-nine good ones, so failures come
back per row. Every posted payment keeps its `payment_matches` row — the
payer, the phone, how it was matched, why, and which human agreed — so "why is
this parent's money on this child's account" always has a recorded answer.

**Arrears** (`GET /v1/fees/arrears`) lists families worst first with the
parent's phone, whether they are paying-but-behind or have paid nothing, and a
message ready to copy. The wording is deliberately **rule-based, not
generated**: a school speaking to a parent about money should say the same
thing every time, be checkable before it goes, and read identically whether or
not the model box is switched on. Copy sends nothing — a person pastes it and
presses send.

---

## Still proposed

### Phase 2 — arrears triage with review

What phase 1 ships is a list and a fixed message. The next step is per-family
judgement: the channel (push, SMS, or "the bursar should telephone this one",
because a family three terms behind is a conversation), the register, and a
**do-not-chase** flag where the pattern says hardship rather than neglect —
consistent partial payments, a recent waiver, a sibling's account in credit.
Drafts go into a review queue the bursar clears, exactly like the market
agent's human-review mode. No message leaves the school unsent by a person; a
school that lets an agent dun parents automatically will lose a parent, and
deserve to.

Needs a term of phase-1 data before it is worth anything.

### Phase 3 — forecasting

With a term of matched transactions, the cheap statistical work pays better
than the model does: expected collections from this school's own payment curve
(Tanzanian fees arrive in a very particular shape around term start and exam
weeks), the gap against committed spend, and "if collections track last term
you are TSh 4.2M short in week 9" — which is the number a head of school needs
in week 3. The model's job is turning that into three sentences somebody
without a finance background reads, in the weekly magazine K9 already
generates.

### Phase 4 — asking the ledger questions

"How much has Form 3 paid this term?" A narrow natural-language layer over a
small set of **parameterised** queries — the agent picks a query and fills its
parameters, it never writes SQL. That constraint is the difference between a
useful answer and a subtly wrong total, and subtly wrong totals are how a
finance tool loses its users.

### Phase 5 — anomaly watch

Nightly, on an append-only ledger: the same receipt matched to two students; a
cash entry with no corresponding shift; a waiver pattern concentrated on one
staff member's entries; a balance that moved without a transaction row (which
`verifyLedger()` already detects and which should be impossible — which is
exactly why it is checked). Flags to a named human — the head of school, not
the bursar whose entries are being checked — with the evidence attached. Never
an accusation, never an automatic block.

---

## The three rules

They hold for everything above, shipped and proposed, because money deserves
them more than the rest of K9 does, not less:

1. **Propose, never post.** No agent writes a `fee_transaction`, messages a
   parent, or initiates an STK push without a human pressing a button on that
   specific item.
2. **Show the reason.** Every proposal carries how it was reached. A bursar
   confirming a match they cannot check is the same as no bursar at all.
3. **Fail closed and stay usable.** No brain, unreachable brain, no internet:
   the regex reader, exact matching, and manual entry all still work. K9's
   core promise is that the school keeps running on its own LAN with the power
   cut and the fibre down, and the money desk is the last place to break it.

## Where it runs (master / worker)

The ISO installs a **master** laptop holding Postgres, the API and the
dashboards, and a **worker** desktop holding Ollama and the models.

The ledger, the matching arithmetic and every write stay on the master, with
the database and the backups. Only the statement-reading pass crosses to the
worker, and it is optional — with the worker off, reconciliation falls back to
the regex reader and the bursar does slightly more tapping. Nothing about a
parent's payment leaves the school LAN: M-Pesa settlement already goes through
central over the licence key, but the *analysis* of it does not.

The nightly backup the ISO configures matters much more now that the ledger is
real. It should be **verified**, not just written — a restore test belongs in
`kobeai-backup` before a school trusts this with a term of fees.

## Endpoints

| Method | Path | Who |
|---|---|---|
| `GET` | `/v1/fees/summary` | staff |
| `GET` | `/v1/fees/accounts` | staff |
| `GET` | `/v1/fees/accounts/:studentId` | staff |
| `GET` | `/v1/fees/verify` | bursar |
| `GET`/`POST` | `/v1/fees/structures` | staff / bursar |
| `POST` | `/v1/fees/structures/:id/charge` | bursar |
| `POST` | `/v1/fees/payments` | bursar |
| `POST` | `/v1/fees/waivers` | bursar |
| `POST` | `/v1/fees/transactions/:id/reverse` | bursar |
| `POST` | `/v1/fees/reconcile/photo` | bursar (image body) |
| `POST` | `/v1/fees/reconcile/text` | bursar |
| `GET` | `/v1/fees/reconcile` · `/:id` | bursar |
| `POST` | `/v1/fees/reconcile/:id/confirm` | bursar |
| `GET` | `/v1/fees/arrears` | bursar |

"bursar" is `admin` / `super_admin`; teachers can read accounts but post
nothing.

## Tests

`lib/payment-reader.test.ts` covers reading a real M-Pesa confirmation, not
mistaking the running balance for the payment, every phone format, deduping a
forwarded confirmation, each matching signal, the refusal to choose between
two siblings, and the confidence cap. `lib/fees.test.ts` covers the guards
every write passes through — amount validation, the implausible-figure ceiling,
and the fact that a negative charge cannot sneak in as a credit.
