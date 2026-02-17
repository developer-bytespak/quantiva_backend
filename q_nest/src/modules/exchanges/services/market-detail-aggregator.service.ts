import { Injectable, Logger } from '@nestjs/common';
import { ExchangesService } from '../exchanges.service';
import { BinanceService } from '../integrations/binance.service';
import { BybitService } from '../integrations/bybit.service';
import { CacheService } from './cache.service';
import { CacheKeyManager } from './cache-key-manager';
import { MarketService } from '../../market/market.service';

/**
 * Aggregator service for the Market Detail page.
 *
 * Combines data from multiple sources into a single response:
 *  - Exchange ticker (Binance/Bybit)
 *  - Multi-interval candle data
 *  - CoinGecko market metadata (market cap, supply, etc.)
 *  - Order book snapshot
 *  - Recent trades
 *  - Account balance
 *
 * All fetches run in parallel with per-source error isolation.
 */
@Injectable()
export class MarketDetailAggregatorService {
  private readonly logger = new Logger(MarketDetailAggregatorService.name);

  constructor(
    private readonly exchangesService: ExchangesService,
    private readonly binanceService: BinanceService,
    private readonly bybitService: BybitService,
    private readonly cacheService: CacheService,
    private readonly marketService: MarketService,
  ) {}

  /**
   * Fetch all data for the market detail page in a single call.
   *
   * @param connectionId  Exchange connection ID
   * @param symbol        Trading pair (e.g., BTCUSDT)
   * @param options       Optional configuration
   */
  async getMarketDetail(
    connectionId: string,
    symbol: string,
    options: {
      intervals?: string[];
      includeOrderBook?: boolean;
      includeRecentTrades?: boolean;
      coinGeckoId?: string;
    } = {},
  ) {
    const {
      intervals = ['1d', '1h', '15m'],
      includeOrderBook = true,
      includeRecentTrades = true,
      coinGeckoId,
    } = options;

    // Determine exchange
    const connection = await this.exchangesService.getConnectionById(connectionId);
    if (!connection || !connection.exchange) {
      throw new Error('Connection not found');
    }
    const exchangeName = connection.exchange.name.toLowerCase();

    // Build cache key
    const aggCacheKey = CacheKeyManager.aggregatedMarketDetail(connectionId, symbol);
    const aggTtl = this.cacheService.getTtlForType('coin-detail');

    // Check full aggregate cache
    const cached = this.cacheService.getCached(aggCacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }

    // Run all fetches in parallel with individual error isolation
    const [
      tickerResult,
      candlesResult,
      balanceResult,
      coinGeckoResult,
      orderBookResult,
      recentTradesResult,
    ] = await Promise.allSettled([
      // 1. Ticker
      this.fetchTicker(exchangeName, symbol),
      // 2. Multi-interval candles
      this.fetchMultiIntervalCandles(exchangeName, connectionId, symbol, intervals),
      // 3. Balance
      this.exchangesService.getConnectionData(connectionId, 'balance'),
      // 4. CoinGecko metadata
      coinGeckoId
        ? this.marketService.getCoinDetails(coinGeckoId)
        : this.resolveCoinGecko(symbol),
      // 5. Order book (optional)
      includeOrderBook
        ? this.fetchOrderBook(exchangeName, connectionId, symbol)
        : Promise.resolve(null),
      // 6. Recent trades (optional)
      includeRecentTrades
        ? this.fetchRecentTrades(exchangeName, connectionId, symbol)
        : Promise.resolve(null),
    ]);

    // Extract results with fallbacks
    const ticker = tickerResult.status === 'fulfilled' ? tickerResult.value : null;
    const candlesByInterval = candlesResult.status === 'fulfilled' ? candlesResult.value : {};
    const balance = balanceResult.status === 'fulfilled' ? balanceResult.value : null;
    const coinGeckoData = coinGeckoResult.status === 'fulfilled' ? coinGeckoResult.value : null;
    const orderBook = orderBookResult.status === 'fulfilled' ? orderBookResult.value : null;
    const recentTrades = recentTradesResult.status === 'fulfilled' ? recentTradesResult.value : null;

    // Log any errors
    [tickerResult, candlesResult, balanceResult, coinGeckoResult, orderBookResult, recentTradesResult]
      .forEach((r, i) => {
        if (r.status === 'rejected') {
          const names = ['ticker', 'candles', 'balance', 'coinGecko', 'orderBook', 'recentTrades'];
          this.logger.warn(`Failed to fetch ${names[i]} for ${symbol}: ${r.reason?.message}`);
        }
      });

    // Derive 24h stats
    const dailyCandles = candlesByInterval['1d'] || candlesByInterval[intervals[0]] || [];
    let high24h = 0, low24h = 0, volume24h = 0;

    if (dailyCandles.length > 0) {
      const recent = dailyCandles.slice(-24);
      high24h = Math.max(...recent.map((c: any) => c.high));
      low24h = Math.min(...recent.map((c: any) => c.low));
      volume24h = recent.reduce((sum: number, c: any) => sum + c.volume, 0);
    }

    // Balance
    const balanceData = balance as any;
    const quoteCurrency = 'USDT';
    const quoteBalance = balanceData?.assets?.find((a: any) => a.symbol === quoteCurrency) || null;
    const availableBalance = quoteBalance ? parseFloat(quoteBalance.free || '0') : 0;

    // Build unified response
    const result = {
      symbol,
      tradingPair: symbol,
      exchange: exchangeName,

      // Price data
      currentPrice: ticker?.price || 0,
      change24h: ticker?.change24h || 0,
      changePercent24h: ticker?.changePercent24h || 0,
      high24h,
      low24h,
      volume24h,

      // Account
      availableBalance,
      quoteCurrency,

      // Chart data (multi-interval)
      candlesByInterval,
      candles: dailyCandles.slice(0, 100), // backward compat

      // CoinGecko metadata
      marketData: coinGeckoData
        ? {
            marketCap: coinGeckoData.market_data?.market_cap?.usd || coinGeckoData.market_cap || 0,
            fullyDilutedValuation: coinGeckoData.market_data?.fully_diluted_valuation?.usd || 0,
            circulatingSupply: coinGeckoData.market_data?.circulating_supply || 0,
            totalSupply: coinGeckoData.market_data?.total_supply || 0,
            maxSupply: coinGeckoData.market_data?.max_supply || 0,
            ath: coinGeckoData.market_data?.ath?.usd || 0,
            athDate: coinGeckoData.market_data?.ath_date?.usd || null,
            atl: coinGeckoData.market_data?.atl?.usd || 0,
            atlDate: coinGeckoData.market_data?.atl_date?.usd || null,
            priceChange1h: coinGeckoData.market_data?.price_change_percentage_1h_in_currency?.usd || 0,
            priceChange24h: coinGeckoData.market_data?.price_change_percentage_24h || 0,
            priceChange7d: coinGeckoData.market_data?.price_change_percentage_7d_in_currency?.usd || 0,
            priceChange30d: coinGeckoData.market_data?.price_change_percentage_30d_in_currency?.usd || 0,
            description: coinGeckoData.description?.en?.substring(0, 500) || '',
            image: coinGeckoData.image?.large || coinGeckoData.image || '',
            name: coinGeckoData.name || '',
          }
        : null,

      // Order book
      orderBook: orderBook || null,

      // Recent trades
      recentTrades: recentTrades || null,

      cached: false,
    };

    // Cache the aggregate
    this.cacheService.setCached(aggCacheKey, result, aggTtl);

    return result;
  }

  // ── Private helpers ──────────────────────────────────────

  private async fetchTicker(exchangeName: string, symbol: string) {
    if (exchangeName === 'bybit') {
      const tickers = await this.bybitService.getTickerPrices([symbol]);
      return tickers[0] || null;
    }
    const tickers = await this.binanceService.getTickerPrices([symbol]);
    return tickers[0] || null;
  }

  private async fetchMultiIntervalCandles(
    exchangeName: string,
    connectionId: string,
    symbol: string,
    intervals: string[],
  ): Promise<Record<string, any[]>> {
    const candleTtl = this.cacheService.getTtlForType('candle');

    const results = await Promise.all(
      intervals.map(async (interval) => {
        const cacheKey = CacheKeyManager.candle(connectionId, symbol, interval);
        // Normalize interval for Bybit (8h is not supported, use 6h instead)
        const normalizedInterval = this.normalizeIntervalForExchange(exchangeName, interval);
        
        const candles = await this.cacheService.getOrSet(
          cacheKey,
          async () => {
            if (exchangeName === 'bybit') {
              return this.bybitService.getCandlestickData(symbol, normalizedInterval, 100);
            }
            return this.binanceService.getCandlestickData(symbol, interval, 100);
          },
          candleTtl,
        );
        return { interval, candles };
      }),
    );

    const map: Record<string, any[]> = {};
    for (const { interval, candles } of results) {
      map[interval] = candles;
    }
    return map;
  }

  private async fetchOrderBook(exchangeName: string, connectionId: string, symbol: string) {
    const cacheKey = CacheKeyManager.orderBook(connectionId, symbol);
    const ttl = this.cacheService.getTtlForType('orderbook');

    return this.cacheService.getOrSet(
      cacheKey,
      () => this.exchangesService.getOrderBook(connectionId, symbol),
      ttl,
    );
  }

  private async fetchRecentTrades(exchangeName: string, connectionId: string, symbol: string) {
    const cacheKey = CacheKeyManager.recentTrades(connectionId, symbol);
    const ttl = this.cacheService.getTtlForType('trades');

    return this.cacheService.getOrSet(
      cacheKey,
      () => this.exchangesService.getRecentTrades(connectionId, symbol),
      ttl,
    );
  }

  /**
   * Try to resolve CoinGecko data from a trading symbol like "BTCUSDT"
   */
  private async resolveCoinGecko(symbol: string): Promise<any> {
    // Strip quote currencies
    const quote = ['USDT', 'USDC', 'BUSD', 'USD', 'EUR', 'BTC', 'ETH'];
    let baseSymbol = symbol.toUpperCase();
    for (const q of quote) {
      if (baseSymbol.endsWith(q) && baseSymbol.length > q.length) {
        baseSymbol = baseSymbol.slice(0, -q.length);
        break;
      }
    }
    return this.marketService.getCoinDetails(baseSymbol);
  }

  /**
   * Normalize interval for exchange-specific limitations.
   * Bybit doesn't support 8h intervals, so we map 8h to 6h for Bybit.
   */
  private normalizeIntervalForExchange(exchangeName: string, interval: string): string {
    if (exchangeName === 'bybit' && interval === '8h') {
      return '6h';
    }
    return interval;
  }
}
