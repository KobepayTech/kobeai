# Student Learning Packs

Open Teacher Dashboard > Learning Packs (`/learning-packs`). Complete marking
there, or close an exam in Results, to schedule one quick pack per student result.
The durable worker runs every 30 seconds and resumes after restart. Quick packs
are one A4 sheet, two sides; extended packs are three sheets, six sides, requested
with an explicit accepted price. Class bands: Form 1 green, 2 blue, 3 red, 4 yellow.
Names, codes and class labels appear on both sides and work in monochrome.

## Evidence

Each pack snapshots question/item IDs, questions, student answers, teacher marks,
confidence, image references and reference answers. Missing/uncertain evidence,
incomplete papers, duplicate questions, and unverified correct answers require
teacher review. Camera-derived answers are `vision_unverified`. The review screen
shows evidence, allows editing lessons, and records reviewer/time. Original
problems and source evidence remain in the audit record. It does not change marks.
AI generation uses the existing local-model configuration: `AI_PROVIDER=ollama`
and `OLLAMA_ENABLE_GENERATION=1`. Unavailable/invalid output is an evidence-only
review draft, never a fabricated successful generation. Quick packs prioritize
two captured questions; extended packs up to six. PDF overflow blocks printing
instead of silently adding sheets or shrinking text.

## Money

Active, unexpired cached subscriptions are mandatory even when global enforcement
is off. Default TZS 100 per side means quick TZS 200 and extended TZS 600.
Administrators configure pricing and printer. Price freezes on first funding
attempt, or when accepting the extended quote. Queueing reserves funds; confirmed
output debits once; failed printing releases funds. Unique pack and ledger keys,
transactions and row locks prevent duplicate charges and negative funds.

`print_cash_accounts` is a real local printing allocation ledger funded by bursar
receipts, separate from school fees and KP rewards. It is NOT connected to an
external Kobepay wallet. Record only money actually received or transferred for
printing. Do not copy a spendable balance into two ledgers. A future Kobepay
adapter needs atomic reserve/settle/release operations. Parent monthly printing limits are now available in School Services; live
Kobepay synchronization still needs the real wallet repository. Negative print ledger
entries are the printing revenue audit; receipt references prevent double deposits.

## Printer

Run `services/k9-print/agent.py` on a Linux computer with CUPS and an A4 duplex
printer. Set a strong `K9_PRINT_AGENT_SECRET` on server and agent. On the agent also
set `K9_SERVER_URL=https://school.example/api`, `K9_PRINTER_ID=printer-lib-01`, and
`CUPS_PRINTER` to the installed printer name. Use TLS outside a trusted local host.
The bridge claims once and submits one A4 copy with two-sided-long-edge.

CUPS acceptance does not prove physical output. The default bridge holds jobs at
submitted until an administrator checks output and clicks **Confirm printed &
charge**. Failed output releases funds; **Not printed · retry** is explicit after
checking the spooler. Ambiguous claims never expire/reprint automatically. This
requires staff reconciliation after a crash, preventing duplicate output/charges.
The agent cannot debit accounts. Supervised class trays and recorded collection
keep distribution orderly. Teachers access their classes; financial operations
are admin-only. The school-server database is the tenancy boundary.

## API and tests

`/v1/learning-packs`: list; `/:id`: evidence; `/:id/pdf`: printable preview.
POST `/exams/:id/complete`, `/:id/review`, `/:id/extended`, `/:id/confirm-print`,
`/:id/retry`, `/:id/collect`, `/settings`. Cash: GET `/v1/print-cash/accounts`, POST
`/v1/print-cash/deposits` with student_id, amount_tsh, receipt. Printer:
POST `/v1/learning-pack-agent/claim`, GET `/:id/pdf`, POST `/:id/submitted` with a
dedicated secret and per-claim token.

Tables bootstrap idempotently using the existing server pattern. No deposits or
paid packs are seeded. From api-server run `node --import tsx --test
src/lib/learning-pack-content.test.ts`. For hermetic PostgreSQL integration tests,
set K9_TEST_PGLITE_PATH to an installed @electric-sql/pglite/dist/index.js and run
learning-packs.integration.test.ts. These never modify a school database.

For printable mathematical symbols and other Unicode text, install DejaVu Sans
on Linux or set `K9_PRINT_FONT_PATH` and optionally `K9_PRINT_BOLD_FONT_PATH` to
licensed TrueType fonts. Windows Arial is detected automatically. Without a
Unicode font, non-ASCII content is blocked instead of printing corrupted text.

Once a learning-pack batch is scheduled, the Results API blocks reopening or
editing that assessment. Create a corrected assessment for revised marking;
this prevents queued/paid packs silently referring to changed exam evidence.

PalmPesa subscriptions, parent printing allowances and reconciliation are documented in K9_PALMPESA_AND_KOBEPAY.md.
