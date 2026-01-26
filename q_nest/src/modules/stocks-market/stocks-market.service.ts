import { Injectable, Logger } from '@nestjs/common';
import { MarketAggregatorService } from './services/market-aggregator.service';
import { MarketStocksDbService } from './services/market-stocks-db.service';
import { CacheManagerService } from './services/cache-manager.service';
import { AlpacaMarketService } from './services/alpaca-market.service';
import { FmpService } from './services/fmp.service';
import { MarketDataResponse, MarketStock } from './types/market.types';
import SP500_SYMBOLS from './data/sp500-symbols';
import SP500_TOP50 from './data/sp500-top50';

export interface GetMarketDataOptions {
  limit?: number;
  symbols?: string[];
  search?: string;
  sector?: string;
}

@Injectable()
export class StocksMarketService {
  private readonly logger = new Logger(StocksMarketService.name);

  constructor(
    private marketAggregator: MarketAggregatorService,
    private dbService: MarketStocksDbService,
    private cacheManager: CacheManagerService,
    private alpacaService: AlpacaMarketService,
    private fmpService: FmpService,
  ) {}

  /**
   * Get market data (from cache or database)
   */
  async getMarketData(
    options: GetMarketDataOptions = {},
  ): Promise<MarketDataResponse> {
    const { limit, symbols, search, sector } = options;

    try {
      // Generate cache key (includes all query parameters)
      const cacheKey = CacheManagerService.generateMarketDataKey(
        symbols || [],
        limit,
        search,
        sector,
      );

      // Check cache first
      const cached = this.cacheManager.get<MarketDataResponse>(cacheKey);
      if (cached) {
        this.logger.log('Returning cached market data');
        return cached;
      }

      // Fetch from database
      let stocks: MarketStock[] = [];

      if (search) {
        // Search by symbol/name
        stocks = await this.dbService.search(search, limit);
      } else if (symbols && symbols.length > 0) {
        // Get specific symbols
        stocks = await this.dbService.getBySymbols(symbols);
        if (limit) {
          stocks = stocks.slice(0, limit);
        }
      } else if (sector) {
        // Filter by sector
        stocks = await this.dbService.getBySector(sector, limit);
      } else {
        // Get all (with limit)
        stocks = await this.dbService.getAll(limit);
      }

      const response: MarketDataResponse = {
        items: stocks,
        timestamp: new Date().toISOString(),
      };

      // Cache the response
      this.cacheManager.setPrice(cacheKey, response);

      return response;
    } catch (error: any) {
      this.logger.error('Failed to get market data', {
        error: error?.message,
        options,
      });
      throw error;
    }
  }

  /**
   * Sync market data from external APIs and store in database
   * This is called by the cron job once per day
   * Syncs all available stocks in one batch to minimize FMP API calls
   * Since we only call once per day, we can sync all stocks at once
   */
  async syncMarketData(): Promise<{
    success: boolean;
    synced: number;
    warnings: string[];
    totalStocks: number;
    syncedToday: number;
  }> {
    try {
      this.logger.log('Starting market data sync...');

      // Get total count of active stocks
      const totalStocks = await this.dbService.getCount();
      
      // Since we're syncing once per day, sync all available stocks at once
      // This minimizes FMP API calls while keeping data fresh
      let symbolsToSync = await this.dbService.getActiveStockSymbols();

      // If database is empty, fallback to hardcoded list
      if (symbolsToSync.length === 0) {
        this.logger.warn(
          'No stocks found in database, using hardcoded SP500_TOP50 as fallback',
        );
        symbolsToSync = SP500_TOP50;
      } else {
        this.logger.log(
          `Syncing all ${symbolsToSync.length} stocks in one batch (daily sync).`,
        );
      }

      // Fetch aggregated data from APIs
      const { stocks, warnings } =
        await this.marketAggregator.getAggregatedMarketData(symbolsToSync);

      if (stocks.length === 0) {
        throw new Error('No stocks data received from aggregator');
      }

      // Store in database
      await this.dbService.upsertBatch(stocks);

      // Invalidate all cache entries for market data
      this.cacheManager.invalidatePattern('^market:');

      this.logger.log(
        `Market data sync completed - ${stocks.length}/${symbolsToSync.length} stocks synced today (${totalStocks} total in database)`,
      );

      return {
        success: true,
        synced: stocks.length,
        warnings,
        totalStocks,
        syncedToday: stocks.length,
      };
    } catch (error: any) {
      this.logger.error('Market data sync failed', {
        error: error?.message,
      });

      return {
        success: false,
        synced: 0,
        warnings: [error?.message || 'Unknown error'],
        totalStocks: 0,
        syncedToday: 0,
      };
    }
  }

  /**
   * Force sync now (for manual trigger)
   */
  async forceSyncNow(): Promise<void> {
    await this.syncMarketData();
  }

  /**
   * Refresh S&P 500 list from FMP API and store in database
   * This should be called periodically (e.g., monthly) to keep the list up-to-date
   * Returns the number of stocks stored
   * Optionally triggers a sync after refreshing
   */
  async refreshSP500ListFromFMP(
    triggerSync: boolean = false,
  ): Promise<{
    success: boolean;
    stored: number;
    updated: number;
    deactivated: number;
    total: number;
    message: string;
    syncTriggered?: boolean;
  }> {
    try {
      this.logger.log('Refreshing S&P 500 list from FMP API...');

      // Fetch S&P 500 constituents from FMP
      let constituents = await this.fmpService.getSP500Constituents();

      // If FMP fails (rate limit, etc.), fallback to hardcoded list
      if (constituents.length === 0) {
        this.logger.warn(
          'No S&P 500 constituents fetched from FMP (likely rate limited). Using hardcoded SP500_SYMBOLS as fallback.',
        );
        // Use hardcoded list as fallback
        constituents = SP500_SYMBOLS.map((stock) => ({
          symbol: stock.symbol,
          name: stock.name,
          sector: stock.sector,
        }));
        this.logger.log(
          `Using ${constituents.length} stocks from hardcoded SP500_SYMBOLS list`,
        );
      }

      // Store in database (automatically handles removed stocks)
      const { stored, updated, deactivated } =
        await this.dbService.storeSP500Symbols(constituents);

      let updateMessage = `S&P 500 list refreshed: ${stored} new, ${updated} updated, ${constituents.length} total`;
      if (deactivated > 0) {
        updateMessage += `, ${deactivated} removed stocks deactivated`;
      }
      this.logger.log(updateMessage);

      // Invalidate cache to ensure fresh data
      this.cacheManager.invalidatePattern('^market:');

      let syncTriggered = false;
      // Optionally trigger sync to fetch market data for all stocks
      if (triggerSync) {
        this.logger.log('Triggering market data sync after S&P 500 refresh...');
        try {
          await this.syncMarketData();
          syncTriggered = true;
        } catch (syncError: any) {
          this.logger.warn('Sync after refresh failed', {
            error: syncError?.message,
          });
        }
      }

      let message = `Successfully refreshed S&P 500 list: ${stored} new stocks, ${updated} updated`;
      if (deactivated > 0) {
        message += `, ${deactivated} removed stocks deactivated`;
      }
      message += `. ${
        triggerSync && syncTriggered
          ? 'Market data sync triggered.'
          : 'Call /api/stocks-market/force-sync to fetch market data for all stocks.'
      }`;

      return {
        success: true,
        stored,
        updated,
        deactivated,
        total: constituents.length,
        message,
        syncTriggered,
      };
    } catch (error: any) {
      this.logger.error('Failed to refresh S&P 500 list from FMP', {
        error: error?.message,
      });

      return {
        success: false,
        stored: 0,
        updated: 0,
        deactivated: 0,
        total: 0,
        message: `Failed to refresh S&P 500 list: ${error?.message || 'Unknown error'}`,
      };
    }
  }

  /**
   * Get sync status
   */
  async getSyncStatus(): Promise<{
    lastUpdate: Date | null;
    stockCount: number;
    cacheStats: any;
  }> {
    try {
      const lastUpdate = await this.dbService.getLastUpdateTime();
      const stockCount = await this.dbService.getCount();
      const cacheStats = this.cacheManager.getStats();

      return {
        lastUpdate,
        stockCount,
        cacheStats,
      };
    } catch (error: any) {
      this.logger.error('Failed to get sync status', {
        error: error?.message,
      });
      throw error;
    }
  }

  /**
   * Get count of active stock symbols (for sync status)
   */
  async getActiveStockSymbolsCount(): Promise<number> {
    try {
      const symbols = await this.dbService.getActiveStockSymbols();
      return symbols.length;
    } catch (error: any) {
      this.logger.error('Failed to get active stock symbols count', {
        error: error?.message,
      });
      return 0;
    }
  }

  /**
   * Health check for external services
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    services: any;
    database: {
      connected: boolean;
      stockCount: number;
      lastUpdate: Date | null;
    };
  }> {
    try {
      // Check external services
      const servicesHealth = await this.marketAggregator.healthCheck();

      // Check database
      const stockCount = await this.dbService.getCount();
      const lastUpdate = await this.dbService.getLastUpdateTime();

      return {
        status: servicesHealth.status,
        services: servicesHealth.services,
        database: {
          connected: true,
          stockCount,
          lastUpdate,
        },
      };
    } catch (error: any) {
      this.logger.error('Health check failed', { error: error?.message });
      throw error;
    }
  }

  /**
   * Get available sectors
   */
  async getSectors(): Promise<{
    sectors: Array<{ name: string; count: number }>;
  }> {
    try {
      // Get unique sectors from symbol list
      const sectors = new Map<string, number>();

      SP500_TOP50.forEach((stock) => {
        sectors.set(stock.sector, (sectors.get(stock.sector) || 0) + 1);
      });

      const sectorList = Array.from(sectors.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      return { sectors: sectorList };
    } catch (error: any) {
      this.logger.error('Failed to get sectors', { error: error?.message });
      throw error;
    }
  }

  /**
   * Get individual stock detail
   * Uses Alpaca free tier snapshot API + FMP for market cap
   */
  async getStockDetail(symbol: string): Promise<{
    symbol: string;
    name: string;
    price: number;
    change24h: number;
    changePercent24h: number;
    volume24h: number;
    marketCap: number | null;
    sector: string;
    high24h: number;
    low24h: number;
    prevClose: number;
    open: number;
    timestamp: string;
  }> {
    try {
      const cacheKey = `stock_detail_${symbol.toUpperCase()}`;

      // Check cache (30s TTL)
      const cached = this.cacheManager.get<any>(cacheKey);
      if (cached) {
        this.logger.log(`Returning cached detail for ${symbol}`);
        return cached;
      }

      // Fetch from Alpaca (free tier) and FMP (for market cap) in parallel
      // Use Promise.allSettled to ensure Alpaca data is always fetched even if FMP fails
      const [alpacaResult, fmpResult, dbResult] = await Promise.allSettled([
        this.alpacaService.getBatchQuotes([symbol.toUpperCase()]),
        this.fmpService.getBatchProfiles([symbol.toUpperCase()]).catch((err) => {
          this.logger.warn(`FMP fetch failed for ${symbol}: ${err?.message}`);
          return new Map();
        }),
        this.dbService.getBySymbols([symbol.toUpperCase()]).catch((err) => {
          this.logger.warn(`Database fetch failed for ${symbol}: ${err?.message}`);
          return [];
        }),
      ]);

      // Extract results
      const quotesMap = alpacaResult.status === 'fulfilled' ? alpacaResult.value : new Map();
      const fmpData = fmpResult.status === 'fulfilled' ? fmpResult.value : new Map();
      const dbStock = dbResult.status === 'fulfilled' ? dbResult.value : [];

      const stock = quotesMap.get(symbol.toUpperCase());
      if (!stock) {
        throw new Error(`Stock ${symbol} not found`);
      }

      const fmpQuote = fmpData.get(symbol.toUpperCase());
      const metadata = dbStock[0] || null;

      // Log FMP data for debugging
      if (fmpQuote) {
        this.logger.log(`FMP quote found for ${symbol}: marketCap=${fmpQuote.marketCap}, name=${fmpQuote.name}`);
      } else {
        this.logger.warn(`No FMP quote found for ${symbol} (fmpData.size=${fmpData.size})`);
      }

      // Get market cap: prefer FMP (real-time), fallback to database
      const marketCap = fmpQuote?.marketCap || metadata?.marketCap || null;
      
      if (marketCap) {
        this.logger.log(`Market cap for ${symbol}: ${marketCap} (source: ${fmpQuote ? 'FMP' : 'database'})`);
      } else {
        this.logger.warn(`Market cap is null for ${symbol} (fmpQuote=${!!fmpQuote}, metadata=${!!metadata})`);
      }

      // Get name: prefer FMP, then database, fallback to symbol
      const name = fmpQuote?.name || metadata?.name || stock.symbol;

      // Get sector from database (FMP profile might have it too)
      const sector = metadata?.sector || 'Unknown';

      const detail = {
        symbol: stock.symbol,
        name,
        price: stock.price,
        change24h: stock.change24h,
        changePercent24h: stock.changePercent24h,
        volume24h: stock.volume24h,
        marketCap,
        sector,
        high24h: stock.dayHigh || 0,
        low24h: stock.dayLow || 0,
        prevClose: stock.prevClose || 0,
        open: stock.dayOpen || 0,
        timestamp: new Date().toISOString(),
      };

      // Cache for 30s (only if we have valid data)
      // If marketCap is null and FMP failed, use shorter cache to retry sooner
      if (marketCap === null && fmpData.size === 0) {
        // FMP failed - cache for only 5 seconds to allow retry
        this.cacheManager.set(cacheKey, detail, 5);
        this.logger.warn(`Caching ${symbol} with null marketCap (FMP failed) - short cache TTL`);
      } else {
        // Normal cache
        this.cacheManager.setPrice(cacheKey, detail);
      }

      return detail;
    } catch (error: any) {
      this.logger.error(`Failed to get stock detail for ${symbol}`, {
        error: error?.message,
      });
      throw error;
    }
  }

  /**
   * Get historical bars for candlestick chart
   * Uses Alpaca free tier bars API
   * Timeframes: 1Min, 5Min, 15Min, 1Hour, 1Day
   */
  async getStockBars(
    symbol: string,
    timeframe: string = '1Day',
    limit: number = 100,
  ): Promise<{
    symbol: string;
    timeframe: string;
    bars: Array<{
      timestamp: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;
  }> {
    try {
      const cacheKey = `stock_bars_${symbol.toUpperCase()}_${timeframe}_${limit}`;

      // Check cache (5min TTL)
      const cached = this.cacheManager.get<any>(cacheKey);
      if (cached) {
        this.logger.log(`Returning cached bars for ${symbol}`);
        return cached;
      }

      // Fetch from Alpaca (free tier)
      const alpacaBars = await this.alpacaService.getHistoricalBars(
        symbol.toUpperCase(),
        timeframe,
        limit,
      );

      // Transform AlpacaBar format to expected format
      const bars = alpacaBars.map((bar) => ({
        timestamp: bar.t,
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.v,
      }));

      const result = {
        symbol: symbol.toUpperCase(),
        timeframe,
        bars,
      };

      // Cache for 5 minutes
      this.cacheManager.setPrice(cacheKey, result);

      return result;
    } catch (error: any) {
      this.logger.error(`Failed to get bars for ${symbol}`, {
        error: error?.message,
      });
      throw error;
    }
  }
}
