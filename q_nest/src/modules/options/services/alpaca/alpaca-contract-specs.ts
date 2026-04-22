/**
 * Alpaca US equity options contract constants.
 *
 * Every US-listed single-equity option is standardized at 100 shares per
 * contract — no fractional contracts, no alternative multipliers.
 */
export const ALPACA_CONTRACT_MULTIPLIER = 100;

/**
 * Underlyings we seed for chains, IV history, and AI signals on the Alpaca
 * venue. Kept intentionally small to bound OPRA data costs and cron fan-out;
 * can be made dynamic (watchlist-driven) later without a schema change.
 */
export const ALPACA_DEFAULT_UNDERLYINGS = [
  'SPY',
  'QQQ',
  'AAPL',
  'MSFT',
  'NVDA',
  'TSLA',
  'AMZN',
  'GOOG',
] as const;

export type AlpacaDefaultUnderlying = (typeof ALPACA_DEFAULT_UNDERLYINGS)[number];

/** Alpaca base URLs — paper vs live is selected by API-key prefix (PK* vs AK*). */
export const ALPACA_URLS = {
  tradingLive: 'https://api.alpaca.markets',
  tradingPaper: 'https://paper-api.alpaca.markets',
  data: 'https://data.alpaca.markets',
} as const;

/**
 * Data feed tier.
 * - `indicative` — free, slightly delayed (included with every plan)
 * - `opra`       — real-time OPRA consolidated tape, requires Algo Trader Plus
 *                  on the user's Alpaca account.
 *
 * We default to `indicative` and let individual calls override via an env flag
 * once users start upgrading their Alpaca plan.
 */
export const ALPACA_DEFAULT_FEED: 'indicative' | 'opra' =
  (process.env.ALPACA_OPTIONS_FEED as 'indicative' | 'opra') || 'indicative';
