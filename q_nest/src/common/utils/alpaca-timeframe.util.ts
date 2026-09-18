/**
 * Alpaca Market Data bar timeframes.
 *
 * Alpaca accepts `[1-59]Min`, `[1-23]Hour`, `1Day`, `1Week` and `[1-12]Month`.
 * Callers across the codebase pass either that CamelCase form or the
 * Binance-style shorthand ('1m', '4h', '1d', '1w', '1M', '1y'), so both are
 * normalised here. Shared by the public stocks-market bars route and the
 * connected-mode Alpaca integration so the two never drift apart.
 */

const SHORTHAND: Record<string, string> = {
  '1m': '1Min',
  '3m': '3Min',
  '5m': '5Min',
  '15m': '15Min',
  '30m': '30Min',
  '1h': '1Hour',
  '2h': '2Hour',
  '4h': '4Hour',
  '6h': '6Hour',
  '8h': '8Hour',
  '12h': '12Hour',
  '1d': '1Day',
  '1w': '1Week',
  '1M': '1Month',
  '1y': '12Month',
};

const UNIT_CASE: Record<string, AlpacaUnit> = {
  min: 'Min',
  hour: 'Hour',
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

export type AlpacaUnit = 'Min' | 'Hour' | 'Day' | 'Week' | 'Month';

export interface ParsedAlpacaTimeframe {
  n: number;
  unit: AlpacaUnit;
}

/** Parse an Alpaca-format timeframe. Returns null for anything unrecognised. */
export function parseAlpacaTimeframe(tf: string): ParsedAlpacaTimeframe | null {
  const m = /^(\d{1,2})(min|hour|day|week|month)$/i.exec(tf ?? '');
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { n, unit: UNIT_CASE[m[2].toLowerCase()] };
}

/**
 * Normalise any supported spelling to Alpaca's CamelCase form. Unknown
 * strings are returned as-is so Alpaca can produce its own validation error.
 */
export function toAlpacaTimeframe(tf?: string | null): string {
  if (!tf) return '1Day';
  if (SHORTHAND[tf]) return SHORTHAND[tf];
  const parsed = parseAlpacaTimeframe(tf);
  return parsed ? `${parsed.n}${parsed.unit}` : tf;
}

/** True for intraday bar sizes (minutes or hours). */
export function isIntradayAlpacaTimeframe(tf: string): boolean {
  const parsed = parseAlpacaTimeframe(toAlpacaTimeframe(tf));
  return parsed !== null && (parsed.unit === 'Min' || parsed.unit === 'Hour');
}

/** Alpaca has no IEX history before this; also keeps huge windows sane. */
const EARLIEST_START = Date.UTC(2010, 0, 1);

/**
 * Estimate how far back to start a bars query so that at least `limit` bars
 * fall inside the window. Deliberately generous: the request is sent with
 * `sort=desc` and an exact `limit`, so over-estimating only widens the
 * window, it never returns stale bars.
 */
export function estimateBarsStart(
  alpacaTf: string,
  limit: number,
  now: Date = new Date(),
): Date {
  const parsed = parseAlpacaTimeframe(alpacaTf) ?? { n: 1, unit: 'Day' as const };
  const bars = Math.max(1, limit);
  let calendarDays: number;

  switch (parsed.unit) {
    case 'Min': {
      const barsPerTradingDay = 390 / parsed.n; // regular session only, a lower bound
      calendarDays = Math.ceil((bars / barsPerTradingDay) * (7 / 5)) + 5;
      break;
    }
    case 'Hour': {
      const barsPerTradingDay = 6.5 / parsed.n;
      calendarDays = Math.ceil((bars / barsPerTradingDay) * (7 / 5)) + 5;
      break;
    }
    case 'Day':
      calendarDays = Math.ceil(bars * parsed.n * (7 / 5)) + 10;
      break;
    case 'Week':
      calendarDays = bars * parsed.n * 7 + 14;
      break;
    case 'Month':
      calendarDays = bars * parsed.n * 31 + 31;
      break;
  }

  const startMs = now.getTime() - calendarDays * 86_400_000;
  return new Date(Math.max(startMs, EARLIEST_START));
}
