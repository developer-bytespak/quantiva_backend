/**
 * Strategy-specific max-profit / max-loss formulas, parameterised on the
 * *real* net per-unit debit/credit rather than a stored estimate. Shared by
 * the multi-leg order preview (OptionsService.previewMultiLegOrder) and the
 * AI-signal repricing path (OptionsSignalService), so a signal card and the
 * order modal always agree on the trade's economics.
 *
 * Conventions: `netPerUnit` is positive for debits (you pay), negative for
 * credits (you receive). `strikes` are the per-leg strike prices in leg
 * order (any order — sorted internally). Returned values are always
 * non-negative per-share dollars; the caller multiplies by contract size ×
 * qty for total $. Returns null for unknown strategies or leg shapes that
 * don't match, so callers can fall back to whatever estimate they had.
 */
export function estimateRiskReward(
  strategy: string,
  strikes: number[],
  netPerUnit: number,
): { maxProfit: number; maxLoss: number } | null {
  const absNet = Math.abs(netPerUnit);
  const isDebit = netPerUnit >= 0;
  const sorted = [...strikes].sort((a, b) => a - b);

  switch (strategy) {
    // Defined-risk verticals: profit = width − debit, loss = debit.
    case 'bull_call_spread':
    case 'bear_put_spread': {
      if (sorted.length < 2 || !isDebit) return null;
      const width = sorted[sorted.length - 1] - sorted[0];
      return { maxProfit: Math.max(0, width - absNet), maxLoss: absNet };
    }

    // Symmetric long butterfly: profit at the body strike = wing − debit,
    // loss at the wing edges = debit. The signal engine enforces wing
    // symmetry server-side, so using either wing is fine.
    case 'long_butterfly': {
      if (sorted.length < 3 || !isDebit) return null;
      const wing = sorted[1] - sorted[0];
      return { maxProfit: Math.max(0, wing - absNet), maxLoss: absNet };
    }

    // Iron condor: max profit = credit received, max loss = wing − credit.
    // Wing = inner spacing on either side (4 strikes K1<K2<K3<K4 with
    // K2−K1 = K4−K3 by template construction).
    case 'iron_condor': {
      if (sorted.length < 4 || isDebit) return null;
      const wing = sorted[1] - sorted[0];
      return { maxProfit: absNet, maxLoss: Math.max(0, wing - absNet) };
    }

    // Calendar: profit is fuzzy (depends on near-leg time-decay vs
    // far-leg theta), but max loss is bounded at the debit. The Python
    // engine uses a 0.5×debit profit estimate; we keep parity here.
    case 'calendar_spread': {
      if (!isDebit) return null;
      return { maxProfit: absNet * 0.5, maxLoss: absNet };
    }

    // Long single-leg buys + straddles + strangles: loss = debit, profit
    // is theoretically uncapped. Use 2×debit as a loose target — anything
    // sharper would mislead the user about asymmetric upside.
    case 'long_call':
    case 'long_put':
    case 'long_straddle':
    case 'long_strangle': {
      if (!isDebit) return null;
      return { maxProfit: absNet * 2, maxLoss: absNet };
    }

    // Short put: max profit = credit, max loss = strike − credit (down to
    // zero of the underlying).
    case 'short_put': {
      if (sorted.length < 1 || isDebit) return null;
      return { maxProfit: absNet, maxLoss: Math.max(0, sorted[0] - absNet) };
    }

    default:
      return null;
  }
}

/**
 * USD formatter matching the Python engine's `_fmt_usd` precision tiers, so
 * repriced max_profit/max_loss strings keep the exact shapes
 * `parseUsdString` and the frontend already handle ("$1,264", "$5.50",
 * "$0.0450").
 */
export function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100) {
    return `$${Math.round(value).toLocaleString('en-US')}`;
  }
  if (abs >= 1) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(4)}`;
}
