import {
  Controller,
  Get,
  Query,
  Param,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { StocksMarketService } from './stocks-market.service';
import { StockQuoteCacheService } from './services/stock-quote-cache.service';
import { CacheManagerService } from './services/cache-manager.service';
import { PrismaService } from '../../prisma/prisma.service';
import { alpacaTradingRateLimiter } from '../exchanges/integrations/alpaca-rate-limiter';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TokenPayload } from '../auth/services/token.service';
import { isOptionBEnabled } from '../../common/feature-flags/option-b.util';

@Controller('api/stocks-market')
export class StocksMarketController {
  private readonly logger = new Logger(StocksMarketController.name);

  constructor(
    private readonly stocksMarketService: StocksMarketService,
    private readonly stockQuoteCacheService: StockQuoteCacheService,
    private readonly cacheManager: CacheManagerService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * GET /api/stocks-market/option-b-health
   *
   * Diagnostic snapshot for Option B. Public — no sensitive data exposed,
   * just aggregate counts and rate-limiter state. Useful for ops checks and
   * for the support team when investigating user reports.
   */
  @Get('option-b-health')
  async getOptionBHealth() {
    try {
      const [activeStocks, eligibleStocks, indexCounts, recentSignals, deactivatedCount] =
        await Promise.all([
          this.prisma.assets.count({
            where: { asset_type: 'stock', is_active: true },
          }),
          this.prisma.assets.count({
            where: { asset_type: 'stock', is_active: true, signal_eligible: true },
          }),
          this.prisma.$queryRaw<Array<{ code: string; count: bigint }>>`
            SELECT i.code, COUNT(im.asset_id)::bigint AS count
            FROM indexes i
            LEFT JOIN index_membership im ON im.index_id = i.index_id
            GROUP BY i.code
            ORDER BY count DESC
          `,
          this.prisma.$queryRaw<Array<{ name: string; target_index_code: string | null; signals_24h: bigint }>>`
            SELECT s.name, s.target_index_code, COUNT(sig.signal_id)::bigint AS signals_24h
            FROM strategies s
            LEFT JOIN strategy_signals sig
              ON sig.strategy_id = s.strategy_id
              AND sig.timestamp > NOW() - INTERVAL '24 hours'
            WHERE s.user_id IS NULL AND s.asset_type = 'stock' AND s.is_active = true
            GROUP BY s.name, s.target_index_code
            ORDER BY signals_24h DESC
          `,
          this.prisma.assets.count({
            where: { asset_type: 'stock', is_active: false },
          }),
        ]);

      return {
        timestamp: new Date().toISOString(),
        universe: {
          active_stocks: activeStocks,
          inactive_stocks: deactivatedCount,
          signal_eligible: eligibleStocks,
          signal_ineligible: activeStocks - eligibleStocks,
        },
        indexes: indexCounts.map((r) => ({
          code: r.code,
          stock_count: Number(r.count),
        })),
        strategies_24h: recentSignals.map((r) => ({
          name: r.name,
          target_index_code: r.target_index_code,
          signals_24h: Number(r.signals_24h),
        })),
        cache: this.cacheManager.getStats(),
        alpaca_rate_limiter: alpacaTradingRateLimiter.getStats(),
      };
    } catch (error: any) {
      this.logger.error('Failed to get option-b-health', { error: error?.message });
      throw new HttpException(
        error.message || 'Failed to get option-b-health',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/stocks-market/stocks
   * Get S&P 500 stocks market data
   * Query params:
   *  - limit: number of stocks (default: 20, max: 500)
   *  - symbols: comma-separated list (optional)
   *  - search: search query for symbol/name (optional)
   *  - sector: filter by sector (optional)
   */
  @Get('stocks')
  async getStocks(
    @Query('limit') limit?: string,
    @Query('symbols') symbols?: string,
    @Query('search') search?: string,
    @Query('sector') sector?: string,
  ) {
    try {
      // Parse limit
      const limitNum = limit ? parseInt(limit, 10) : 20;
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 500) {
        throw new HttpException(
          'Limit must be a number between 1 and 500',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Parse symbols if provided
      const symbolsArray = symbols
        ? symbols.split(',').map((s) => s.trim().toUpperCase())
        : undefined;

      // Fetch stocks
      const result = await this.stocksMarketService.getMarketData({
        limit: limitNum,
        symbols: symbolsArray,
        search,
        sector,
      });

      // Compliance: market_rankings cache can lag the market. Overlay live Alpaca
      // quotes (30s shared cache) so the price the user sees matches what an
      // order would execute at.
      if (result.items && result.items.length > 0) {
        const symbolList = result.items.map((s) => s.symbol).filter((s): s is string => !!s);
        if (symbolList.length > 0) {
          const quotes = await this.stockQuoteCacheService.getQuotes(symbolList);
          result.items = result.items.map((stock) => {
            const q = quotes.get((stock.symbol || '').toUpperCase());
            if (!q || !(q.price > 0)) return stock;
            return {
              ...stock,
              price: q.price,
              change24h: q.change24h,
              changePercent24h: q.changePercent24h,
              volume24h: q.volume24h,
            };
          });
        }
      }

      return result;
    } catch (error: any) {
      this.logger.error('Failed to fetch stocks', {
        error: error?.message,
        limit,
        symbols,
      });

      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        error.message || 'Failed to fetch stocks',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/stocks-market/indexes
   * Returns all 8 indexes (S&P 500, Dow, Nasdaq, etc.) with their member counts.
   * Used by the frontend index-selector dropdown.
   *
   * Feature flag behavior:
   *  - If the user does NOT have Option B enabled, only S&P 500 is returned.
   *  - If enabled, all 8 indexes are returned (including the 3 derived Russell ones with 0 stocks).
   */
  @Get('indexes')
  async getIndexes(@CurrentUser() user?: TokenPayload) {
    try {
      const all = await this.stocksMarketService.getIndexes();
      if (!isOptionBEnabled(user?.email)) {
        return all.filter((i) => i.code === 'SP500');
      }
      return all;
    } catch (error: any) {
      this.logger.error('Failed to fetch indexes', { error: error?.message });
      throw new HttpException(
        error.message || 'Failed to fetch indexes',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/stocks-market/stocks-paginated
   * Paginated stocks query with optional index filter.
   *
   * Query params:
   *  - page (default 1)
   *  - limit (default 50, max 100)
   *  - index (filter by index code, e.g. "RUSSELL_2000")
   *  - search (search symbol/name)
   *  - sector (filter by sector)
   *
   * Feature flag behavior:
   *  - Non-Option-B users always see only S&P 500 (index param ignored).
   *  - Option B users can pass any index code or omit it for the full universe.
   */
  @Get('stocks-paginated')
  async getStocksPaginated(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('index') index?: string,
    @Query('search') search?: string,
    @Query('sector') sector?: string,
    @CurrentUser() user?: TokenPayload,
  ) {
    try {
      const pageNum = page ? Math.max(1, parseInt(page, 10)) : 1;
      const limitNum = limit ? Math.min(100, Math.max(1, parseInt(limit, 10))) : 50;

      if (isNaN(pageNum) || isNaN(limitNum)) {
        throw new HttpException('page and limit must be numbers', HttpStatus.BAD_REQUEST);
      }

      const optionBEnabled = isOptionBEnabled(user?.email);
      const effectiveIndex = optionBEnabled ? (index ?? null) : 'SP500';

      const result = await this.stocksMarketService.getPaginatedStocks({
        page: pageNum,
        limit: limitNum,
        indexCode: effectiveIndex,
        search,
        sector,
      });

      // Overlay live Alpaca quotes (same pattern as /stocks endpoint)
      if (result.items.length > 0) {
        const symbolList = result.items.map((s) => s.symbol).filter((s): s is string => !!s);
        if (symbolList.length > 0) {
          const quotes = await this.stockQuoteCacheService.getQuotes(symbolList);
          result.items = result.items.map((stock) => {
            const q = quotes.get((stock.symbol || '').toUpperCase());
            if (!q || !(q.price > 0)) return stock;
            return {
              ...stock,
              price: q.price,
              change24h: q.change24h,
              changePercent24h: q.changePercent24h,
              volume24h: q.volume24h,
            };
          });
        }
      }

      return result;
    } catch (error: any) {
      this.logger.error('Failed to fetch paginated stocks', {
        error: error?.message,
        page,
        limit,
        index,
      });
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        error.message || 'Failed to fetch paginated stocks',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/stocks-market/health
   * Check health of upstream services (Alpaca, FMP)
   */
  @Get('health')
  async healthCheck() {
    try {
      return await this.stocksMarketService.healthCheck();
    } catch (error: any) {
      this.logger.error('Health check failed', { error: error?.message });

      throw new HttpException(
        'Health check failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/stocks-market/sync-status
   * Get sync job status and last update time
   * Also shows how many stocks are in database vs how many should be synced
   */
  @Get('sync-status')
  async getSyncStatus() {
    try {
      const status = await this.stocksMarketService.getSyncStatus();
      const activeSymbols =
        await this.stocksMarketService.getActiveStockSymbolsCount();

      return {
        ...status,
        activeSymbolsCount: activeSymbols,
        recommendation:
          activeSymbols < 100
            ? 'Consider calling /api/stocks-market/refresh-sp500-list?sync=true to fetch all S&P 500 stocks and sync market data.'
            : null,
      };
    } catch (error: any) {
      this.logger.error('Failed to get sync status', {
        error: error?.message,
      });

      throw new HttpException(
        'Failed to get sync status',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/stocks-market/force-sync
   * Force immediate sync (for testing/admin use)
   */
  @Get('force-sync')
  async forceSync() {
    try {
      await this.stocksMarketService.forceSyncNow();

      return {
        message: 'Sync initiated successfully',
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error('Failed to force sync', { error: error?.message });

      throw new HttpException(
        error.message || 'Failed to force sync',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/stocks-market/sectors
   * Get list of available sectors
   */
  @Get('sectors')
  async getSectors() {
    try {
      return await this.stocksMarketService.getSectors();
    } catch (error: any) {
      this.logger.error('Failed to get sectors', { error: error?.message });

      throw new HttpException(
        'Failed to get sectors',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/stocks-market/stocks/:symbol
   * Get individual stock details
   */
  @Get('stocks/:symbol')
  async getStockDetail(@Param('symbol') symbol: string) {
    try {
      this.logger.log(`Getting stock detail for ${symbol}`);
      return await this.stocksMarketService.getStockDetail(symbol);
    } catch (error: any) {
      this.logger.error(`Failed to get stock detail for ${symbol}`, {
        error: error?.message,
        stack: error?.stack,
        symbol,
      });

      // Return more detailed error information for debugging
      const errorMessage = error?.message || 'Unknown error';
      const statusCode = error?.status || HttpStatus.INTERNAL_SERVER_ERROR;

      throw new HttpException(
        {
          message: `Failed to get stock detail for ${symbol}`,
          error: errorMessage,
          symbol,
        },
        statusCode,
      );
    }
  }

  /**
   * GET /api/stocks-market/stocks/:symbol/bars
   * Get historical bars for candlestick chart
   * Query params:
   * - timeframe: 1Min, 5Min, 15Min, 1Hour, 1Day (default: 1Day)
   * - limit: number of bars to return (default: 100)
   */
  @Get('stocks/:symbol/bars')
  async getStockBars(
    @Param('symbol') symbol: string,
    @Query('timeframe') timeframe?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      this.logger.log(`Getting bars for ${symbol}`, {
        timeframe,
        limit,
      });

      return await this.stocksMarketService.getStockBars(
        symbol,
        timeframe || '1Day',
        limit ? parseInt(limit) : 100,
      );
    } catch (error: any) {
      this.logger.error(`Failed to get bars for ${symbol}`, {
        error: error?.message,
      });

      throw new HttpException(
        `Failed to get bars for ${symbol}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/stocks-market/refresh-sp500-list
   * Refresh S&P 500 list from FMP API and store in database
   * This should be called periodically (e.g., monthly) to keep the list up-to-date
   * Query params:
   *  - sync: boolean (default: false) - If true, triggers market data sync after refresh
   */
  @Get('refresh-sp500-list')
  async refreshSP500List(@Query('sync') sync?: string) {
    try {
      this.logger.log('Refreshing S&P 500 list from FMP API...');
      const triggerSync = sync === 'true' || sync === '1';
      const result = await this.stocksMarketService.refreshSP500ListFromFMP(
        triggerSync,
      );

      return {
        ...result,
        timestamp: new Date().toISOString(),
        nextStep: triggerSync
          ? 'Market data sync completed. Stocks should now be available.'
          : 'Call /api/stocks-market/force-sync to fetch market data for all stocks.',
      };
    } catch (error: any) {
      this.logger.error('Failed to refresh S&P 500 list', {
        error: error?.message,
      });

      throw new HttpException(
        error.message || 'Failed to refresh S&P 500 list',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/stocks-market/load-hardcoded-sp500
   * Load S&P 500 stocks directly from hardcoded list (bypasses FMP API)
   * Use this when FMP is rate limited
   * Query params:
   *  - sync: boolean (default: false) - If true, triggers market data sync after loading
   */
  @Get('load-hardcoded-sp500')
  async loadHardcodedSP500List(@Query('sync') sync?: string) {
    try {
      this.logger.log('Loading S&P 500 list from hardcoded symbols (bypassing FMP)...');
      const triggerSync = sync === 'true' || sync === '1';
      const result = await this.stocksMarketService.loadHardcodedSP500List(
        triggerSync,
      );

      return {
        ...result,
        timestamp: new Date().toISOString(),
        nextStep: triggerSync
          ? 'Market data sync completed. Stocks should now be available.'
          : 'Call /api/stocks-market/force-sync to fetch market data for all stocks.',
      };
    } catch (error: any) {
      this.logger.error('Failed to load hardcoded S&P 500 list', {
        error: error?.message,
      });

      throw new HttpException(
        error.message || 'Failed to load hardcoded S&P 500 list',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
