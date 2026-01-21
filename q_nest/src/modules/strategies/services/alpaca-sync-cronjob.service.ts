import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StockTrendingService } from './stock-trending.service';

/**
 * Cronjob service for syncing stock market data from Alpaca API
 * 
 * This service runs scheduled jobs to:
 * 1. Sync real-time stock prices and OHLCV data from Alpaca
 * 2. Update trending_assets table with fresh market data
 * 3. Ensure the frontend always has recent data available
 * 
 * Free tier limitations:
 * - 15-minute delayed data for equities
 * - ~200 API calls per minute limit
 * - Real-time streaming limited to ~30 symbols via IEX
 */
@Injectable()
export class AlpacaSyncCronjobService {
  private readonly logger = new Logger(AlpacaSyncCronjobService.name);
  private isRunning = false;

  constructor(private readonly stockTrendingService: StockTrendingService) {}

  /**
   * Sync stock market data every 5 minutes during market hours (9:30 AM - 4:00 PM EST)
   * Also runs once at 9:25 AM EST to prepare for market open
   * 
   * Note: Alpaca free tier has 15-min delay, so 5-min sync is reasonable
   */
  @Cron('*/5 9-16 * * 1-5', { timeZone: 'America/New_York' }) // Every 5 min, 9AM-4PM EST, Mon-Fri
  async syncDuringMarketHours(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Previous Alpaca sync job still running, skipping');
      return;
    }

    this.isRunning = true;
    this.logger.log('Starting scheduled Alpaca market data sync (market hours)');

    try {
      const result = await this.stockTrendingService.syncMarketDataFromAlpaca();
      
      if (result.success) {
        this.logger.log(`Alpaca sync completed: ${result.updated} stocks updated`);
      } else {
        this.logger.warn(`Alpaca sync completed with issues: ${result.errors.join(', ')}`);
      }
    } catch (error: any) {
      this.logger.error(`Alpaca sync failed: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Sync once every 30 minutes during extended hours (pre-market: 4AM-9:30AM, after-hours: 4PM-8PM EST)
   * This covers extended trading sessions on major exchanges
   */
  @Cron('*/30 4-8 * * 1-5', { timeZone: 'America/New_York' }) // Every 30 min, 4AM-8AM EST (pre-market)
  @Cron('*/30 16-20 * * 1-5', { timeZone: 'America/New_York' }) // Every 30 min, 4PM-8PM EST (after-hours)
  async syncDuringExtendedHours(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Previous Alpaca sync job still running, skipping');
      return;
    }

    this.isRunning = true;
    this.logger.log('Starting scheduled Alpaca market data sync (extended hours)');

    try {
      const result = await this.stockTrendingService.syncMarketDataFromAlpaca();
      
      if (result.success) {
        this.logger.log(`Alpaca extended hours sync completed: ${result.updated} stocks updated`);
      } else {
        this.logger.warn(`Alpaca extended hours sync completed with issues: ${result.errors.join(', ')}`);
      }
    } catch (error: any) {
      this.logger.error(`Alpaca extended hours sync failed: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Light sync once per hour on weekends (market closed)
   * This ensures data doesn't get too stale over the weekend
   */
  @Cron('0 */1 * * 0,6', { timeZone: 'America/New_York' }) // Every hour on Saturday (6) and Sunday (0)
  async syncDuringWeekend(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Previous Alpaca sync job still running, skipping');
      return;
    }

    this.isRunning = true;
    this.logger.log('Starting scheduled Alpaca market data sync (weekend - light sync)');

    try {
      // On weekends, prices won't change much, but we still want to keep the connection alive
      const result = await this.stockTrendingService.syncMarketDataFromAlpaca();
      
      if (result.success) {
        this.logger.log(`Alpaca weekend sync completed: ${result.updated} stocks updated`);
      }
    } catch (error: any) {
      this.logger.error(`Alpaca weekend sync failed: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Manual trigger for immediate sync
   */
  async triggerManualSync(): Promise<{
    success: boolean;
    updated: number;
    errors: string[];
  }> {
    this.logger.log('Manual Alpaca market data sync triggered');
    return this.stockTrendingService.syncMarketDataFromAlpaca();
  }
}

