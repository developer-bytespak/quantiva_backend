import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CoinDetailsCacheService } from '../services/coin-details-cache.service';

@Injectable()
export class CoinDetailsSyncCron {
  private readonly logger = new Logger(CoinDetailsSyncCron.name);
  private isSyncing = false;

  constructor(
    private coinDetailsCacheService: CoinDetailsCacheService,
  ) {}

  /**
   * Sync top 200 coins every 12 hours
   * Runs at: 00:00, 12:00
   */
  @Cron('0 */12 * * *', {
    name: 'sync-top-coins',
    timeZone: 'UTC',
  })
  async syncTopCoins() {
    if (this.isSyncing) {
      this.logger.warn('Previous sync still running, skipping this run');
      return;
    }

    this.isSyncing = true;
    const startTime = Date.now();
    
    try {
      this.logger.log('Starting scheduled sync of top 200 coins...');
      
      const result = await this.coinDetailsCacheService.syncTopCoins(200);
      
      const duration = Math.round((Date.now() - startTime) / 1000);
      this.logger.log(
        `Scheduled coin sync completed in ${duration}s: ${result.success} success, ${result.failed} failed`,
      );
    } catch (error: any) {
      this.logger.error('Scheduled coin sync failed', {
        error: error.message,
        stack: error.stack,
      });
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Refresh stale coins every 6 hours.
   * Runs at: 03:00, 09:00, 15:00, 21:00 UTC.
   *
   * Combined with the 12-hour STALE_THRESHOLD in CoinDetailsCacheService,
   * this gives each coin at most 6 hours between going stale and being
   * refreshed, while halving the previous (every-3-hour) call rate.
   */
  @Cron('0 3,9,15,21 * * *', {
    name: 'refresh-stale-coins',
    timeZone: 'UTC',
  })
  async refreshStaleCoins() {
    try {
      this.logger.log('Starting refresh of stale coins...');
      
      const result = await this.coinDetailsCacheService.refreshStaleCoins(50);
      
      this.logger.log(
        `Stale coin refresh completed: ${result.success} success, ${result.failed} failed`,
      );
    } catch (error: any) {
      this.logger.error('Stale coin refresh failed', {
        error: error.message,
      });
    }
  }

  /**
   * Log cache statistics every hour
   */
  @Cron(CronExpression.EVERY_HOUR, {
    name: 'log-cache-stats',
    timeZone: 'UTC',
  })
  async logCacheStats() {
    try {
      const stats = await this.coinDetailsCacheService.getCacheStats();
      
      this.logger.log('Coin Details Cache Stats:', {
        totalCoins: stats.totalCoins,
        freshCoins: stats.freshCoins,
        staleCoins: stats.staleCoins,
        freshPercentage: stats.totalCoins > 0 
          ? Math.round((stats.freshCoins / stats.totalCoins) * 100) 
          : 0,
        oldestUpdate: stats.oldestUpdate,
      });
    } catch (error: any) {
      this.logger.error('Failed to get cache stats', {
        error: error.message,
      });
    }
  }
}
