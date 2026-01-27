import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StocksMarketService } from '../stocks-market.service';
import { MarketStocksDbService } from './market-stocks-db.service';

@Injectable()
export class MarketSyncCronService implements OnModuleInit {
  private readonly logger = new Logger(MarketSyncCronService.name);
  private isRunning = false;
  private lastSyncTime: Date | null = null;
  private lastSyncStatus: 'success' | 'failed' | 'idle' = 'idle';
  private syncCount = 0;

  constructor(
    private stocksMarketService: StocksMarketService,
    private dbService: MarketStocksDbService,
  ) {}

  /**
   * Run initial sync when module initializes
   * Automatically fetches S&P 500 list from FMP if database is empty or has too few stocks
   */
  async onModuleInit() {
    this.logger.log('Market Sync Cron Service initialized');

    // Wait 10 seconds for services to be ready, then check and initialize
    setTimeout(async () => {
      try {
        const stockCount = await this.dbService.getCount();
        const activeSymbolsCount =
          await this.stocksMarketService.getActiveStockSymbolsCount();

        // If we have very few stocks (< 100), automatically fetch from FMP
        if (activeSymbolsCount < 100) {
          this.logger.log(
            `Found only ${activeSymbolsCount} stocks in database. Automatically fetching S&P 500 list from FMP...`,
          );

          try {
            // Fetch S&P 500 list from FMP and trigger sync automatically
            const refreshResult =
              await this.stocksMarketService.refreshSP500ListFromFMP(true);

            if (refreshResult.success) {
              let logMessage = `✓ S&P 500 list fetched: ${refreshResult.stored} new, ${refreshResult.updated} updated, ${refreshResult.total} total`;
              if (refreshResult.deactivated > 0) {
                logMessage += `, ${refreshResult.deactivated} removed stocks deactivated`;
              }
              this.logger.log(logMessage);
              if (refreshResult.syncTriggered) {
                this.logger.log(
                  '✓ Market data sync completed for all S&P 500 stocks',
                );
              }
            } else {
              this.logger.warn(
                `⚠ Failed to fetch S&P 500 list: ${refreshResult.message}. Using existing stocks.`,
              );
            }
          } catch (refreshError: any) {
            this.logger.error(
              'Failed to automatically fetch S&P 500 list on startup',
              {
                error: refreshError?.message,
              },
            );
            // Continue with existing stocks - don't fail startup
          }
        } else {
          this.logger.log(
            `Found ${activeSymbolsCount} stocks in database. Sync will use these stocks.`,
          );
        }

        // Run initial sync after refresh (or if refresh wasn't needed)
        this.logger.log('Running initial market data sync...');
        await this.syncMarketData();
      } catch (error: any) {
        this.logger.error('Error during module initialization', {
          error: error?.message,
          stack: error?.stack,
        });
        // Don't throw - allow service to continue running
      }
    }, 10000);
  }

  /**
   * Cron job: Sync market data once per day
   * Runs daily at 2:00 AM UTC (after market close in US)
   * Note: Syncs all available stocks in one batch to minimize FMP API calls
   * This reduces FMP API usage from every 20 minutes to once per day
   */
  @Cron('0 2 * * *', {
    name: 'market-data-sync',
    timeZone: 'UTC',
  })
  async handleCron() {
    await this.syncMarketData();
  }

  /**
   * Cron job: Clean up old market rankings data daily at 3 AM UTC
   * Keeps only the last 7 days of data to save storage
   */
  @Cron('0 3 * * *', {
    name: 'market-rankings-cleanup',
    timeZone: 'UTC',
  })
  async handleCleanup() {
    try {
      this.logger.log('===== Starting market rankings cleanup =====');
      const deletedCount = await this.dbService.cleanupOldRankings(7);
      this.logger.log(
        `✓ Cleanup completed - removed ${deletedCount} old records`,
      );
      this.logger.log('===== Market rankings cleanup completed =====');
    } catch (error: any) {
      this.logger.error('Market rankings cleanup failed', {
        error: error?.message,
        stack: error?.stack,
      });
    }
  }

  /**
   * Cron job: Refresh S&P 500 list from FMP API monthly
   * Runs on the 1st day of each month at 2 AM UTC
   * This ensures the S&P 500 list stays up-to-date with any changes
   */
  @Cron('0 2 1 * *', {
    name: 'sp500-list-refresh',
    timeZone: 'UTC',
  })
  async handleSP500ListRefresh() {
    try {
      this.logger.log('===== Starting monthly S&P 500 list refresh =====');
      
      const result = await this.stocksMarketService.refreshSP500ListFromFMP();
      
      if (result.success) {
        this.logger.log(
          `✓ S&P 500 list refreshed: ${result.stored} new, ${result.updated} updated, ${result.total} total`,
        );
      } else {
        this.logger.warn(
          `⚠ S&P 500 list refresh failed: ${result.message}`,
        );
      }
      
      this.logger.log('===== Monthly S&P 500 list refresh completed =====');
    } catch (error: any) {
      this.logger.error('Monthly S&P 500 list refresh failed', {
        error: error?.message,
        stack: error?.stack,
      });
    }
  }

  /**
   * Execute market data sync with locking to prevent overlapping runs
   */
  private async syncMarketData(): Promise<void> {
    // Prevent concurrent runs
    if (this.isRunning) {
      this.logger.warn('Sync already running, skipping...');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      this.logger.log('===== Starting scheduled market data sync =====');

      // Execute sync
      const result = await this.stocksMarketService.syncMarketData();

      const duration = Date.now() - startTime;
      this.lastSyncTime = new Date();
      this.syncCount++;

      if (result.success) {
        this.lastSyncStatus = 'success';
        const logMessage = `✓ Market sync completed successfully in ${duration}ms - ${result.syncedToday} stocks synced`;
        const totalMessage = result.totalStocks > 0 
          ? ` (${result.totalStocks} total stocks in database, all synced in one batch)`
          : '';
        this.logger.log(logMessage + totalMessage);

        if (result.warnings.length > 0) {
          this.logger.warn('Sync completed with warnings:', result.warnings);
        }
      } else {
        this.lastSyncStatus = 'failed';
        this.logger.error(
          `✗ Market sync failed after ${duration}ms`,
          result.warnings,
        );
      }

      this.logger.log('===== Market data sync completed =====');
    } catch (error: any) {
      this.lastSyncStatus = 'failed';
      this.logger.error('Market sync encountered an error', {
        error: error?.message,
        stack: error?.stack,
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get sync status (for monitoring)
   */
  getSyncStatus(): {
    isRunning: boolean;
    lastSyncTime: Date | null;
    lastSyncStatus: 'success' | 'failed' | 'idle';
    syncCount: number;
    nextRunIn?: string;
  } {
    // Calculate next run time (24 hours from last sync, or next 2 AM UTC)
    let nextRunIn: string | undefined;
    if (this.lastSyncTime) {
      // Calculate next 2 AM UTC
      const now = new Date();
      const nextRun = new Date(now);
      nextRun.setUTCHours(2, 0, 0, 0);
      
      // If it's already past 2 AM today, schedule for tomorrow
      if (nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 1);
      }
      
      const diffMs = nextRun.getTime() - now.getTime();

      if (diffMs > 0) {
        const hours = Math.floor(diffMs / (60 * 60 * 1000));
        const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / 60000);
        nextRunIn = `${hours}h ${minutes}m`;
      } else {
        nextRunIn = 'Running soon...';
      }
    }

    return {
      isRunning: this.isRunning,
      lastSyncTime: this.lastSyncTime,
      lastSyncStatus: this.lastSyncStatus,
      syncCount: this.syncCount,
      nextRunIn,
    };
  }

  /**
   * Force sync manually (for testing or admin trigger)
   */
  async forceSyncNow(): Promise<void> {
    this.logger.log('Manual sync triggered');
    await this.syncMarketData();
  }
}
