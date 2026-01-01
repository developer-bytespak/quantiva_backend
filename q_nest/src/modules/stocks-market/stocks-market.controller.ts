import {
  Controller,
  Get,
  Query,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { StocksMarketService } from './stocks-market.service';

@Controller('api/stocks-market')
export class StocksMarketController {
  private readonly logger = new Logger(StocksMarketController.name);

  constructor(private readonly stocksMarketService: StocksMarketService) {}

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
   */
  @Get('sync-status')
  async getSyncStatus() {
    try {
      return await this.stocksMarketService.getSyncStatus();
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
}
