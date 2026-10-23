# Kobepay: school and beyond

Interactive prototype: `artifacts/parent-app/public/kobepay-design.html`. Open directly in a browser or from the parent dashboard. Self-contained; no external assets, APIs, analytics, credentials or real payments. Fictional identities and merchant examples. State is held in memory and resets on reload.

## Screens

1. Family overview: student balances, activity, learning services.
2. Students and cards: school affiliation, freeze/unfreeze simulation.
3. PalmPesa funding: separate pocket money, subscription and printing purposes; no simulated successful funding.
4. Approved network: campus and external branch directory, approval status.
5. Parent controls: total daily allowance, external sub-limit, permitted categories.
6. Learning and print: separate subscription and printing fees, A4 duplex summary, class colours, collection location, longer-summary price preview.
7. Activity: filter by school, external merchant, learning or funding.
8. AI assistant: explicitly illustrative, deterministic explanations citing demo inputs.
9. School hub: student support, linked merchant branches and review queue.
10. Merchant checkout: test approval, permissions, card status, category, balance and limits; record demo receipt.

## Product boundary

Schools are hubs for identity, support, school services and participating networks. Students use their existing Kobepay wallet at school and authorized external chain branches. Each branch needs individual approval; chain membership alone does not authorize purchases. Parent external-spending permission and limits apply alongside school/network eligibility. No new parallel spendable wallet.

## Required real implementation

This prototype does not implement production authentication, role authorization, merchant onboarding, card issuance, NFC/QR cryptography, financial ledger, settlement, refunds, or model inference. The parent, school and merchant workspaces are navigable design views, not authenticated roles.

Implement in the actual Kobepay repository after access is restored. Server authorization must derive merchant branch and parent/student relationships from authenticated records, not client input. Check active school-linked identity and card, approved branch/network, parent policy, permitted categories, available funds, total daily spending and external daily spending. Apply debit and limit accounting atomically with an idempotency key, create balanced ledger entries, and persist an immutable receipt. Reversals should link original entries. Daily accounting uses Africa/Dar_es_Salaam. Merchant settlement is separate from student purchase authorization.

PalmPesa confirmed events must reconcile against authenticated provider status before funding; the K9 integration does not yet credit the real Kobepay wallet. Subscription entitlements and print reservations remain distinct from pocket-money spending. AI explanations must cite authorized records and cannot independently move money or approve branches.
