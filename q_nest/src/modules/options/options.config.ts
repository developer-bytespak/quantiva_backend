/**
 * Centralized options module configuration.
 * All values can be overridden via environment variables.
 */

// ── Risk Limits ───────────────────────────────────────────────

export const OPTIONS_RISK_CONFIG = {
  MAX_OPEN_POSITIONS: parseInt(process.env.OPTIONS_MAX_OPEN_POSITIONS || '10', 10),
  MAX_PREMIUM_PERCENT: parseFloat(process.env.OPTIONS_MAX_PREMIUM_PERCENT || '0.05'),
  EXPIRY_WARNING_HOURS: parseInt(process.env.OPTIONS_EXPIRY_WARNING_HOURS || '24', 10),
  MAX_IV_RANK_FOR_BUY: parseFloat(process.env.OPTIONS_MAX_IV_RANK_FOR_BUY || '0.80'),
  IV_RANK_HARD_BLOCK: parseFloat(process.env.OPTIONS_IV_RANK_HARD_BLOCK || '0.90'),
  MAX_BID_ASK_SPREAD_PERCENT: parseFloat(process.env.OPTIONS_MAX_BID_ASK_SPREAD || '0.10'),
  MIN_OPEN_INTEREST: parseInt(process.env.OPTIONS_MIN_OPEN_INTEREST || '50', 10),
  MAX_PORTFOLIO_LOSS_PERCENT: parseFloat(process.env.OPTIONS_MAX_PORTFOLIO_LOSS || '0.20'),
  MAX_SELL_MARGIN_PERCENT: parseFloat(process.env.OPTIONS_MAX_SELL_MARGIN || '0.90'),
};

// ── Polling Intervals ─────────────────────────────────────────

export const OPTIONS_POLLING_CONFIG = {
  CHAIN_INTERVAL_MS: parseInt(process.env.OPTIONS_CHAIN_POLL_MS || '15000', 10),
  TICKER_INTERVAL_MS: parseInt(process.env.OPTIONS_TICKER_POLL_MS || '5000', 10),
};

// ── Underlyings ───────────────────────────────────────────────

export const FALLBACK_UNDERLYINGS = (
  process.env.OPTIONS_FALLBACK_UNDERLYINGS || 'BTC,ETH'
).split(',').map((s) => s.trim());

// ── Binance Retry ─────────────────────────────────────────────

export const OPTIONS_RETRY_CONFIG = {
  MAX_RETRIES: parseInt(process.env.OPTIONS_MAX_RETRIES || '3', 10),
  BASE_DELAY_MS: parseInt(process.env.OPTIONS_RETRY_BASE_DELAY || '1000', 10),
  MAX_DELAY_MS: parseInt(process.env.OPTIONS_RETRY_MAX_DELAY || '10000', 10),
};
