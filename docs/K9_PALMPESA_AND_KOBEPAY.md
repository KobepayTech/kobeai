# PalmPesa subscriptions and Kobepay school services

## Implemented in K9

The parent subscription screen now requests a server-authoritative quote, including
the billing period. Annual TZS 60,000 / 100,000 plans charge that annual amount,
not the normalized monthly MRR figure. Operators configure the price per month or
year in Central > School > Subscriptions. K9 never takes a mobile-money PIN.
PalmPesa currently requires a payer name, phone and valid email.

The central server creates a durable order before sending the payment prompt.
A unique transaction ID and the exact request survive restarts and timeouts.
Retries reuse the ID; concurrent payment attempts for the same student reuse an
unresolved order. A price change requires the parent to accept a fresh quote.

Callbacks never grant subscriptions directly. When signing is configured, K9
checks the exact raw body with timestamped HMAC-SHA256 and a five-minute window.
Whether signed or unsigned, a callback only schedules verification through the
authenticated provider status API. Transaction ID, order ID, amount and TZS must
all match. Only COMPLETED activates access. Duplicate events/settlements do not
extend twice. Late completion after EXPIRED is accepted; stale failure after
success cannot revoke paid time. Early renewals extend from the existing expiry.
Subscriptions remain authoritative on central and flow to the school cache using
existing synchronization; access may take a sync cycle to appear at school.

The PalmPesa reconciliation screen shows provider status, errors and receipts.
Recheck never creates a new transaction. No synthetic successful payments, fake
receipts or random payment outcomes remain in the subscription checkout.

Parents also have School Services: monthly printing allowances (school timezone
Africa/Dar_es_Salaam), automatic printing pause, longer-pack requests with a price,
and print/collection history. Limits count confirmed charges plus reservations.
Allowance changes release unsent reservations for re-evaluation. Already claimed
printer work cannot be recalled. The printer rechecks the allowance at dispatch.
The local printing allocation account remains separate from pocket money.

## Configuration — central server only

Set these through the host's secret/environment settings:

- `PALMPESA_API_TOKEN`: account-approved PalmPesa API token.
- `PALMPESA_CALLBACK_URL`: public HTTPS URL ending in
  `/api/central/v1/payments/palmpesa/callback` on the central server.
- `PALMPESA_SIGNING_SECRET`: only the signing secret actually issued by PalmPesa.

The fixed provider API is `https://palmpesa.co.tz/api/v2/async/payments`.
School servers still need CENTRAL_BASE_URL and their TENANT_LICENSE_KEY. Secrets
never belong in the browser, source control or a chat message. Missing payment
configuration disables checkout. No live transaction was made during development.

The dispatch clock limits all server replicas sharing the database to one provider
operation per three seconds. Unresolved payments poll with backoff. Final unpaid
orders are reconciled daily and on callbacks/manual recheck; COMPLETED orders stop.
Provider outages/errors retain the order for reconciliation, rather than assuming
that an ambiguous payment failed. Verify the first real payment and callback
with the account holder before enabling parent use.

## Kobepay access blocker

The previously identified real repository is
https://github.com/proglabsofficial/kobepay-app . It returns 404 through the current
GitHub connection. Its wallet code, NFC registry, merchant settlement APIs and
permissions could not be inspected or changed. This implementation does not claim
to complete that app, debit its balances or connect to its APIs.

K9's previous parent wallet endpoints returned demo balances and invented deposit
success. They now return KOBEPAY_NOT_CONNECTED instead. Subscription payments are
separate and use PalmPesa. Bursar printing allocations continue to work, but must
represent money actually transferred/received, never copied spendable balances.

Once repository access is granted, implement the following inside the existing
Kobepay ledger, using its real schema and auth rather than a parallel wallet:

1. School/student linkage and parent ownership verification.
2. Printing allowance/protected allocation within the single wallet balance.
3. Idempotent reserve, confirm/settle, release and lookup operations keyed by
   school + pack + revision, with integer TZS and transactional ledger posting.
4. K9 delivery outbox/reconciliation so timeouts never double-debit or print twice.
5. NFC/QR pickup tied to the existing card registry; duplicate pickup rejection.
6. Stationery operator payable balance, collection history and parent receipts.
7. Funding/refund/reconciliation controls and admin dashboards on the real app.

No external wallet endpoints are invented or called while that contract is unknown.
K9 does not need a second authoritative pocket-money ledger.

## Verification

From artifacts/api-server:

`node --import tsx --test src/lib/palmpesa-client.test.ts`

Set K9_TEST_PGLITE_PATH to an installed @electric-sql/pglite/dist/index.js to run
subscription-payments.integration.test.ts and learning-packs.integration.test.ts.
Tests use an isolated embedded PostgreSQL database and injected fake provider;
no real accounts or payment gateway requests are involved. Cases include phone
validation, HMAC body/replay integrity, price mismatch, retry identity, forged
callbacks, expiry extension, tenant isolation, duplicate settlement, late success,
printing allowance enforcement and release after failure.

Official contract checked 2026-10-20:
https://documentation.palmpesa.co.tz/ (API v2; legacy v1 search results are stale).
