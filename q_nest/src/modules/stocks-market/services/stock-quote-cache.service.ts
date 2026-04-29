import { Injectable, Logger } from '@nestjs/common';
import { AlpacaMarketService, AlpacaQuote } from './alpaca-market.service';

interface CacheEntry {
  quote: AlpacaQuote;
  expiresAt: number;
}

/**
 * Per-symbol cache for live Alpaca stock quotes used by realtime card displays
 * (Top Trades, S&P 500 Market list). Coalesces concurrent fetches so the same
 * symbol never hits Alpaca twice in a TTL window — important for the free tier
 * (~200 req/min limit). At any user scale, total Alpaca traffic stays bounded
 * by ceil(uniqueSymbols / 100) batch requests per TTL window.
 */
@Injectable()
export class StockQuoteCacheService {
  private readonly logger = new Logger(StockQuoteCacheService.name);
  private readonly TTL_MS = 30_000;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<Map<string, AlpacaQuote>>>();

  constructor(private readonly alpacaMarketService: AlpacaMarketService) {}

  async getQuotes(symbols: string[]): Promise<Map<string, AlpacaQuote>> {
    const result = new Map<string, AlpacaQuote>();
    const now = Date.now();
    const toFetch: string[] = [];

    for (const raw of symbols) {
      const symbol = raw.toUpperCase();
      const entry = this.cache.get(symbol);
      if (entry && entry.expiresAt > now) {
        result.set(symbol, entry.quote);
      } else {
        toFetch.push(symbol);
      }
    }

    if (toFetch.length === 0) return result;

    const newKeys = toFetch.filter((s) => !this.inflight.has(s));

    if (newKeys.length > 0) {
      const promise = this.fetchAndCache(newKeys);
      for (const s of newKeys) this.inflight.set(s, promise);
    }

    const promises = new Set<Promise<Map<string, AlpacaQuote>>>();
    for (const s of toFetch) {
      const p = this.inflight.get(s);
      if (p) promises.add(p);
    }

    const settled = await Promise.allSettled([...promises]);
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        r.value.forEach((q, sym) => result.set(sym, q));
      }
    }

    return result;
  }

  private async fetchAndCache(symbols: string[]): Promise<Map<string, AlpacaQuote>> {
    try {
      const quotes = await this.alpacaMarketService.getBatchQuotes(symbols);
      const expiresAt = Date.now() + this.TTL_MS;
      quotes.forEach((quote, symbol) => {
        this.cache.set(symbol.toUpperCase(), { quote, expiresAt });
      });
      this.logger.debug(`Cached ${quotes.size}/${symbols.length} Alpaca quotes (TTL ${this.TTL_MS}ms)`);
      return quotes;
    } catch (err: any) {
      this.logger.error(`Alpaca batch quote fetch failed: ${err?.message ?? err}`);
      return new Map();
    } finally {
      for (const s of symbols) this.inflight.delete(s);
    }
  }
}
