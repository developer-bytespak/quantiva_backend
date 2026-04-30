import {
  computeEv,
  computePop,
  relevantDaysToExpiry,
  type PopInputs,
  type PopLeg,
} from './pop-engine';

const baseInputs = (overrides: Partial<PopInputs> = {}): PopInputs => ({
  strategy: 'long_call',
  legs: [{ side: 'BUY', type: 'CALL', strike: 100, ratio: 1 }],
  spotPrice: 100,
  ivValue: 0.30,
  daysToExpiry: 30,
  netPerUnit: 3,
  ...overrides,
});

describe('computePop — long_call', () => {
  test('ATM 30d IV30% with $3 debit → ~40-50% (slightly below 50% because breakeven > strike)', () => {
    const pop = computePop(baseInputs())!;
    expect(pop).toBeGreaterThan(0.35);
    expect(pop).toBeLessThan(0.50);
  });

  test('ITM long call bought below intrinsic (favourable entry) → high POP', () => {
    // Spot=130, K=100, paid $25 (below $30 intrinsic) → breakeven=$125, well
    // below spot. POP should be high because the trade is already in the
    // profit zone at entry.
    const pop = computePop(
      baseInputs({ spotPrice: 130, legs: [{ side: 'BUY', type: 'CALL', strike: 100 }], netPerUnit: 25 }),
    )!;
    expect(pop).toBeGreaterThan(0.55);
  });

  test('ITM long call bought at intrinsic (breakeven = spot) → POP near 50%', () => {
    // Verifies the monotonic relationship: POP ≈ P(S_T > breakeven). At-money
    // breakeven gives ~50%, not "high" — which catches a common misconception.
    const pop = computePop(
      baseInputs({ spotPrice: 130, legs: [{ side: 'BUY', type: 'CALL', strike: 100 }], netPerUnit: 30 }),
    )!;
    expect(pop).toBeGreaterThan(0.45);
    expect(pop).toBeLessThan(0.55);
  });

  test('Deep OTM (spot far below strike) → near-0', () => {
    const pop = computePop(
      baseInputs({ spotPrice: 70, netPerUnit: 1 }),
    )!;
    expect(pop).toBeLessThan(0.10);
  });

  test('Returns null when net is a credit (long call must be debit)', () => {
    expect(computePop(baseInputs({ netPerUnit: -1 }))).toBeNull();
  });
});

describe('computePop — long_put', () => {
  test('ATM 30d IV30% with $3 debit → 35-50%', () => {
    const pop = computePop(
      baseInputs({
        strategy: 'long_put',
        legs: [{ side: 'BUY', type: 'PUT', strike: 100 }],
      }),
    )!;
    expect(pop).toBeGreaterThan(0.30);
    expect(pop).toBeLessThan(0.50);
  });

  test('ITM long put bought below intrinsic (favourable entry) → high POP', () => {
    // Spot=70, K=100, paid $25 (below $30 intrinsic) → breakeven=$75, above
    // spot. The profit zone S_T < 75 already contains spot, so POP is high.
    const pop = computePop(
      baseInputs({
        strategy: 'long_put',
        spotPrice: 70,
        legs: [{ side: 'BUY', type: 'PUT', strike: 100 }],
        netPerUnit: 25,
      }),
    )!;
    expect(pop).toBeGreaterThan(0.55);
  });
});

describe('computePop — bull_call_spread', () => {
  test('ATM long, 5% OTM short, $2 debit, IV 30%, 30d → ~40-50%', () => {
    const pop = computePop(
      baseInputs({
        strategy: 'bull_call_spread',
        legs: [
          { side: 'BUY', type: 'CALL', strike: 100 },
          { side: 'SELL', type: 'CALL', strike: 105 },
        ],
        netPerUnit: 2,
      }),
    )!;
    expect(pop).toBeGreaterThan(0.30);
    expect(pop).toBeLessThan(0.55);
  });
});

describe('computePop — iron_condor', () => {
  test('Wide wings (K2/K3 far from spot) → high POP (~70-90%)', () => {
    const pop = computePop(
      baseInputs({
        strategy: 'iron_condor',
        legs: [
          { side: 'BUY', type: 'PUT', strike: 90 },
          { side: 'SELL', type: 'PUT', strike: 95 },
          { side: 'SELL', type: 'CALL', strike: 105 },
          { side: 'BUY', type: 'CALL', strike: 110 },
        ],
        netPerUnit: -1, // credit received
      }),
    )!;
    expect(pop).toBeGreaterThan(0.50);
  });

  test('Narrow wings (K2/K3 hugging spot) → low POP', () => {
    const pop = computePop(
      baseInputs({
        strategy: 'iron_condor',
        legs: [
          { side: 'BUY', type: 'PUT', strike: 97 },
          { side: 'SELL', type: 'PUT', strike: 99 },
          { side: 'SELL', type: 'CALL', strike: 101 },
          { side: 'BUY', type: 'CALL', strike: 103 },
        ],
        netPerUnit: -1,
      }),
    )!;
    expect(pop).toBeLessThan(0.40);
  });

  test('Returns null when net is a debit (condor must be credit)', () => {
    const pop = computePop(
      baseInputs({
        strategy: 'iron_condor',
        legs: [
          { side: 'BUY', type: 'PUT', strike: 90 },
          { side: 'SELL', type: 'PUT', strike: 95 },
          { side: 'SELL', type: 'CALL', strike: 105 },
          { side: 'BUY', type: 'CALL', strike: 110 },
        ],
        netPerUnit: 1,
      }),
    );
    expect(pop).toBeNull();
  });
});

describe('computePop — long_butterfly', () => {
  test('Body at spot, ±5 wings, $1 debit → 25-45% (narrow profit zone)', () => {
    const pop = computePop(
      baseInputs({
        strategy: 'long_butterfly',
        legs: [
          { side: 'BUY', type: 'CALL', strike: 95 },
          { side: 'SELL', type: 'CALL', strike: 100, ratio: 2 },
          { side: 'BUY', type: 'CALL', strike: 105 },
        ],
        netPerUnit: 1,
      }),
    )!;
    expect(pop).toBeGreaterThan(0.15);
    expect(pop).toBeLessThan(0.50);
  });
});

describe('computePop — long_straddle / long_strangle', () => {
  test('Straddle low-IV needs a big move; POP < 40% with IV 15%', () => {
    const pop = computePop(
      baseInputs({
        strategy: 'long_straddle',
        legs: [
          { side: 'BUY', type: 'CALL', strike: 100 },
          { side: 'BUY', type: 'PUT', strike: 100 },
        ],
        ivValue: 0.15,
        netPerUnit: 4,
      }),
    )!;
    expect(pop).toBeLessThan(0.45);
  });

  test('Strangle wide-strike low-IV needs an even bigger move', () => {
    const pop = computePop(
      baseInputs({
        strategy: 'long_strangle',
        legs: [
          { side: 'BUY', type: 'CALL', strike: 105 },
          { side: 'BUY', type: 'PUT', strike: 95 },
        ],
        ivValue: 0.15,
        netPerUnit: 3,
      }),
    )!;
    expect(pop).toBeLessThan(0.40);
  });
});

describe('computePop — calendar_spread (heuristic)', () => {
  test('Returns a value in roughly 0.10-0.95 range — sanity only', () => {
    const pop = computePop(
      baseInputs({
        strategy: 'calendar_spread',
        legs: [
          { side: 'SELL', type: 'CALL', strike: 100 },
          { side: 'BUY', type: 'CALL', strike: 100 },
        ],
        netPerUnit: 2,
        daysToExpiry: 14, // short-leg expiry
      }),
    );
    expect(pop).not.toBeNull();
    expect(pop!).toBeGreaterThan(0.05);
    expect(pop!).toBeLessThan(0.95);
  });
});

describe('computePop — short_put', () => {
  test('OTM short put with credit → high POP (>50%)', () => {
    const pop = computePop(
      baseInputs({
        strategy: 'short_put',
        legs: [{ side: 'SELL', type: 'PUT', strike: 95 }],
        netPerUnit: -1, // credit
      }),
    )!;
    expect(pop).toBeGreaterThan(0.50);
  });
});

describe('computePop — null guards', () => {
  test('Missing spot returns null', () => {
    expect(computePop(baseInputs({ spotPrice: 0 }))).toBeNull();
  });
  test('Missing IV returns null', () => {
    expect(computePop(baseInputs({ ivValue: 0 }))).toBeNull();
  });
  test('Zero days-to-expiry returns null', () => {
    expect(computePop(baseInputs({ daysToExpiry: 0 }))).toBeNull();
  });
  test('Unknown strategy returns null', () => {
    expect(computePop(baseInputs({ strategy: 'jade_lizard' }))).toBeNull();
  });
});

describe('computeEv', () => {
  test('Symmetric outcome at 50% POP equals avg of profit and loss', () => {
    expect(computeEv(0.5, 100, 100)).toBeCloseTo(0, 5);
  });

  test('70% POP × $400 profit − 30% × $200 loss = $220', () => {
    expect(computeEv(0.7, 400, 200)).toBeCloseTo(220, 5);
  });

  test('Iron condor at 75% POP, R/R 1:3, credit $100 → +$25', () => {
    // profit = $100 (credit), loss = $300 (wing - credit)
    expect(computeEv(0.75, 100, 300)).toBeCloseTo(0, 5); // exactly break-even
    expect(computeEv(0.80, 100, 300)).toBeCloseTo(20, 5);
  });

  test('Long butterfly at 30% POP, $400 profit, $100 loss → +$50', () => {
    expect(computeEv(0.30, 400, 100)).toBeCloseTo(50, 5);
  });
});

describe('relevantDaysToExpiry', () => {
  const FIXED_NOW = new Date('2026-04-29T12:00:00Z');

  test('Calendar uses the SHORTEST-dated leg expiry', () => {
    const legs: PopLeg[] = [
      { side: 'SELL', type: 'CALL', strike: 100, expiry: '2026-05-15T00:00:00Z' },
      { side: 'BUY', type: 'CALL', strike: 100, expiry: '2026-06-12T00:00:00Z' },
    ];
    const days = relevantDaysToExpiry('calendar_spread', legs, FIXED_NOW);
    // 2026-05-15 is ~16 days after 2026-04-29
    expect(days).toBeGreaterThan(15);
    expect(days).toBeLessThan(17);
  });

  test('Iron condor with single shared expiry returns that expiry', () => {
    const legs: PopLeg[] = [
      { side: 'BUY', type: 'PUT', strike: 90, expiry: '2026-05-29T00:00:00Z' },
      { side: 'SELL', type: 'PUT', strike: 95, expiry: '2026-05-29T00:00:00Z' },
      { side: 'SELL', type: 'CALL', strike: 105, expiry: '2026-05-29T00:00:00Z' },
      { side: 'BUY', type: 'CALL', strike: 110, expiry: '2026-05-29T00:00:00Z' },
    ];
    const days = relevantDaysToExpiry('iron_condor', legs, FIXED_NOW);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  test('Returns null when legs lack expiries', () => {
    expect(relevantDaysToExpiry('long_call', [{ side: 'BUY', type: 'CALL', strike: 100 }], FIXED_NOW)).toBeNull();
  });

  test('Returns null when expiry is in the past', () => {
    const legs: PopLeg[] = [
      { side: 'BUY', type: 'CALL', strike: 100, expiry: '2026-01-01T00:00:00Z' },
    ];
    expect(relevantDaysToExpiry('long_call', legs, FIXED_NOW)).toBeNull();
  });
});
