/**
 * Probability-of-Profit (POP) and Expected-Value (EV) calculations for the
 * AI options signals.
 *
 * Why this exists
 * ───────────────
 * The signal cards previously surfaced only `confidence` (strategy-fit) and
 * `risk_reward` (a ratio). That's enough to know "is this strategy
 * appropriate for current conditions" but says nothing about "will this
 * trade actually make money". A user can't tell that a 1:3 R/R Iron Condor
 * is +EV (because POP ~75%) or that a 2:1 R/R Long Strangle is −EV (because
 * POP ~30%). POP supplies the missing input.
 *
 * Design choices
 * ──────────────
 * • Pure functions, no I/O. Math runs in microseconds; called on every
 *   `getActiveSignals` and `previewMultiLegOrder` request without caching.
 * • Lognormal price-at-expiry model with r=0 (no drift assumption). The
 *   industry standard for sub-90-DTE retail option POP estimates.
 * • Reuses `normCdf` from greeks-engine.ts — battle-tested A&S 26.2.17,
 *   ~7.5e-8 accuracy.
 * • Returns null when any input is missing rather than guessing — the
 *   frontend hides POP/EV cleanly when null, instead of displaying an
 *   incorrect default.
 */
import { normCdf } from './greeks-engine';

export type StrategyName =
  | 'long_call'
  | 'long_put'
  | 'bull_call_spread'
  | 'bear_put_spread'
  | 'iron_condor'
  | 'long_butterfly'
  | 'long_straddle'
  | 'long_strangle'
  | 'calendar_spread'
  | 'short_put';

export interface PopLeg {
  side: 'BUY' | 'SELL';
  type: 'CALL' | 'PUT';
  strike: number;
  // ISO-string from the signal `legs[].expiry` field. Calendar uses the
  // shortest-dated leg; everything else has uniform leg expiries.
  expiry?: string;
  ratio?: number;
}

export interface PopInputs {
  strategy: string;
  legs: PopLeg[];
  spotPrice: number;
  ivValue: number;
  // Days to the relevant expiry. Computed by the caller because the choice
  // of "relevant" leg is strategy-dependent (calendars use the SHORT leg).
  daysToExpiry: number;
  // Signed: positive = net debit paid, negative = net credit received.
  // Per share, not per contract.
  netPerUnit: number;
}

const DAYS_PER_YEAR = 365;

/**
 * Probability that the price at expiry exceeds the strike, under a
 * lognormal model with zero drift. Higher strike → lower probability.
 * Returns 0 / 1 at the limits to avoid the caller worrying about edge
 * cases.
 */
function probAbove(spot: number, strike: number, sigma: number, T: number): number {
  if (T <= 0 || sigma <= 0 || spot <= 0 || strike <= 0) {
    // Degenerate inputs — caller should guard, but be defensive.
    return spot > strike ? 1 : 0;
  }
  const sigmaT = sigma * Math.sqrt(T);
  // Drift-free approximation: the +0.5σ²T term comes from converting the
  // log-normal mean. Standard d2-style construction.
  const d = (Math.log(spot / strike) + 0.5 * sigmaT * sigmaT) / sigmaT;
  return normCdf(d);
}

/** P(low < S_T < high) under the same lognormal model. */
function probBetween(
  spot: number,
  low: number,
  high: number,
  sigma: number,
  T: number,
): number {
  if (high <= low) return 0;
  return probAbove(spot, low, sigma, T) - probAbove(spot, high, sigma, T);
}

/**
 * Compute Probability-of-Profit for a strategy at expiry.
 *
 * Returns null when:
 *   • spotPrice / ivValue / daysToExpiry are missing or non-positive
 *   • the strategy name isn't recognised
 *   • the leg shape doesn't match what the strategy expects
 *
 * The caller (signal service or preview path) is responsible for
 * deciding whether to show a fallback message or hide the field; this
 * function never invents data.
 */
export function computePop(inputs: PopInputs): number | null {
  const { strategy, legs, spotPrice, ivValue, daysToExpiry, netPerUnit } = inputs;

  if (!(spotPrice > 0)) return null;
  if (!(ivValue > 0)) return null;
  if (!(daysToExpiry > 0)) return null;
  if (!Array.isArray(legs) || legs.length === 0) return null;

  const sigma = ivValue;
  const T = daysToExpiry / DAYS_PER_YEAR;
  const absNet = Math.abs(netPerUnit);
  const isDebit = netPerUnit > 0;

  const strikes = legs.map((l) => l.strike).filter((k) => k > 0);
  if (strikes.length !== legs.length) return null;
  const sorted = [...strikes].sort((a, b) => a - b);

  switch (strategy as StrategyName) {
    // Long single-leg buys: profitable above (call) or below (put) the
    // breakeven, where breakeven = strike ± debit paid.
    case 'long_call': {
      if (legs.length !== 1 || !isDebit) return null;
      const breakeven = legs[0].strike + absNet;
      return probAbove(spotPrice, breakeven, sigma, T);
    }
    case 'long_put': {
      if (legs.length !== 1 || !isDebit) return null;
      const breakeven = legs[0].strike - absNet;
      if (breakeven <= 0) return 1; // entire downside is profitable
      return 1 - probAbove(spotPrice, breakeven, sigma, T);
    }

    // Vertical debit spreads. Long leg defines the "side"; breakeven is the
    // long strike adjusted by the net debit.
    case 'bull_call_spread': {
      if (legs.length !== 2 || !isDebit) return null;
      // Long is the lower-strike call (BUY at lower K, SELL at higher K).
      const longStrike = sorted[0];
      const breakeven = longStrike + absNet;
      return probAbove(spotPrice, breakeven, sigma, T);
    }
    case 'bear_put_spread': {
      if (legs.length !== 2 || !isDebit) return null;
      // Long is the higher-strike put (BUY at higher K, SELL at lower K).
      const longStrike = sorted[sorted.length - 1];
      const breakeven = longStrike - absNet;
      if (breakeven <= 0) return 1;
      return 1 - probAbove(spotPrice, breakeven, sigma, T);
    }

    // Iron condor: 4 legs, K1<K2<K3<K4 by template construction. Profit zone
    // is between the inner short strikes ± credit (the breakevens). Outside
    // that zone, the trade loses up to the wing width minus the credit.
    case 'iron_condor': {
      if (legs.length !== 4 || isDebit) return null;
      const k2 = sorted[1];
      const k3 = sorted[2];
      const lower = k2 - absNet;
      const upper = k3 + absNet;
      return probBetween(spotPrice, lower, upper, sigma, T);
    }

    // Symmetric long butterfly: 3 strikes K1<K2<K3 with K2 the body. Profit
    // band is K1 + debit < S_T < K3 − debit. Engine enforces wing symmetry.
    case 'long_butterfly': {
      if (legs.length !== 3 || !isDebit) return null;
      const lower = sorted[0] + absNet;
      const upper = sorted[2] - absNet;
      return probBetween(spotPrice, lower, upper, sigma, T);
    }

    // Long straddle: same strike CALL+PUT. Profitable when |move| exceeds
    // total debit paid, in either direction.
    case 'long_straddle': {
      if (legs.length !== 2 || !isDebit) return null;
      const k = sorted[0]; // both legs share strike
      const lower = k - absNet;
      const upper = k + absNet;
      return 1 - probBetween(spotPrice, lower, upper, sigma, T);
    }

    // Long strangle: OTM call + OTM put at different strikes. Profitable
    // outside the breakeven band on either side.
    case 'long_strangle': {
      if (legs.length !== 2 || !isDebit) return null;
      const lower = sorted[0] - absNet;
      const upper = sorted[1] + absNet;
      return 1 - probBetween(spotPrice, lower, upper, sigma, T);
    }

    // Calendar spread: same strike, different expiries. Real POP depends on
    // near-leg IV behaviour at the short leg's expiry — we can't model that
    // from a snapshot. Use a conservative heuristic: profitable if the
    // underlying stays within ±5% of the strike at the short-leg expiry.
    // Caller must pass `daysToExpiry` from the SHORT leg.
    case 'calendar_spread': {
      if (legs.length !== 2 || !isDebit) return null;
      const k = sorted[0]; // both legs share strike
      const band = spotPrice * 0.05;
      return probBetween(spotPrice, k - band, k + band, sigma, T);
    }

    // Short put: profitable above strike − credit (cash-secured short put).
    case 'short_put': {
      if (legs.length !== 1 || isDebit) return null;
      const breakeven = legs[0].strike - absNet;
      if (breakeven <= 0) return 1;
      return probAbove(spotPrice, breakeven, sigma, T);
    }

    default:
      return null;
  }
}

/**
 * Expected value per package, given POP and the realised max-profit /
 * max-loss for the actual fill. This collapses the trade to a binary
 * outcome (max profit OR max loss), which is conservative for asymmetric
 * payoffs but the standard simplification for retail risk dashboards.
 *
 * Caller supplies maxProfit/maxLoss in the same units (per-share or
 * total-dollar); EV is returned in the same unit.
 */
export function computeEv(
  pop: number,
  maxProfit: number,
  maxLoss: number,
): number {
  return pop * maxProfit - (1 - pop) * maxLoss;
}

/**
 * Convenience: returns the days-to-expiry the strategy cares about for POP.
 * Calendars use the short leg's expiry; everything else uses the (shared)
 * leg expiry. Returns null when expiries are missing.
 */
export function relevantDaysToExpiry(
  strategy: string,
  legs: PopLeg[],
  now: Date = new Date(),
): number | null {
  if (!legs.length) return null;
  const expiries = legs
    .map((l) => (l.expiry ? new Date(l.expiry).getTime() : NaN))
    .filter((t) => Number.isFinite(t)) as number[];
  if (expiries.length === 0) return null;
  // Calendar: take the EARLIEST expiry (the short leg). Other strategies
  // share an expiry, so min/max collapse to the same value.
  const ms = strategy === 'calendar_spread' ? Math.min(...expiries) : Math.max(...expiries);
  const days = (ms - now.getTime()) / 86_400_000;
  return days > 0 ? days : null;
}
