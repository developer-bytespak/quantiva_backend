import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StocksMarketService } from '../stocks-market.service';

@Injectable()
export class MarketSyncCronService implements OnModuleInit {
  private readonly logger = new Logger(MarketSyncCronService.name);
  private isRunning = false;
  private lastSyncTime: Date | null = null;
  private lastSyncStatus: 'success' | 'failed' | 'idle' = 'idle';
  private syncCount = 0;

  constructor(private stocksMarketService: StocksMarketService) {}

  /**
   * Run initial sync when module initializes
   */
  async onModuleInit() {
    this.logger.log('Market Sync Cron Service initialized');

    // Run initial sync after 10 seconds
    setTimeout(async () => {
      this.logger.log('Running initial market data sync...');
      await this.syncMarketData();
    }, 10000);
  }

  /**
   * Cron job: Sync market data every 20 minutes
   * Runs every 20 minutes at 0, 20, and 40 minutes past each hour
   */
  @Cron('*/20 * * * *', {
    name: 'market-data-sync',
    timeZone: 'UTC',
  })
  async handleCron() {
    await this.syncMarketData();
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
        this.logger.log(
          `✓ Market sync completed successfully in ${duration}ms - ${result.synced} stocks synced`,
        );

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
    // Calculate next run time (20 minutes from last sync)
    let nextRunIn: string | undefined;
    if (this.lastSyncTime) {
      const nextRun = new Date(
        this.lastSyncTime.getTime() + 20 * 60 * 1000,
      );
      const now = new Date();
      const diffMs = nextRun.getTime() - now.getTime();

      if (diffMs > 0) {
        const minutes = Math.floor(diffMs / 60000);
        const seconds = Math.floor((diffMs % 60000) / 1000);
        nextRunIn = `${minutes}m ${seconds}s`;
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
