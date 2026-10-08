/**
 * KobeOS ↔ KobeAI K9 integration boundary.
 *
 * KobeOS owns commerce (the former Duka OS).
 * KobeAI K9 owns the combined School OS + Student OS experience.
 *
 * Monetary truth remains in the Kobepay wallet/ledger. K9 only consumes
 * payment events and exposes school/student context and policy.
 */

export const KOBE_ECOSYSTEM_OWNERSHIP = {
  commerce: "kobeos",
  schoolStudentIntelligence: "kobeai-k9",
  walletLedger: "kobepay",
} as const;

export type SchoolPaymentCompletedEvent = {
  event: "school.payment.completed";
  transaction_id: string;
  tenant_id?: string;
  school_id: string;
  student_id: string;
  student_code: string;
  merchant_id: string;
  order_id: string;
  amount: number;
  currency: "TZS";
  occurred_at: string;
};

/**
 * K9-side projection of a Kobepay commerce event.
 * This is deliberately not a balance mutation: the Kobepay ledger is
 * authoritative for money.
 */
export type K9CommerceActivity = {
  transaction_id: string;
  student_id: string;
  student_code: string;
  merchant_id: string;
  order_id: string;
  amount: number;
  currency: "TZS";
  type: "school_purchase";
  occurred_at: string;
};

export function toK9CommerceActivity(
  event: SchoolPaymentCompletedEvent,
): K9CommerceActivity {
  return {
    transaction_id: event.transaction_id,
    student_id: event.student_id,
    student_code: event.student_code,
    merchant_id: event.merchant_id,
    order_id: event.order_id,
    amount: event.amount,
    currency: event.currency,
    type: "school_purchase",
    occurred_at: event.occurred_at,
  };
}
