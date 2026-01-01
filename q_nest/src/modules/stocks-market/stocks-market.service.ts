import { Injectable, Logger } from '@nestjs/common';
import { MarketAggregatorService } from './services/market-aggregator.service';
import { MarketStocksDbService } from './services/market-stocks-db.service';
import { CacheManagerService } from './services/cache-manager.service';
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
  ) {}

  /**
   * Get market data (from cache or database)
   */
  async getMarketData(
    options: GetMarketDataOptions = {},
  ): Promise<MarketDataResponse> {
    const { limit, symbols, search, sector } = options;

    try {
      // Generate cache key
      const cacheKey = CacheManagerService.generateMarketDataKey(
        symbols || [],
        limit,
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
   * This is called by the cron job
   */
  async syncMarketData(): Promise<{
    success: boolean;
    synced: number;
    warnings: string[];
  }> {
    try {
      this.logger.log('Starting market data sync...');

      // Use top 50 for faster sync (you can change to SP500_SYMBOLS for full list)
      const symbolsToSync = SP500_TOP50;

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
        `Market data sync completed - ${stocks.length}/${symbolsToSync.length} stocks synced`,
      );

      return {
        success: true,
        synced: stocks.length,
        warnings,
      };
    } catch (error: any) {
      this.logger.error('Market data sync failed', {
        error: error?.message,
      });

      return {
        success: false,
        synced: 0,
        warnings: [error?.message || 'Unknown error'],
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
}
