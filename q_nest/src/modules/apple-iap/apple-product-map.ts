import { PlanTier, BillingPeriod } from '.prisma/client';

/**
 * Maps Apple App Store Connect product identifiers to our internal
 * (tier, billing_period) pair. The pair resolves to a concrete
 * `subscription_plans` row via the table's @@unique([tier, billing_period]).
 *
 * These identifiers MUST match the product ids configured in App Store Connect
 * exactly. Any product id not present here is rejected (we never guess a tier).
 */
export interface AppleProductMapping {
  tier: PlanTier;
  billingPeriod: BillingPeriod;
}

export const APPLE_PRODUCT_MAP: Readonly<Record<string, AppleProductMapping>> = {
  quantiva_pro_monthly: { tier: PlanTier.PRO, billingPeriod: BillingPeriod.MONTHLY },
  quantiva_pro_quarterly: { tier: PlanTier.PRO, billingPeriod: BillingPeriod.QUARTERLY },
  quantiva_pro_yearly: { tier: PlanTier.PRO, billingPeriod: BillingPeriod.YEARLY },

  quantiva_elite_monthly: { tier: PlanTier.ELITE, billingPeriod: BillingPeriod.MONTHLY },
  quantiva_elite_quarterly: { tier: PlanTier.ELITE, billingPeriod: BillingPeriod.QUARTERLY },
  quantiva_elite_yearly: { tier: PlanTier.ELITE, billingPeriod: BillingPeriod.YEARLY },

  quantiva_elite_plus_monthly: { tier: PlanTier.ELITE_PLUS, billingPeriod: BillingPeriod.MONTHLY },
  quantiva_elite_plus_quarterly: { tier: PlanTier.ELITE_PLUS, billingPeriod: BillingPeriod.QUARTERLY },
  quantiva_elite_plus_yearly: { tier: PlanTier.ELITE_PLUS, billingPeriod: BillingPeriod.YEARLY },
};

/**
 * Resolve an Apple product id to its internal mapping, or null if unknown.
 */
export function mapAppleProductId(productId: string | undefined | null): AppleProductMapping | null {
  if (!productId) return null;
  return APPLE_PRODUCT_MAP[productId] ?? null;
}
