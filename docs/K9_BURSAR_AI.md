# The bursar's desk, and what AI should actually do there

Status: proposed • Owner: KobeAI school-server team • Last updated: 2026-09-12

This is a design discussion, not a description of shipped code. It exists
because the question came up as "make the cashier and master systems more
seamless with AI", and the honest answer starts one step earlier than the AI.

## Where the money surfaces stand today

An audit, so the proposal is not built on a misunderstanding.

| Surface | Real or mock |
|---|---|
| `GET /v1/bursar/subscription-payments` | **Real.** Proxies central over the tenant licence key; M-Pesa collections with status and receipt |
| `GET /v1/bursar/subscription-payments/:id/receipt.pdf` | **Real.** Renders from the canonical central row |
| `POST /v1/bursar/deposit` | **Half real.** Credits `student_kp` + `kp_ledger` atomically when the student exists; display-only otherwise |
| `GET /v1/bursar/students/balances` | **Mock.** `buildBalances()` fabricates the list and the summary |
| `POST /v1/bursar/invoices/bulk` | **Real call, fake inputs.** Initiates real STK pushes against phone numbers *derived from the student id* |
| `GET /v1/bursar/billing/summary` | **Mock.** Hard-coded totals |
| Stationery drives | **Real.** Orders, parent approval, per-school compilation |
| KP economy | **Real,** and deliberately separate from money |

So the bursar page today is a convincing demo of a system that does not yet
hold the school's money. Two things follow.

**First: there is no school fee ledger.** `student_kp` is a rewards balance,
not an account receivable. Crediting a TSh deposit into it at 1:1 (which
`/v1/bursar/deposit` does, with a comment saying as much) conflates two
different things that must never be conflated — one is a promise the school
owes a supplier, the other is points a child won answering a physics question.

**Second: an AI layer on top of that is worse than no AI layer.** A
reconciliation agent that confidently matches a payment to a fabricated
balance produces a number a bursar will act on. The failure mode of a
half-built money system is not "unhelpful", it is "wrong receipt, angry
parent, missing shillings".

So: **the ledger first, then the agent.** Everything below assumes that
order.

## Step 0 — the ledger (no AI)

Four tables, no cleverness:

```
fee_structures     what a Form 2 day student owes this term, by line item
fee_accounts       one per student: charged, paid, balance, as of when
fee_transactions   append-only, signed: charge, payment, reversal, waiver,
                   with method (mpesa | cash | bank | waiver), reference,
                   received_at, entered_by
payment_matches    which fee_transaction a central payment row settled,
                   with how the match was made and who confirmed it
```

The same rule the KP ledger already follows applies: every mutation writes a
transaction row and updates the cached balance **inside one transaction**, so
the sum of the ledger always equals the balance. A bursar's trust in this
system is worth more than any feature on top of it, and it is lost the first
time two screens disagree.

`buildBalances()` dies here. `/v1/bursar/deposit` stops writing to
`student_kp` and starts writing to `fee_transactions`. Bulk invoicing joins
against a real parent phone (`parent_children` → the parent user row) instead
of deriving one from a student id — that one is a live-fire hazard today and
should be fixed whether or not any of the rest happens.

## Step 1 — the reconciliation agent

This is where the bursar's day actually goes, and where AI earns its place
first.

What happens now in a Tanzanian school office: M-Pesa confirmations arrive as
SMS on a school phone. Somebody reads them off the screen and types the name,
the amount and the receipt number into a ledger book or a spreadsheet. Names
arrive mangled — the parent's own name, not the child's; a first name and a
clan name in either order; a nickname. Amounts arrive short, or as three
payments across a fortnight. Matching them to students is a skilled, tedious,
error-prone afternoon.

K9 already has the machinery:

- **Reading.** A photograph of the M-Pesa statement or the phone screen goes
  through the same `paper-reader` pipeline the class lists use: vision model
  → text, then a structuring pass into `{payer_name, phone, amount, receipt,
  paid_at}` rows, with a deterministic regex fallback. M-Pesa confirmation
  text is far more regular than a handwritten class list, so the regex path
  alone handles the common case.
- **Matching.** For each row, candidates from: exact phone against
  `parent_children`, the same-words-different-order name match the roster
  importer already uses, amount against the exact outstanding balance, and
  recent invoice history. Each candidate gets a score and a stated reason.
- **Deciding.** A single unambiguous candidate over a high threshold is
  proposed as a match. Everything else goes into a queue the bursar clears in
  a few taps.

The agent's output is a **proposal list**, never a posting. The bursar sees
"Asha Juma Mwangi — TSh 120,000 — receipt QGH4K2LM9 — matched on parent phone
+255 7xx and exact balance", presses Confirm, and *that* writes the
`fee_transaction` and the `payment_match`. Same shape as the roster commit:
the model reads, the human decides.

Realistic effect: an afternoon becomes a quarter of an hour, and the
unmatched pile — the part that actually needs a human — is the only part a
human touches.

## Step 2 — arrears triage

Once there is a real ledger and real matches, the question "who do I chase and
how" becomes answerable with a model rather than a spreadsheet sort.

The agent drafts, per family:

- the amount, the term, and what it is for;
- a message in the parent's own language (`staff_profiles.language` shows the
  pattern; parents get the same field), in the register a Tanzanian parent
  actually reads;
- the channel — the parent app push, SMS, or "the bursar should call this
  one", because a family three terms behind is a conversation, not a push
  notification;
- and, importantly, a **do-not-chase** flag on families where the pattern says
  hardship rather than neglect: consistent partial payments, a recent waiver,
  a sibling's account in credit.

The bursar reviews a list of drafts and sends the ones they agree with. No
message leaves the school unsent by a human. A school that lets an agent
dun parents automatically will lose a parent, and deserve to.

## Step 3 — forecasting and the term view

With a term of matched transactions the cheap statistical work pays better
than the model does:

- expected collections for the rest of the term, from this school's own
  payment curve (Tanzanian school fees arrive in a very particular shape
  around term start and exam weeks);
- the gap against committed spend — salaries, the stationery drive, the
  exam fees;
- "if collections track last term, you are TSh 4.2M short in week 9" — which
  is the number a head of school needs in week 3, not week 9.

The model's job here is not the arithmetic. It is turning the arithmetic into
three sentences the head of school reads without a finance background, in the
weekly magazine the system already generates.

## Step 4 — asking the ledger questions

"How much has Form 3 paid this term?" "Which families paid in full before
week 2?" "What did we spend on exercise books last year?"

A narrow natural-language layer over the ledger, restricted to a small set of
parameterised queries — not generated SQL. The agent picks a query and fills
its parameters; it never writes the query. That constraint is the difference
between a useful answer and a subtly wrong total, and subtly wrong totals are
how a finance tool loses its users.

## Step 5 — anomaly watch

An append-only ledger makes a small set of checks worth running nightly:

- the same M-Pesa receipt matched to two students;
- a cash deposit entered with no corresponding shift on the school phone;
- a waiver pattern concentrated on one staff member's entries;
- a balance that moved without a transaction row (which should be impossible,
  and is therefore exactly what a nightly check is for).

These are flags to a named human — the head of school, not the bursar whose
entries are being checked — with the evidence attached. Never an accusation,
never an automatic block.

## What the money agents must never do

The same three rules the market agent and the paper importer already follow,
because money deserves them more, not less:

1. **Propose, never post.** No agent writes a `fee_transaction`, sends a
   message to a parent, or initiates an STK push without a human pressing a
   button on that specific item.
2. **Show the reason.** Every proposal carries how it was reached — which
   phone, which name match, which balance. A bursar confirming a match they
   cannot check is the same as no bursar at all.
3. **Fail closed and stay usable.** No brain, unreachable brain, no internet:
   the regex reader, the exact-match reconciler and the manual entry path all
   still work. K9's core promise is that the school keeps running on its own
   LAN with the power cut and the fibre down; the money desk is the last place
   to break that.

## Where this runs (master / worker)

The ISO installs two nodes: a **master** laptop holding Postgres, the API and
the dashboards, and a **worker** desktop holding Ollama and the models.

That split suits this work well:

- the ledger, the matching arithmetic and every write stay on the master,
  where the database and the backups are;
- only the reading pass and the message drafting cross to the worker, and both
  are individually optional — if the worker is off, reconciliation degrades to
  the regex reader and exact matching, and the bursar does slightly more
  tapping;
- nothing about a parent's payment leaves the school LAN. M-Pesa settlement
  already goes through central over the licence key; the *analysis* of it
  should not.

The nightly backup the ISO already configures becomes materially more
important the moment the ledger is real. It should be verified, not just
written — a restore test belongs in `kobeai-backup` before any of this ships.

## Suggested order

| Phase | What | Why first |
|---|---|---|
| 0 | `fee_*` tables; retire `buildBalances()`; real parent phones for bulk invoicing | Nothing above is safe without it, and the derived phone numbers are a live hazard now |
| 1 | Reconciliation agent (read → match → propose → confirm) | Biggest manual burden, clearest win, reuses the paper reader already built |
| 2 | Arrears triage with drafted, human-sent messages | Needs a term of phase-1 data to be any good |
| 3 | Forecasting in the weekly magazine | Cheap once 1 and 2 are real |
| 4 | Parameterised natural-language queries | Convenience, not capability |
| 5 | Nightly anomaly watch | Wants a year of ledger to tune |

Phase 0 is unglamorous and is most of the value. The agent is what makes it
feel seamless; the ledger is what makes it true.
