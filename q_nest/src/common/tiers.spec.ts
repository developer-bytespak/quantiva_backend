import {
  ADMIN_GRANTABLE_TIERS,
  isPaidTier,
  rankOf,
  subscriptionQhqRuleKey,
  tierLabel,
  tierSatisfies,
} from './tiers';

describe('tiers helper', () => {
  it('ranks PREMIUM above every legacy tier', () => {
    expect(rankOf('PREMIUM')).toBeGreaterThan(rankOf('ELITE_PLUS'));
    expect(rankOf('ELITE_PLUS')).toBeGreaterThan(rankOf('ELITE'));
    expect(rankOf('ELITE')).toBeGreaterThan(rankOf('PRO'));
    expect(rankOf('PRO')).toBeGreaterThan(rankOf('FREE'));
  });

  it('treats unknown or missing tiers as FREE', () => {
    expect(rankOf(undefined)).toBe(0);
    expect(rankOf(null)).toBe(0);
    expect(rankOf('GOLD')).toBe(0);
    expect(isPaidTier(null)).toBe(false);
    expect(isPaidTier('FREE')).toBe(false);
  });

  it('PREMIUM satisfies every existing @AllowTier requirement', () => {
    expect(tierSatisfies('PREMIUM', 'PRO')).toBe(true);
    expect(tierSatisfies('PREMIUM', 'ELITE')).toBe(true);
    expect(tierSatisfies('PREMIUM', 'ELITE_PLUS')).toBe(true);
  });

  it('keeps legacy superset semantics (ELITE_PLUS passes ELITE, PRO does not)', () => {
    expect(tierSatisfies('ELITE_PLUS', 'ELITE')).toBe(true);
    expect(tierSatisfies('ELITE', 'ELITE_PLUS')).toBe(false);
    expect(tierSatisfies('PRO', 'ELITE')).toBe(false);
    expect(tierSatisfies('FREE', 'PRO')).toBe(false);
  });

  it('rejects unknown requirements rather than letting everyone through', () => {
    expect(tierSatisfies('PREMIUM', 'NOT_A_TIER')).toBe(false);
  });

  it('only FREE and PREMIUM are admin-grantable', () => {
    expect(ADMIN_GRANTABLE_TIERS).toEqual(['FREE', 'PREMIUM']);
  });

  it('maps tiers to QHQ reward rules', () => {
    expect(subscriptionQhqRuleKey('PREMIUM')).toBe('MONTHLY_PREMIUM');
    expect(subscriptionQhqRuleKey('ELITE')).toBe('MONTHLY_ELITE');
    expect(subscriptionQhqRuleKey('ELITE_PLUS')).toBe('MONTHLY_ELITE');
    expect(subscriptionQhqRuleKey('PRO')).toBe('MONTHLY_PRO');
    expect(subscriptionQhqRuleKey('FREE')).toBeNull();
  });

  it('labels tiers for humans', () => {
    expect(tierLabel('PREMIUM')).toBe('Premium');
    expect(tierLabel('ELITE_PLUS')).toBe('Elite Plus');
    expect(tierLabel(null)).toBe('Free');
  });
});
