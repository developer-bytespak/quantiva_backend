/**
 * Black-Scholes pricing, Greeks, and implied-volatility solver.
 *
 * Everything here is pure: no IO, no logger, no dependencies outside stdlib.
 * The engine is dispatched from `options-alpaca.service.ts` — but is kept
 * generic so it can also serve any other venue that doesn't surface greeks
 * on its data feed.
 *
 * Conventions:
 *   - All rates/yields are CONTINUOUS and ANNUAL (r, q).
 *   - Time to expiry `tte` is in YEARS (days ÷ 365).
 *   - IV σ is annualized (e.g. 0.35 = 35%).
 *   - `vega` is returned per 1% IV move (i.e. scaled by 1/100) — matches
 *     Bloomberg/Alpaca conventions so UI code doesn't have to think about it.
 *   - `theta` is returned per CALENDAR DAY (scaled by 1/365) — again matches
 *     what traders expect on a dashboard.
 *
 * All greeks follow the Merton (1973) extension with a continuous dividend
 * yield q, so they reduce to textbook BS when q = 0 and handle SPY/AAPL etc.
 * correctly when q > 0.
 */

export type OptionKind = 'CALL' | 'PUT';

export interface BsInputs {
  /** Underlying spot price. */
  spot: number;
  /** Strike price. */
  strike: number;
  /** Risk-free rate (continuous, annual). */
  rate: number;
  /** Continuous dividend yield, annual. */
  dividendYield: number;
  /** Time to expiry in years. */
  tte: number;
  /** Implied volatility (annualized). */
  iv: number;
  /** CALL or PUT. */
  type: OptionKind;
}

export interface Greeks {
  /** Per $1 move in spot. */
  delta: number;
  /** Per $1 move in spot (already the 2nd derivative). */
  gamma: number;
  /** Per calendar day. */
  theta: number;
  /** Per 1% (absolute) change in IV. */
  vega: number;
  /** The IV we priced off — echoed back for display/debugging. */
  iv: number;
}

// ── Normal distribution helpers ────────────────────────────────────────────

/**
 * Standard normal PDF. Exact; used for gamma/vega/theta.
 */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF via Abramowitz & Stegun 26.2.17. Accurate to ~7.5e-8
 * on the entire real line, which is more than enough for options pricing
 * (market prices are quoted to 4 decimals at best).
 */
export function normCdf(x: number): number {
  // Constants from A&S 26.2.17
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

// ── Pricing ────────────────────────────────────────────────────────────────

/**
 * Compute d1 from BS inputs. Thrown out into its own function because
 * price + every greek share this term.
 */
function d1(p: BsInputs): number {
  return (
    (Math.log(p.spot / p.strike) + (p.rate - p.dividendYield + 0.5 * p.iv * p.iv) * p.tte) /
    (p.iv * Math.sqrt(p.tte))
  );
}

/**
 * Black-Scholes-Merton theoretical price.
 */
export function bsPrice(p: BsInputs): number {
  if (p.tte <= 0 || p.iv <= 0) {
    // Degenerate: at expiry the value is just intrinsic.
    return intrinsic(p);
  }
  const sqrtT = Math.sqrt(p.tte);
  const d1_ = d1(p);
  const d2_ = d1_ - p.iv * sqrtT;
  const eQT = Math.exp(-p.dividendYield * p.tte);
  const eRT = Math.exp(-p.rate * p.tte);
  if (p.type === 'CALL') {
    return p.spot * eQT * normCdf(d1_) - p.strike * eRT * normCdf(d2_);
  }
  return p.strike * eRT * normCdf(-d2_) - p.spot * eQT * normCdf(-d1_);
}

/**
 * Undiscounted intrinsic value — used as a no-arb floor when checking
 * whether the market mid is sensible.
 */
export function intrinsic(p: Pick<BsInputs, 'spot' | 'strike' | 'type'>): number {
  return p.type === 'CALL' ? Math.max(0, p.spot - p.strike) : Math.max(0, p.strike - p.spot);
}

// ── Greeks ─────────────────────────────────────────────────────────────────

/**
 * Black-Scholes-Merton greeks for a given IV. Values are scaled for
 * dashboard display (vega per 1%, theta per day).
 */
export function bsGreeks(p: BsInputs): Greeks {
  // Guard degenerate inputs — return neutrals rather than NaN so the caller
  // can decide how to render. All downstream callers check iv > 0 before
  // trusting the numbers anyway.
  if (p.tte <= 0 || p.iv <= 0 || p.spot <= 0 || p.strike <= 0) {
    return { delta: 0, gamma: 0, theta: 0, vega: 0, iv: p.iv };
  }

  const sqrtT = Math.sqrt(p.tte);
  const d1_ = d1(p);
  const d2_ = d1_ - p.iv * sqrtT;
  const eQT = Math.exp(-p.dividendYield * p.tte);
  const eRT = Math.exp(-p.rate * p.tte);
  const nD1 = normPdf(d1_);

  const delta =
    p.type === 'CALL'
      ? eQT * normCdf(d1_)
      : eQT * (normCdf(d1_) - 1);

  const gamma = (eQT * nD1) / (p.spot * p.iv * sqrtT);

  // Vega is identical for calls and puts.
  const vegaRaw = p.spot * eQT * nD1 * sqrtT;
  const vega = vegaRaw / 100; // per 1% IV move

  let thetaRaw: number;
  if (p.type === 'CALL') {
    thetaRaw =
      -(p.spot * eQT * nD1 * p.iv) / (2 * sqrtT) -
      p.rate * p.strike * eRT * normCdf(d2_) +
      p.dividendYield * p.spot * eQT * normCdf(d1_);
  } else {
    thetaRaw =
      -(p.spot * eQT * nD1 * p.iv) / (2 * sqrtT) +
      p.rate * p.strike * eRT * normCdf(-d2_) -
      p.dividendYield * p.spot * eQT * normCdf(-d1_);
  }
  const theta = thetaRaw / 365; // per calendar day

  return { delta, gamma, theta, vega, iv: p.iv };
}

// ── Implied-volatility solver ──────────────────────────────────────────────

const IV_LOWER = 1e-4;
const IV_UPPER = 5; // 500% — beyond this, numerical stability suffers
const IV_INITIAL_GUESS = 0.3;
const NEWTON_MAX_ITERS = 20;
const NEWTON_TOL = 1e-6; // price tolerance
const BISECTION_MAX_ITERS = 80;
const BISECTION_TOL = 1e-5;
const VEGA_FLOOR = 1e-6; // below this, Newton step blows up

/**
 * Input to the IV solver — same as BsInputs minus iv.
 */
export type IvSolverInputs = Omit<BsInputs, 'iv'>;

/**
 * Check whether `marketPrice` lies inside the no-arbitrage bounds for an
 * option with these parameters. Outside the bounds, no σ can reproduce the
 * price, so we skip straight to a failure return from the solver.
 */
export function isMarketPriceInBounds(marketPrice: number, p: IvSolverInputs): boolean {
  if (!Number.isFinite(marketPrice) || marketPrice < 0) return false;
  const eQT = Math.exp(-p.dividendYield * p.tte);
  const eRT = Math.exp(-p.rate * p.tte);
  // Lower bound: discounted intrinsic.
  const lower =
    p.type === 'CALL'
      ? Math.max(0, p.spot * eQT - p.strike * eRT)
      : Math.max(0, p.strike * eRT - p.spot * eQT);
  // Upper bound: for a call it's the discounted spot; for a put it's the
  // discounted strike.
  const upper = p.type === 'CALL' ? p.spot * eQT : p.strike * eRT;
  const slack = 1e-4;
  return marketPrice >= lower - slack && marketPrice <= upper + slack;
}

/**
 * Solve for implied volatility via Newton-Raphson, with a Brent-style
 * bisection fallback when Newton's step blows up or lands outside [1e-4, 5].
 * Returns null if no σ can reproduce the market price within tolerance
 * (usually means the mid is outside no-arb bounds).
 */
export function solveImpliedVolatility(
  marketPrice: number,
  p: IvSolverInputs,
): number | null {
  if (!isMarketPriceInBounds(marketPrice, p)) return null;
  if (p.tte <= 0 || p.spot <= 0 || p.strike <= 0) return null;

  // 1. Newton-Raphson from σ = 0.3 seed.
  let iv = IV_INITIAL_GUESS;
  for (let i = 0; i < NEWTON_MAX_ITERS; i++) {
    const price = bsPrice({ ...p, iv });
    const diff = price - marketPrice;
    if (Math.abs(diff) < NEWTON_TOL) return iv;

    // Vega = ∂price/∂σ (undiscounted-per-IV, NOT the 1% scaled display value)
    const sqrtT = Math.sqrt(p.tte);
    const d1_ =
      (Math.log(p.spot / p.strike) + (p.rate - p.dividendYield + 0.5 * iv * iv) * p.tte) /
      (iv * sqrtT);
    const vegaRaw = p.spot * Math.exp(-p.dividendYield * p.tte) * normPdf(d1_) * sqrtT;

    if (vegaRaw < VEGA_FLOOR) break; // deep ITM/OTM — Newton unstable, switch to bisection
    const next = iv - diff / vegaRaw;
    if (!Number.isFinite(next) || next <= IV_LOWER || next >= IV_UPPER) break;
    iv = next;
  }

  // 2. Bisection fallback on [IV_LOWER, IV_UPPER].
  let lo = IV_LOWER;
  let hi = IV_UPPER;
  const priceAtLo = bsPrice({ ...p, iv: lo });
  const priceAtHi = bsPrice({ ...p, iv: hi });
  // If the target is outside the [priceAtLo, priceAtHi] interval, no σ works.
  if (marketPrice < priceAtLo - BISECTION_TOL || marketPrice > priceAtHi + BISECTION_TOL) {
    return null;
  }

  for (let i = 0; i < BISECTION_MAX_ITERS; i++) {
    const mid = (lo + hi) / 2;
    const priceAtMid = bsPrice({ ...p, iv: mid });
    const diff = priceAtMid - marketPrice;
    if (Math.abs(diff) < BISECTION_TOL) return mid;
    if (hi - lo < BISECTION_TOL) return mid;
    if (priceAtMid < marketPrice) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── End-to-end: market price → greeks ──────────────────────────────────────

export interface ComputeGreeksFromMarketInputs extends IvSolverInputs {
  /** Observed mid (or any reference price) to back out IV from. */
  marketPrice: number;
}

/**
 * Convenience wrapper: solve IV from the market price, then evaluate greeks.
 * Returns all-zero greeks with iv=0 when IV can't be solved — caller decides
 * whether to display or suppress.
 */
export function computeGreeksFromMarket(
  input: ComputeGreeksFromMarketInputs,
): Greeks {
  const iv = solveImpliedVolatility(input.marketPrice, input);
  if (iv == null) return { delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0 };
  return bsGreeks({ ...input, iv });
}
