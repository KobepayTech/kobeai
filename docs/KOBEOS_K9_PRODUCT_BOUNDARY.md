# KobeOS ↔ KobeAI K9 product boundary

Status: adopted • Updated: 2026-10-09

This is the authoritative ownership boundary for the school ecosystem.

## Product ownership

### KobeOS
KobeOS owns the commerce/store side of the ecosystem, including the functionality
formerly described as **Duka OS**.

KobeOS is responsible for:
- school merchant/shop operations
- product/catalog management
- inventory and pricing
- merchant checkout
- merchant/order workflows
- QR/NFC payment acceptance at school merchants
- merchant settlement and commerce reporting
- the local school-shop/POS experience

**Duka OS is not a separate product in KobeAI K9. It is KobeOS functionality.**

### KobeAI K9
KobeAI K9 owns the school intelligence and student experience, including the
functionality formerly described as **School OS + Student OS**.

K9 is responsible for:
- school, campus, class, teacher and student context
- student identity and profile
- attendance/presence and classroom intelligence
- learning profiles, assessments and exam analytics
- classroom AI, Teacher Lens and glasses integration
- parent portal and parent-facing mini-K9
- student learning experience
- the school-side presentation of a student's pocket-money balance
- policy/context needed to decide whether a school purchase is permitted

**School OS and Student OS are one K9 school/student system, not separate
deployments.**

## Pocket-money boundary

The student pocket-money system remains a Kobepay wallet capability and is
integrated with K9.

The canonical flow is:

```
Parent / school funding
        |
        v
Kobepay wallet + immutable ledger
        |
        +----> K9 student profile / limits / permissions
        |
        v
KobeOS merchant checkout
        |
        v
Kobepay transaction
        |
        +----> K9 student activity + parent notification
```

K9 must never maintain a second independent monetary ledger for the same
student balance. K9 may cache/display balance and policy data, but the
authoritative monetary state is the Kobepay wallet/ledger.

## Integration contract

KobeOS and K9 communicate using stable identifiers:

- `tenant_id`
- `school_id`
- `student_id`
- `student_code`
- `merchant_id`
- `order_id`
- `transaction_id`

A commerce event delivered to K9 should be idempotent on `transaction_id`.

Recommended event shape:

```json
{
  "event": "school.payment.completed",
  "transaction_id": "kp_tx_...",
  "school_id": "school_...",
  "student_id": "student_...",
  "student_code": "K9-001",
  "merchant_id": "merchant_...",
  "order_id": "order_...",
  "amount": 5000,
  "currency": "TZS",
  "occurred_at": "2026-10-09T00:00:00Z"
}
```

K9 can turn this into a student activity event and parent notification without
becoming the payment processor.

## What must not happen

- Do not recreate Duka OS inside K9.
- Do not create a second student-money ledger inside K9.
- Do not split School OS and Student OS into separate products again.
- Do not make K9 responsible for merchant inventory or merchant settlement.
- Do not make KobeOS responsible for learning mastery, attendance intelligence,
  exam analysis or the student AI profile.

## Deployment

KobeOS may run the local commerce/POS workloads on the school computer/server.
K9 may run its school intelligence workloads on the same machine or on another
LAN node. They use the integration contract above rather than duplicating data.

The architecture remains compatible with the existing local-first K9 deployment,
Ollama/model runtime and KobeOS desktop/server deployment.
