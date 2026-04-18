/**
 * Revenue-share rules for paid mini-apps.
 *
 * Splits applied at the moment of purchase. We snapshot the breakdown into
 * `mini_app_purchases` so a future config change can't retro-modify a row
 * (same approach as stationery_orders.total_tsh).
 *
 *   Developer:      70 %
 *   Platform/School: 30 %
 *
 * Developer-account subscription pricing (TSh/year, paid via M-Pesa to the
 * KobeAI control plane). A super-admin verifies the M-Pesa reference and
 * flips `developer_payments.status` to "verified", which activates the plan.
 */
export const DEV_SHARE_PERCENT = 70;
export const PLATFORM_SHARE_PERCENT = 100 - DEV_SHARE_PERCENT;

export const SUBSCRIPTION_PLANS = {
  indie: {
    code: "indie" as const,
    name: "Indie",
    price_tsh_per_year: 50_000,
    max_apps: 5,
    description: "Up to 5 published mini-apps. Perfect for solo creators.",
  },
  studio: {
    code: "studio" as const,
    name: "Studio",
    price_tsh_per_year: 200_000,
    max_apps: 999,
    description: "Unlimited apps + advanced analytics + priority review.",
  },
} as const;
export type SubscriptionPlanCode = keyof typeof SUBSCRIPTION_PLANS;

export function splitRevenue(price: number) {
  const dev = Math.floor((price * DEV_SHARE_PERCENT) / 100);
  return { dev_share: dev, platform_share: price - dev };
}
