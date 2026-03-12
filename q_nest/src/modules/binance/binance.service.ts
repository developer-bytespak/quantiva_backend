import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { BinanceMarketStreamService } from './binance-market-stream.service';

interface Ticker24h {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  lastPrice: string;
  lastQty: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  openTime: number;
  closeTime: number;
  count: number;
}

interface TickerPrice {
  symbol: string;
  price: string;
}

interface Candlestick {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

@Injectable()
export class BinanceService {
  private readonly logger = new Logger(BinanceService.name);
  private readonly baseUrl = 'https://api.binance.com';
  private readonly apiClient: AxiosInstance;

  // Price cache: symbol → { price, fetchedAt }
  private readonly priceCache = new Map<string, { price: number; fetchedAt: number }>();
  private readonly PRICE_CACHE_TTL_MS = 30_000; // 30 seconds

  // Stats cache: symbol → { data, fetchedAt } — 1-minute TTL to cap weight from crons
  private readonly statsCache = new Map<string, {
    data: { price: number; priceChangePercent: number; high24h: number; low24h: number; volume24h: number; quoteVolume24h: number };
    fetchedAt: number;
  }>();
  private readonly STATS_CACHE_TTL_MS = 60_000; // 1 minute

  // Negative cache: symbols that returned 400 from Binance (delisted / not on spot).
  // Prevents repeated REST calls for symbols that will never succeed.
  private readonly invalidSymbols = new Map<string, number>(); // symbol → expiry ms
  private readonly INVALID_SYMBOL_TTL_MS = 5 * 60_000; // re-check after 5 min

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly marketStream?: BinanceMarketStreamService,
  ) {
    const proxyUrl = this.configService.get<string>('BINANCE_PROXY_URL');
    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      ...(proxyUrl ? { httpsAgent: new HttpsProxyAgent(proxyUrl), proxy: false } : {}),
    });
    if (proxyUrl) {
      this.logger.log(`Binance REST proxy enabled: ${proxyUrl.replace(/\/\/.*@/, '//<redacted>@')}`);
    }
  }

  /**
   * Get current price for a symbol — served from cache within 30s TTL
   * to avoid hammering Binance REST with per-trade polling.
   */
  async getPrice(symbol: string): Promise<number> {
    const formattedSymbol = this.formatSymbol(symbol);

    // Stream-first: zero REST weight
    if (this.marketStream?.isConnected()) {
      const streamPrice = this.marketStream.getPrice(formattedSymbol);
      if (streamPrice !== undefined) return streamPrice;
    }

    const cached = this.priceCache.get(formattedSymbol);
    if (cached && Date.now() - cached.fetchedAt < this.PRICE_CACHE_TTL_MS) {
      return cached.price;
    }
    try {
      this.logger.warn(`[REST-FALLBACK] getPrice(${formattedSymbol}) — stream miss, hitting REST`);
      const response = await this.apiClient.get<TickerPrice>('/api/v3/ticker/price', {
        params: { symbol: formattedSymbol },
      });
      const price = parseFloat(response.data.price);
      this.priceCache.set(formattedSymbol, { price, fetchedAt: Date.now() });
      return price;
    } catch (error: any) {
      // Return stale cache if available rather than throwing (avoids cascade failures)
      if (cached) {
        this.logger.warn(`Using stale cache for ${symbol}: ${error.message}`);
        return cached.price;
      }
      this.logger.error(`Failed to get price for ${symbol}: ${error.message}`);
      throw new Error(`Failed to fetch price for ${symbol}`);
    }
  }

  /**
   * Batch-fetch prices for multiple symbols in ONE API call (weight 4 total).
   * Falls back to cache for symbols that fail.
   */
  async getPrices(symbols: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (symbols.length === 0) return result;

    const formatted = symbols.map((s) => this.formatSymbol(s));

    // Stream-first: resolve as many as possible with zero REST weight
    if (this.marketStream?.isConnected()) {
      const remaining: string[] = [];
      for (const sym of formatted) {
        const streamPrice = this.marketStream.getPrice(sym);
        if (streamPrice !== undefined) {
          result.set(sym, streamPrice);
        } else {
          remaining.push(sym);
        }
      }
      if (remaining.length === 0) return result;
      // Only REST-fetch symbols not in stream (shouldn't happen for valid pairs)
    }

    const now = Date.now();

    // Serve all from cache if fresh
    const stale = formatted.filter((s) => {
      const c = this.priceCache.get(s);
      if (c && now - c.fetchedAt < this.PRICE_CACHE_TTL_MS) {
        result.set(s, c.price);
        return false;
      }
      return true;
    });

    if (stale.length === 0) return result;

    try {
      this.logger.warn(`[REST-FALLBACK] getPrices batch — ${stale.length} symbols not in stream, hitting REST`);
      // Single batch request — weight 4 regardless of symbol count
      const response = await this.apiClient.get<TickerPrice[]>('/api/v3/ticker/price');
      const allPrices: TickerPrice[] = response.data;
      const priceMap = new Map(allPrices.map((t) => [t.symbol, parseFloat(t.price)]));

      for (const sym of formatted) {
        const price = priceMap.get(sym);
        if (price !== undefined) {
          this.priceCache.set(sym, { price, fetchedAt: now });
          result.set(sym, price);
        } else {
          const c = this.priceCache.get(sym);
          if (c) result.set(sym, c.price);
        }
      }
    } catch (error: any) {
      this.logger.error(`Batch price fetch failed: ${error.message}`);
      // Fall back to stale cache
      for (const sym of stale) {
        const c = this.priceCache.get(sym);
        if (c) result.set(sym, c.price);
      }
    }

    return result;
  }

  /**
   * Get 24h ticker statistics for a symbol — served from cache within 1-minute TTL.
   * Prevents burst weight from parallel cron calls (e.g. 50 assets × weight 2 = 100/run).
   */
  async get24hStats(symbol: string): Promise<{
    price: number;
    priceChangePercent: number;
    high24h: number;
    low24h: number;
    volume24h: number;
    quoteVolume24h: number;
  }> {
    const formattedSymbol = this.formatSymbol(symbol);

    // Stream-first: zero REST weight
    if (this.marketStream?.isConnected()) {
      const stream = this.marketStream.get24hStats(formattedSymbol);
      if (stream) {
        return {
          price: stream.price,
          priceChangePercent: stream.priceChangePercent,
          high24h: stream.high,
          low24h: stream.low,
          volume24h: stream.volume,
          quoteVolume24h: stream.quoteVolume,
        };
      }
    }

    // Skip REST for known-invalid symbols (delisted / non-existent)
    const invalidUntil = this.invalidSymbols.get(formattedSymbol);
    if (invalidUntil && Date.now() < invalidUntil) {
      throw new Error(`Symbol ${formattedSymbol} is cached as invalid (delisted/unknown)`);
    }

    const cached = this.statsCache.get(formattedSymbol);
    if (cached && Date.now() - cached.fetchedAt < this.STATS_CACHE_TTL_MS) {
      return cached.data;
    }
    try {
      this.logger.warn(`[REST-FALLBACK] get24hStats(${formattedSymbol}) — stream miss, hitting REST`);
      const response = await this.apiClient.get<Ticker24h>('/api/v3/ticker/24hr', {
        params: { symbol: formattedSymbol },
      });

      const data = response.data;
      const stats = {
        price: parseFloat(data.lastPrice),
        priceChangePercent: parseFloat(data.priceChangePercent),
        high24h: parseFloat(data.highPrice),
        low24h: parseFloat(data.lowPrice),
        volume24h: parseFloat(data.volume),
        quoteVolume24h: parseFloat(data.quoteVolume),
      };
      this.statsCache.set(formattedSymbol, { data: stats, fetchedAt: Date.now() });
      return stats;
    } catch (error: any) {
      // Cache 400 errors (delisted symbols) to stop repeated REST attempts
      if (error?.response?.status === 400) {
        this.invalidSymbols.set(formattedSymbol, Date.now() + this.INVALID_SYMBOL_TTL_MS);
        this.logger.warn(`[INVALID-SYMBOL] ${formattedSymbol} cached as invalid for 5 min`);
      }
      // Return stale cache if available rather than failing all callers
      if (cached) {
        this.logger.warn(`Using stale stats cache for ${symbol}: ${error.message}`);
        return cached.data;
      }
      this.logger.error(`Failed to get 24h stats for ${symbol}: ${error.message}`);
      throw new Error(`Failed to fetch 24h stats for ${symbol}`);
    }
  }

  /**
   * Get OHLCV candlestick data
   */
  async getOHLCV(
    symbol: string,
    interval: string = '1h',
    limit: number = 100,
  ): Promise<Candlestick[]> {
    try {
      const formattedSymbol = this.formatSymbol(symbol);
      const response = await this.apiClient.get('/api/v3/klines', {
        params: {
          symbol: formattedSymbol,
          interval: this.mapInterval(interval),
          limit,
        },
      });

      return response.data.map((kline: any[]) => ({
        openTime: kline[0],
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[5]),
        closeTime: kline[6],
      }));
    } catch (error: any) {
      this.logger.error(`Failed to get OHLCV for ${symbol}: ${error.message}`);
      throw new Error(`Failed to fetch OHLCV for ${symbol}`);
    }
  }

  /**
   * Calculate trade metrics based on current market data
   */
  async calculateTradeMetrics(
    symbol: string,
    entryPrice: number,
    stopLossPercent: number,
    takeProfitPercent: number,
  ): Promise<{
    entry: number;
    current_price: number;
    stop_loss: number;
    exit: number;
    profit_percent: number;
    extension_percent: number;
    volume: number;
    risk_reward_ratio: number;
  }> {
    try {
      const stats = await this.get24hStats(symbol);

      const stopLossPrice = entryPrice * (1 - stopLossPercent / 100);
      const takeProfitPrice = entryPrice * (1 + takeProfitPercent / 100);
      const profitPercent = ((stats.price - entryPrice) / entryPrice) * 100;
      const extensionPercent = profitPercent;
      const riskRewardRatio = takeProfitPercent / stopLossPercent;

      return {
        entry: entryPrice,
        current_price: stats.price,
        stop_loss: stopLossPrice,
        exit: takeProfitPrice,
        profit_percent: profitPercent,
        extension_percent: extensionPercent,
        volume: stats.volume24h,
        risk_reward_ratio: riskRewardRatio,
      };
    } catch (error: any) {
      this.logger.error(`Failed to calculate trade metrics for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get enriched market data for strategy preview
   * Returns null for price fields when API fails to allow fallback to database prices
   */
  async getEnrichedMarketData(symbol: string): Promise<{
    price: number | null;
    priceChangePercent: number | null;
    high24h: number | null;
    low24h: number | null;
    volume24h: number | null;
    quoteVolume24h: number | null;
    ohlcv?: Candlestick[];
  }> {
    try {
      const stats = await this.get24hStats(symbol);
      
      return {
        price: stats.price,
        priceChangePercent: stats.priceChangePercent,
        high24h: stats.high24h,
        low24h: stats.low24h,
        volume24h: stats.volume24h,
        quoteVolume24h: stats.quoteVolume24h,
      };
    } catch (error: any) {
      this.logger.warn(`Failed to get enriched market data for ${symbol}, returning nulls for fallback`);
      // Return nulls instead of 0s so frontend can fall back to database prices
      return {
        price: null,
        priceChangePercent: null,
        high24h: null,
        low24h: null,
        volume24h: null,
        quoteVolume24h: null,
      };
    }
  }

  /**
   * Format symbol to Binance format (e.g., BTC -> BTCUSDT)
   */
  formatSymbol(symbol: string): string {
    // Remove any existing USDT suffix to avoid duplication
    const cleanSymbol = symbol.replace(/USDT$/i, '').replace(/\//g, '');
    
    // Add USDT suffix if not already present
    if (!cleanSymbol.endsWith('USDT')) {
      return `${cleanSymbol}USDT`;
    }
    
    return cleanSymbol;
  }

  /**
   * Map interval to Binance format
   */
  private mapInterval(interval: string): string {
    const intervalMap: Record<string, string> = {
      '1m': '1m',
      '3m': '3m',
      '5m': '5m',
      '15m': '15m',
      '30m': '30m',
      '1h': '1h',
      '2h': '2h',
      '4h': '4h',
      '6h': '6h',
      '8h': '8h',
      '12h': '12h',
      '1d': '1d',
      '3d': '3d',
      '1w': '1w',
      '1M': '1M',
    };
    
    return intervalMap[interval] || interval;
  }
}
