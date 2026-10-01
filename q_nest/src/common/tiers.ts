// src/common/tiers.ts
//
// Single source of truth for plan-tier semantics. Gating code must use these
// helpers instead of comparing tier strings directly, so that adding or
// retiring a tier is a one-file change.
//
// Tier history:
//   FREE                      default state for any account without a paid plan
//   PRO / ELITE / ELITE_PLUS  legacy tiers (plans deactivated 2026-10, rows kept)
//   PREMIUM                   the single paid plan ($29.99/month, every feature)

export type TierName = 'FREE' | 'PRO' | 'ELITE' | 'ELITE_PLUS' | 'PREMIUM';

/** Higher rank = superset of features. PREMIUM outranks every legacy tier. */
export const TIER_RANK: Record<TierName, number> = {
  FREE: 0,
  PRO: 1,
  ELITE: 2,
  ELITE_PLUS: 3,
  PREMIUM: 4,
};

/** Human label for emails, notifications and admin output. */
export const TIER_LABEL: Record<TierName, string> = {
  FREE: 'Free',
  PRO: 'Pro',
  ELITE: 'Elite',
  ELITE_PLUS: 'Elite Plus',
  PREMIUM: 'Premium',
};

export type PremiumBillingPeriod = 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
export const PREMIUM_BILLING_PERIODS: PremiumBillingPeriod[] = ['MONTHLY', 'QUARTERLY', 'YEARLY'];

/** Fixed plan_ids of the PREMIUM rows (migrations 20261001100100 and 20261001120000). */
export const PREMIUM_PLAN_IDS: Record<PremiumBillingPeriod, string> = {
  MONTHLY: '5b0d1a4e-0000-4000-8000-000000000001',
  QUARTERLY: '5b0d1a4e-0000-4000-8000-000000000002',
  YEARLY: '5b0d1a4e-0000-4000-8000-000000000003',
};
/** @deprecated use PREMIUM_PLAN_IDS.MONTHLY */
export const PREMIUM_PLAN_ID = PREMIUM_PLAN_IDS.MONTHLY;

/** Premium prices in USD per billing period. Display fallback only; the DB rows are authoritative. */
export const PREMIUM_PRICES_USD: Record<PremiumBillingPeriod, number> = {
  MONTHLY: 29.99,
  QUARTERLY: 79.99,
  YEARLY: 299.99,
};
/** @deprecated use PREMIUM_PRICES_USD.MONTHLY */
export const PREMIUM_PRICE_USD = PREMIUM_PRICES_USD.MONTHLY;

export function isPremiumBillingPeriod(v: unknown): v is PremiumBillingPeriod {
  return typeof v === 'string' && (PREMIUM_BILLING_PERIODS as string[]).includes(v);
}

/** "$29.99/month", "$79.99 every 3 months", "$299.99/year" */
export function premiumPriceLabel(period?: string | null, price?: number | string | null): string {
  const p = isPremiumBillingPeriod(period) ? period : 'MONTHLY';
  const amount = price != null && !Number.isNaN(Number(price)) ? Number(price) : PREMIUM_PRICES_USD[p];
  const money = `$${amount.toFixed(2)}`;
  switch (p) {
    case 'QUARTERLY':
      return `${money} every 3 months`;
    case 'YEARLY':
      return `${money}/year`;
    default:
      return `${money}/month`;
  }
}

/** Tiers a super-admin may grant via the comp tool. Legacy tiers are disabled. */
export const ADMIN_GRANTABLE_TIERS: TierName[] = ['FREE', 'PREMIUM'];

export function rankOf(tier?: string | null): number {
  return TIER_RANK[(tier ?? 'FREE') as TierName] ?? 0;
}

export function isPaidTier(tier?: string | null): boolean {
  return rankOf(tier) > 0;
}

/**
 * True when `userTier` grants at least what `required` grants.
 * PREMIUM satisfies every requirement; ELITE_PLUS satisfies ELITE; etc.
 */
export function tierSatisfies(userTier: string | null | undefined, required: string): boolean {
  const need = TIER_RANK[required as TierName];
  if (need === undefined) return false;
  return rankOf(userTier) >= need;
}

export function tierLabel(tier?: string | null): string {
  return TIER_LABEL[(tier ?? 'FREE') as TierName] ?? String(tier);
}

/** QHQ reward rule key credited on each successful subscription payment, or null for none. */
export function subscriptionQhqRuleKey(tier?: string | null): string | null {
  switch (tier) {
    case 'PREMIUM':
      return 'MONTHLY_PREMIUM';
    case 'ELITE':
    case 'ELITE_PLUS':
      return 'MONTHLY_ELITE';
    case 'PRO':
      return 'MONTHLY_PRO';
    default:
      return null;
  }
}
