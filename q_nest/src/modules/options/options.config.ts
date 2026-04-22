/**
 * Centralized options module configuration.
 * All values can be overridden via environment variables.
 */

// NaN-safe parsers — malformed env vars fall back to defaults instead of NaN
function safeInt(val: string | undefined, fallback: number): number {
  const parsed = parseInt(val || String(fallback), 10);
  return isNaN(parsed) ? fallback : parsed;
}
function safeFloat(val: string | undefined, fallback: number): number {
  const parsed = parseFloat(val || String(fallback));
  return isNaN(parsed) ? fallback : parsed;
}

// ── Risk Limits ───────────────────────────────────────────────

export const OPTIONS_RISK_CONFIG = {
  MAX_OPEN_POSITIONS: safeInt(process.env.OPTIONS_MAX_OPEN_POSITIONS, 10),
  MAX_PREMIUM_PERCENT: safeFloat(process.env.OPTIONS_MAX_PREMIUM_PERCENT, 0.05),
  EXPIRY_WARNING_HOURS: safeInt(process.env.OPTIONS_EXPIRY_WARNING_HOURS, 24),
  MAX_IV_RANK_FOR_BUY: safeFloat(process.env.OPTIONS_MAX_IV_RANK_FOR_BUY, 0.80),
  IV_RANK_HARD_BLOCK: safeFloat(process.env.OPTIONS_IV_RANK_HARD_BLOCK, 0.90),
  MAX_BID_ASK_SPREAD_PERCENT: safeFloat(process.env.OPTIONS_MAX_BID_ASK_SPREAD, 0.10),
  MIN_OPEN_INTEREST: safeInt(process.env.OPTIONS_MIN_OPEN_INTEREST, 50),
  MAX_PORTFOLIO_LOSS_PERCENT: safeFloat(process.env.OPTIONS_MAX_PORTFOLIO_LOSS, 0.20),
  MAX_SELL_MARGIN_PERCENT: safeFloat(process.env.OPTIONS_MAX_SELL_MARGIN, 0.90),
};

// ── Polling Intervals ─────────────────────────────────────────

export const OPTIONS_POLLING_CONFIG = {
  // When the WS stream is healthy these are broadcast cadences (data is already in memory).
  // When the stream is down and we fall back to REST, these govern cache-refresh frequency.
  CHAIN_INTERVAL_MS: safeInt(process.env.OPTIONS_CHAIN_POLL_MS, 2000),
  TICKER_INTERVAL_MS: safeInt(process.env.OPTIONS_TICKER_POLL_MS, 1000),
  // Alpaca chain polling is separate: the indicative feed is 15-min delayed so
  // there is no data-freshness benefit from polling faster than ~15 s.
  // Keeping this separate from CHAIN_INTERVAL_MS avoids slowing down Binance.
  ALPACA_CHAIN_INTERVAL_MS: safeInt(process.env.OPTIONS_ALPACA_CHAIN_POLL_MS, 15000),
};

// ── Underlyings ───────────────────────────────────────────────

export const FALLBACK_UNDERLYINGS = (
  process.env.OPTIONS_FALLBACK_UNDERLYINGS || 'BTC,ETH,SOL,BNB,DOGE,XRP'
).split(',').map((s) => s.trim());

// ── Binance Retry ─────────────────────────────────────────────

export const OPTIONS_RETRY_CONFIG = {
  // Fewer retries — stacking 3 retries on every failed call multiplies weight usage
  // and makes Binance bans longer. 5xx/timeouts are retried, 418/429 are not (service handles).
  MAX_RETRIES: safeInt(process.env.OPTIONS_MAX_RETRIES, 2),
  BASE_DELAY_MS: safeInt(process.env.OPTIONS_RETRY_BASE_DELAY, 1000),
  MAX_DELAY_MS: safeInt(process.env.OPTIONS_RETRY_MAX_DELAY, 10000),
};

// ── Market-Data WebSocket ─────────────────────────────────────

export const OPTIONS_STREAM_CONFIG = {
  // Feature flag — flip off to force pure-REST path without redeploy
  ENABLED: (process.env.OPTIONS_WS_ENABLED ?? 'true').toLowerCase() !== 'false',
  // Verified via binance-connector-python (DERIVATIVES_TRADING_OPTIONS_WS_STREAMS_PROD_URL)
  ENDPOINT: process.env.OPTIONS_WS_ENDPOINT ?? 'wss://fstream.binance.com/market/stream',
  // Which underlyings to subscribe to on boot
  UNDERLYINGS: (process.env.OPTIONS_WS_UNDERLYINGS ||
    process.env.OPTIONS_FALLBACK_UNDERLYINGS ||
    'BTC,ETH,SOL,BNB,DOGE,XRP'
  ).split(',').map((s) => s.trim()).filter(Boolean),
  RECONNECT_BASE_DELAY_MS: safeInt(process.env.OPTIONS_WS_RECONNECT_BASE, 1000),
  RECONNECT_MAX_DELAY_MS: safeInt(process.env.OPTIONS_WS_RECONNECT_MAX, 60000),
  // Binance disconnects at 24h; we pre-empt that at 23h to avoid missed updates.
  DAILY_CYCLE_MS: safeInt(process.env.OPTIONS_WS_DAILY_CYCLE, 23 * 60 * 60 * 1000),
  // Snapshot older than this is considered stale; consumers fall back to REST
  STALE_MS: safeInt(process.env.OPTIONS_WS_STALE_MS, 30000),
};
