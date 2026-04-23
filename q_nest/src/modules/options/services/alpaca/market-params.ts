/**
 * Market-wide inputs to the Black-Scholes engine that can't be inferred
 * from a single option quote: risk-free rate and per-ticker dividend yield.
 *
 * Both are slow-moving (quarter-to-quarter), so keeping them in code (with
 * an env override for the rate) is a reasonable MVP. Revisit if/when we
 * start trading options on tickers outside this table.
 */

/**
 * Annual continuous risk-free rate used by the BS engine. Default tracks
 * the 3-month US T-bill yield; override per-deploy via env when it drifts.
 * Typical drift is ±50bps/quarter so an annual refresh is fine.
 */
export function getRiskFreeRate(): number {
  const raw = process.env.OPTIONS_RISK_FREE_RATE;
  if (!raw) return 0.045; // 4.5% — US 3M T-bill as of Q2 2026
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0.2) {
    // Guardrail: ignore obviously-bad env values rather than blow up pricing.
    return 0.045;
  }
  return parsed;
}

/**
 * Continuous dividend yield per underlying. Values are trailing-12-month
 * yields rounded to 2 decimals. Tickers not in the table default to 0.
 *
 * Keep in sync with ALPACA_DEFAULT_UNDERLYINGS. If you add a new default
 * underlying, add its yield here (use 0 for non-payers).
 */
const DIVIDEND_YIELDS: Readonly<Record<string, number>> = {
  // ETFs — trailing-12-month distribution yields
  SPY: 0.013,
  QQQ: 0.005,
  // Single names
  AAPL: 0.005,
  MSFT: 0.007,
  NVDA: 0.0003,
  TSLA: 0,
  AMZN: 0,
  GOOG: 0,
};

/**
 * Continuous annual dividend yield for an underlying. Returns 0 for unknown
 * tickers — BS prices fall back to the no-dividend case, which is the right
 * conservative choice (slightly overstates call prices, understates puts).
 */
export function getDividendYield(underlying: string): number {
  return DIVIDEND_YIELDS[underlying.toUpperCase()] ?? 0;
}
