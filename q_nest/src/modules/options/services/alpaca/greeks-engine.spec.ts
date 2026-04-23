import {
  bsGreeks,
  bsPrice,
  computeGreeksFromMarket,
  intrinsic,
  isMarketPriceInBounds,
  normCdf,
  normPdf,
  solveImpliedVolatility,
  type BsInputs,
  type IvSolverInputs,
} from './greeks-engine';

const closeTo = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) < tol;

describe('normCdf / normPdf', () => {
  // Exact values at canonical points.
  test.each([
    [-3, 0.001350],
    [-1, 0.158655],
    [0, 0.5],
    [0.5, 0.691462],
    [1, 0.841345],
    [1.96, 0.975002],
    [3, 0.998650],
  ])('normCdf(%f) ≈ %f', (x, expected) => {
    expect(normCdf(x)).toBeCloseTo(expected, 4);
  });

  test.each([
    [-2, 0.053991],
    [-1, 0.241971],
    [0, 0.398942],
    [1, 0.241971],
    [2, 0.053991],
  ])('normPdf(%f) ≈ %f', (x, expected) => {
    expect(normPdf(x)).toBeCloseTo(expected, 6);
  });

  test('normCdf is symmetric around 0', () => {
    for (const x of [0.1, 0.5, 1.0, 2.0, 3.5]) {
      expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 6);
    }
  });

  test('normCdf is monotonically increasing', () => {
    let prev = 0;
    for (let x = -5; x <= 5; x += 0.5) {
      const v = normCdf(x);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('bsPrice — Hull textbook reference values', () => {
  // Hull "Options, Futures & Other Derivatives" Ch.15 worked example.
  // S=42, K=40, r=0.10, q=0, σ=0.2, T=0.5  →  C = 4.759, P = 0.810
  test('Hull Ch.15 worked example (CALL)', () => {
    const price = bsPrice({
      spot: 42,
      strike: 40,
      rate: 0.1,
      dividendYield: 0,
      tte: 0.5,
      iv: 0.2,
      type: 'CALL',
    });
    expect(price).toBeCloseTo(4.759, 2);
  });

  test('Hull Ch.15 worked example (PUT)', () => {
    const price = bsPrice({
      spot: 42,
      strike: 40,
      rate: 0.1,
      dividendYield: 0,
      tte: 0.5,
      iv: 0.2,
      type: 'PUT',
    });
    expect(price).toBeCloseTo(0.810, 2);
  });

  // ATM, 1-year, σ=20% — algebraically clean benchmark for regressions.
  // S=K=100, r=5%, q=0, σ=20%, T=1  →  C ≈ 10.45, P ≈ 5.57
  test('ATM 1-year σ=20% CALL', () => {
    const price = bsPrice({
      spot: 100, strike: 100, rate: 0.05, dividendYield: 0, tte: 1, iv: 0.2, type: 'CALL',
    });
    expect(price).toBeCloseTo(10.45, 1);
  });

  test('ATM 1-year σ=20% PUT', () => {
    const price = bsPrice({
      spot: 100, strike: 100, rate: 0.05, dividendYield: 0, tte: 1, iv: 0.2, type: 'PUT',
    });
    expect(price).toBeCloseTo(5.57, 1);
  });

  test('At expiry price collapses to intrinsic', () => {
    const p: BsInputs = {
      spot: 110, strike: 100, rate: 0.05, dividendYield: 0, tte: 0, iv: 0.2, type: 'CALL',
    };
    expect(bsPrice(p)).toBe(10);
    expect(bsPrice({ ...p, type: 'PUT', spot: 90 })).toBe(10);
  });

  test('Zero IV prices to intrinsic', () => {
    const p: BsInputs = {
      spot: 105, strike: 100, rate: 0.05, dividendYield: 0, tte: 0.5, iv: 0, type: 'CALL',
    };
    expect(bsPrice(p)).toBe(5);
  });
});

describe('Put-call parity', () => {
  // C - P = S*e^(-qT) - K*e^(-rT). Must hold exactly for any σ, T, r, q.
  test.each([
    { S: 100, K: 100, r: 0.05, q: 0, T: 1, iv: 0.2 },
    { S: 100, K: 90,  r: 0.05, q: 0, T: 0.25, iv: 0.35 },
    { S: 50,  K: 55,  r: 0.045, q: 0.02, T: 0.5, iv: 0.4 },
    { S: 200, K: 180, r: 0.04, q: 0.015, T: 2, iv: 0.15 },
  ])('C - P = S*e^(-qT) - K*e^(-rT)  [S=$S K=$K r=$r q=$q T=$T]', (tc: any) => {
    const common = { spot: tc.S, strike: tc.K, rate: tc.r, dividendYield: tc.q, tte: tc.T, iv: tc.iv };
    const c = bsPrice({ ...common, type: 'CALL' });
    const p = bsPrice({ ...common, type: 'PUT' });
    const rhs = tc.S * Math.exp(-tc.q * tc.T) - tc.K * Math.exp(-tc.r * tc.T);
    expect(c - p).toBeCloseTo(rhs, 6);
  });
});

describe('bsGreeks — ATM 1-year σ=20% reference values', () => {
  const base = {
    spot: 100, strike: 100, rate: 0.05, dividendYield: 0, tte: 1, iv: 0.2,
  };

  test('CALL greeks match hand-computed values', () => {
    // d1=0.35, d2=0.15
    // N(d1)=0.6368, φ(d1)=0.3752, e^-rT=0.9512
    // Δ = e^-qT * N(d1) = 0.6368
    // Γ = e^-qT * φ(d1) / (S*σ*√T) = 0.3752/20 = 0.01876
    // ν (per 1%) = S*e^-qT*φ(d1)*√T / 100 = 100*0.3752/100 = 0.3752
    // Θ (per day) = (-S*e^-qT*φ(d1)*σ/(2√T) - r*K*e^-rT*N(d2)) / 365
    //             = (-3.752 - 2.661) / 365 ≈ -0.01757
    const g = bsGreeks({ ...base, type: 'CALL' });
    expect(g.delta).toBeCloseTo(0.6368, 3);
    expect(g.gamma).toBeCloseTo(0.01876, 4);
    expect(g.vega).toBeCloseTo(0.3752, 3);
    expect(g.theta).toBeCloseTo(-0.01757, 3);
  });

  test('PUT greeks match hand-computed values', () => {
    // Δp = e^-qT * (N(d1) - 1) = -0.3632
    // Γ, ν identical to call
    // Θp = Θc + r*K*e^-rT - q*S*e^-qT  (via parity)
    const g = bsGreeks({ ...base, type: 'PUT' });
    expect(g.delta).toBeCloseTo(-0.3632, 3);
    expect(g.gamma).toBeCloseTo(0.01876, 4);
    expect(g.vega).toBeCloseTo(0.3752, 3);
    // Put theta should be less negative than call theta for this config.
    expect(g.theta).toBeGreaterThan(-0.02);
    expect(g.theta).toBeLessThan(0);
  });
});

describe('Put-call parity in greek space', () => {
  // Δc - Δp = e^(-qT) for all sensible inputs.
  test.each([
    { S: 100, K: 100, r: 0.05, q: 0,    T: 1 },
    { S: 100, K: 90,  r: 0.05, q: 0.02, T: 0.25 },
    { S: 50,  K: 55,  r: 0.045, q: 0.02, T: 0.5 },
  ])('Δc - Δp = e^(-qT)', (tc: any) => {
    const common = {
      spot: tc.S, strike: tc.K, rate: tc.r, dividendYield: tc.q, tte: tc.T, iv: 0.25,
    };
    const dc = bsGreeks({ ...common, type: 'CALL' }).delta;
    const dp = bsGreeks({ ...common, type: 'PUT' }).delta;
    expect(dc - dp).toBeCloseTo(Math.exp(-tc.q * tc.T), 6);
  });

  // Gamma, vega identical for call and put.
  test('Γc = Γp  and  νc = νp', () => {
    const common: BsInputs = {
      spot: 100, strike: 95, rate: 0.05, dividendYield: 0.01, tte: 0.4, iv: 0.22, type: 'CALL',
    };
    const c = bsGreeks(common);
    const p = bsGreeks({ ...common, type: 'PUT' });
    expect(c.gamma).toBeCloseTo(p.gamma, 8);
    expect(c.vega).toBeCloseTo(p.vega, 8);
  });
});

describe('bsGreeks — edge cases', () => {
  const atm: BsInputs = {
    spot: 100, strike: 100, rate: 0.05, dividendYield: 0, tte: 0.25, iv: 0.3, type: 'CALL',
  };

  test('degenerate inputs return neutral greeks (no NaN)', () => {
    for (const p of [
      { ...atm, tte: 0 },
      { ...atm, tte: -0.01 },
      { ...atm, iv: 0 },
      { ...atm, iv: -0.1 },
      { ...atm, spot: 0 },
      { ...atm, strike: 0 },
    ]) {
      const g = bsGreeks(p);
      expect(Number.isFinite(g.delta)).toBe(true);
      expect(Number.isFinite(g.gamma)).toBe(true);
      expect(Number.isFinite(g.theta)).toBe(true);
      expect(Number.isFinite(g.vega)).toBe(true);
    }
  });

  test('deep ITM call has delta → 1', () => {
    const g = bsGreeks({ ...atm, spot: 200 }); // way ITM
    expect(g.delta).toBeGreaterThan(0.99);
    expect(g.delta).toBeLessThanOrEqual(1);
  });

  test('deep OTM call has delta → 0', () => {
    const g = bsGreeks({ ...atm, spot: 50 }); // way OTM
    expect(g.delta).toBeGreaterThanOrEqual(0);
    expect(g.delta).toBeLessThan(0.01);
  });

  test('deep ITM put has delta → -1', () => {
    const g = bsGreeks({ ...atm, spot: 50, type: 'PUT' });
    expect(g.delta).toBeLessThan(-0.99);
    expect(g.delta).toBeGreaterThanOrEqual(-1);
  });

  test('delta of call is always in [0, 1]', () => {
    for (const spot of [50, 75, 100, 125, 150, 200]) {
      const { delta } = bsGreeks({ ...atm, spot });
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThanOrEqual(1);
    }
  });

  test('delta of put is always in [-1, 0]', () => {
    for (const spot of [50, 75, 100, 125, 150, 200]) {
      const { delta } = bsGreeks({ ...atm, spot, type: 'PUT' });
      expect(delta).toBeLessThanOrEqual(0);
      expect(delta).toBeGreaterThanOrEqual(-1);
    }
  });

  test('gamma peaks near the money and decays on either side', () => {
    const gatm = bsGreeks({ ...atm, spot: 100 }).gamma;
    const gdeep = bsGreeks({ ...atm, spot: 50 }).gamma;
    const gup = bsGreeks({ ...atm, spot: 150 }).gamma;
    expect(gatm).toBeGreaterThan(gdeep);
    expect(gatm).toBeGreaterThan(gup);
  });
});

describe('solveImpliedVolatility — round-trip', () => {
  // For any reasonable input, solving price → IV → price must recover IV.
  const reasonable: Array<Omit<BsInputs, 'iv'>> = [
    { spot: 100, strike: 100, rate: 0.05, dividendYield: 0,    tte: 1,    type: 'CALL' },
    { spot: 100, strike: 110, rate: 0.05, dividendYield: 0.01, tte: 0.5,  type: 'CALL' },
    { spot: 100, strike: 90,  rate: 0.05, dividendYield: 0.01, tte: 0.25, type: 'PUT'  },
    { spot: 50,  strike: 55,  rate: 0.045, dividendYield: 0,   tte: 0.08, type: 'CALL' },
    { spot: 200, strike: 180, rate: 0.04, dividendYield: 0.015, tte: 2,   type: 'PUT'  },
  ];

  for (const p of reasonable) {
    for (const ivTrue of [0.10, 0.20, 0.35, 0.60, 1.00]) {
      test(`recover σ=${ivTrue}  (K=${p.strike}, T=${p.tte}, ${p.type})`, () => {
        const price = bsPrice({ ...p, iv: ivTrue });
        const ivSolved = solveImpliedVolatility(price, p);
        expect(ivSolved).not.toBeNull();
        expect(ivSolved!).toBeCloseTo(ivTrue, 4);
      });
    }
  }
});

describe('solveImpliedVolatility — arbitrage & numerical edges', () => {
  const base: IvSolverInputs = {
    spot: 100, strike: 100, rate: 0.05, dividendYield: 0, tte: 0.5, type: 'CALL',
  };

  test('price below discounted intrinsic returns null', () => {
    // Deep ITM call (S=200, K=100): discounted intrinsic ≈ 200 - 100*e^(-0.025) = 102.47
    // So a mid of 50 is below no-arb floor.
    const p: IvSolverInputs = { ...base, spot: 200 };
    expect(solveImpliedVolatility(50, p)).toBeNull();
  });

  test('price above spot (for a call) returns null', () => {
    // Call price can't exceed S*e^(-qT). Ask for price 150 on S=100 call.
    expect(solveImpliedVolatility(150, base)).toBeNull();
  });

  test('negative price returns null', () => {
    expect(solveImpliedVolatility(-1, base)).toBeNull();
  });

  test('NaN price returns null', () => {
    expect(solveImpliedVolatility(NaN, base)).toBeNull();
  });

  test('tte <= 0 returns null', () => {
    expect(solveImpliedVolatility(5, { ...base, tte: 0 })).toBeNull();
    expect(solveImpliedVolatility(5, { ...base, tte: -1 })).toBeNull();
  });

  test('deep ITM with tight intrinsic-like mid falls back to bisection successfully', () => {
    // S=150, K=100, T=1, r=0.05: discounted intrinsic ≈ 150 - 95.12 = 54.88
    // A real call at σ=0.25 prices to ~55.5 → very low vega → Newton may stall.
    const p: IvSolverInputs = { ...base, spot: 150, strike: 100, tte: 1 };
    const truePrice = bsPrice({ ...p, iv: 0.25 });
    const iv = solveImpliedVolatility(truePrice, p);
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(0.25, 3);
  });

  test('very short DTE (0.5 days) still recovers reasonable IV', () => {
    const p: IvSolverInputs = { ...base, tte: 0.5 / 365 };
    const truePrice = bsPrice({ ...p, iv: 0.4 });
    const iv = solveImpliedVolatility(truePrice, p);
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(0.4, 3);
  });

  test('large IV (σ=2 = 200%) still round-trips', () => {
    const p: IvSolverInputs = { ...base, tte: 0.25 };
    const truePrice = bsPrice({ ...p, iv: 2 });
    const iv = solveImpliedVolatility(truePrice, p);
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(2, 3);
  });
});

describe('isMarketPriceInBounds', () => {
  const p: IvSolverInputs = {
    spot: 100, strike: 100, rate: 0.05, dividendYield: 0, tte: 1, type: 'CALL',
  };

  test('discounted intrinsic is within bounds', () => {
    // Call lower bound = S*e^-qT - K*e^-rT = 100 - 95.12 = 4.88
    expect(isMarketPriceInBounds(5, p)).toBe(true);
  });

  test('below discounted intrinsic is out of bounds', () => {
    expect(isMarketPriceInBounds(1, { ...p, spot: 200 })).toBe(false);
  });

  test('above S*e^-qT is out of bounds for call', () => {
    expect(isMarketPriceInBounds(101, p)).toBe(false);
  });

  test('negative and NaN are out of bounds', () => {
    expect(isMarketPriceInBounds(-1, p)).toBe(false);
    expect(isMarketPriceInBounds(NaN, p)).toBe(false);
  });
});

describe('intrinsic', () => {
  test('call intrinsic', () => {
    expect(intrinsic({ spot: 110, strike: 100, type: 'CALL' })).toBe(10);
    expect(intrinsic({ spot: 90,  strike: 100, type: 'CALL' })).toBe(0);
  });

  test('put intrinsic', () => {
    expect(intrinsic({ spot: 90,  strike: 100, type: 'PUT' })).toBe(10);
    expect(intrinsic({ spot: 110, strike: 100, type: 'PUT' })).toBe(0);
  });
});

describe('computeGreeksFromMarket — end-to-end', () => {
  test('returns usable greeks for a typical near-ATM call', () => {
    const g = computeGreeksFromMarket({
      spot: 450,        // SPY-like
      strike: 455,
      rate: 0.045,
      dividendYield: 0.013,
      tte: 30 / 365,    // ~1 month
      type: 'CALL',
      marketPrice: 4.50, // reasonable near-ATM short-dated premium
    });
    expect(g.iv).toBeGreaterThan(0);
    expect(g.iv).toBeLessThan(2);   // sanity: not blown up
    expect(g.delta).toBeGreaterThan(0);
    expect(g.delta).toBeLessThan(1);
    expect(g.gamma).toBeGreaterThan(0);
    expect(g.vega).toBeGreaterThan(0);
    expect(g.theta).toBeLessThan(0); // long option loses value each day
  });

  test('put greeks have negative delta', () => {
    const g = computeGreeksFromMarket({
      spot: 200, strike: 200, rate: 0.045, dividendYield: 0,
      tte: 60 / 365, type: 'PUT', marketPrice: 5,
    });
    expect(g.delta).toBeLessThan(0);
    expect(g.delta).toBeGreaterThan(-1);
  });

  test('unsolvable IV returns all-zero greeks (no throw)', () => {
    const g = computeGreeksFromMarket({
      spot: 100, strike: 100, rate: 0.05, dividendYield: 0,
      tte: 1, type: 'CALL', marketPrice: 200, // impossibly high
    });
    expect(g).toEqual({ delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 });
  });

  test('zero/invalid market price returns all-zero greeks', () => {
    const base = {
      spot: 100, strike: 100, rate: 0.05, dividendYield: 0,
      tte: 0.5, type: 'CALL' as const,
    };
    expect(computeGreeksFromMarket({ ...base, marketPrice: 0 })).toEqual(
      { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 },
    );
    expect(computeGreeksFromMarket({ ...base, marketPrice: NaN })).toEqual(
      { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 },
    );
  });
});
