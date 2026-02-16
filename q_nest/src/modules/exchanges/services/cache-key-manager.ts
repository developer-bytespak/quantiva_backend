/**
 * Centralized cache key management.
 * All cache keys across the exchanges module are defined here
 * to avoid key collisions and enable easy invalidation.
 */
export class CacheKeyManager {
  // ─── Connection ───────────────────────────────
  static connection(connectionId: string): string {
    return `connection:${connectionId}`;
  }

  // ─── Ticker / Price ───────────────────────────
  static ticker(connectionId: string, symbol: string): string {
    return `ticker:${connectionId}:${symbol}`;
  }

  // ─── Candle Data ──────────────────────────────
  static candle(
    connectionId: string,
    symbol: string,
    interval: string,
  ): string {
    return `candle:${connectionId}:${symbol}:${interval}`;
  }

  // ─── Multi-interval Candle Bundle ─────────────
  static candleBundle(connectionId: string, symbol: string): string {
    return `candle-bundle:${connectionId}:${symbol}`;
  }

  // ─── Order Book ───────────────────────────────
  static orderBook(connectionId: string, symbol: string): string {
    return `orderbook:${connectionId}:${symbol}`;
  }

  // ─── Recent Trades ────────────────────────────
  static recentTrades(connectionId: string, symbol: string): string {
    return `trades:${connectionId}:${symbol}`;
  }

  // ─── Market / CoinGecko Data ──────────────────
  static coinGecko(coinId: string): string {
    return `coingecko:${coinId}`;
  }

  static marketData(connectionId: string, symbol: string): string {
    return `market-data:${connectionId}:${symbol}`;
  }

  // ─── Dashboard ────────────────────────────────
  static dashboard(connectionId: string): string {
    return `dashboard:${connectionId}`;
  }

  // ─── Coin Detail (unified) ────────────────────
  static coinDetail(connectionId: string, symbol: string): string {
    return `coin-detail:${connectionId}:${symbol}`;
  }

  // ─── Balance ──────────────────────────────────
  static balance(connectionId: string): string {
    return `balance:${connectionId}`;
  }

  // ─── Aggregated Market Detail ─────────────────
  static aggregatedMarketDetail(
    connectionId: string,
    symbol: string,
  ): string {
    return `agg-market-detail:${connectionId}:${symbol}`;
  }
}
