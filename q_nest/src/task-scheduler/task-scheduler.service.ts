import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export interface CleanupMetrics {
  startTime: Date;
  endTime: Date;
  durationMs: number;
  newsDeleted: number;
  trendingAssetsDeleted: number;
  errors: string[];
}

/**
 * Task Scheduler Service
 * Handles automated cleanup of old data
 */
@Injectable()
export class TaskSchedulerService {
  private readonly logger = new Logger(TaskSchedulerService.name);
  private readonly DATA_RETENTION_DAYS: number;
  private readonly CLEANUP_BATCH_SIZE: number;
  private isCleanupRunning = false;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.DATA_RETENTION_DAYS = parseInt(
      this.configService.get<string>('DATA_RETENTION_DAYS') || '5',
      10,
    );
    this.CLEANUP_BATCH_SIZE = parseInt(
      this.configService.get<string>('CLEANUP_BATCH_SIZE') || '100',
      10,
    );

    this.logger.log(
      `Task Scheduler initialized: retention=${this.DATA_RETENTION_DAYS} days, batch=${this.CLEANUP_BATCH_SIZE}`,
    );
  }

  /**
   * Scheduled cleanup job - runs daily at 2 AM
   */
  @Cron('0 2 * * *', {
    name: 'daily-cleanup',
    timeZone: 'UTC',
  })
  async handleScheduledCleanup() {
    this.logger.log('Starting scheduled cleanup...');
    await this.runCleanup();
  }

  /**
   * Manual cleanup trigger (for testing/admin use)
   */
  async triggerManualCleanup(): Promise<CleanupMetrics> {
    this.logger.log('Manual cleanup triggered');
    return await this.runCleanup();
  }

  /**
   * Main cleanup logic
   */
  private async runCleanup(): Promise<CleanupMetrics> {
    if (this.isCleanupRunning) {
      this.logger.warn('Cleanup already running, skipping...');
      throw new Error('Cleanup already in progress');
    }

    this.isCleanupRunning = true;
    const startTime = new Date();
    const metrics: CleanupMetrics = {
      startTime,
      endTime: new Date(),
      durationMs: 0,
      newsDeleted: 0,
      trendingAssetsDeleted: 0,
      errors: [],
    };

    try {
      // Calculate cutoff date
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.DATA_RETENTION_DAYS);

      this.logger.log(
        `Cleaning up data older than ${cutoffDate.toISOString()} (${this.DATA_RETENTION_DAYS} days ago)`,
      );

      // Cleanup trending_news in batches
      try {
        metrics.newsDeleted = await this.cleanupTrendingNews(cutoffDate);
      } catch (error: any) {
        this.logger.error('Error cleaning up trending_news', error);
        metrics.errors.push(`trending_news: ${error.message}`);
      }

      // Cleanup trending_assets in batches
      try {
        metrics.trendingAssetsDeleted = await this.cleanupTrendingAssets(
          cutoffDate,
        );
      } catch (error: any) {
        this.logger.error('Error cleaning up trending_assets', error);
        metrics.errors.push(`trending_assets: ${error.message}`);
      }

      // Calculate final metrics
      metrics.endTime = new Date();
      metrics.durationMs = metrics.endTime.getTime() - startTime.getTime();

      this.logger.log(
        `Cleanup completed: ${metrics.newsDeleted} news, ${metrics.trendingAssetsDeleted} assets deleted in ${metrics.durationMs}ms`,
      );

      if (metrics.errors.length > 0) {
        this.logger.warn(
          `Cleanup completed with ${metrics.errors.length} errors`,
        );
      }

      return metrics;
    } catch (error: any) {
      this.logger.error('Cleanup failed with critical error', error);
      metrics.errors.push(`Critical: ${error.message}`);
      metrics.endTime = new Date();
      metrics.durationMs = metrics.endTime.getTime() - startTime.getTime();
      throw error;
    } finally {
      this.isCleanupRunning = false;
    }
  }

  /**
   * Cleanup trending_news table in batches
   */
  private async cleanupTrendingNews(cutoffDate: Date): Promise<number> {
    let totalDeleted = 0;
    let hasMore = true;
    let batchCount = 0;

    while (hasMore) {
      try {
        // Find IDs to delete (poll_timestamp + asset_id composite key)
        const recordsToDelete = await this.prisma.trending_news.findMany({
          where: {
            poll_timestamp: {
              lt: cutoffDate,
            },
          },
          select: {
            poll_timestamp: true,
            asset_id: true,
          },
          take: this.CLEANUP_BATCH_SIZE,
        });

        if (recordsToDelete.length === 0) {
          hasMore = false;
          break;
        }

        // Delete in batch
        const deleteResult = await this.prisma.trending_news.deleteMany({
          where: {
            OR: recordsToDelete.map((record) => ({
              poll_timestamp: record.poll_timestamp,
              asset_id: record.asset_id,
            })),
          },
        });

        const deleted = deleteResult.count;
        totalDeleted += deleted;
        batchCount++;

        this.logger.debug(
          `Batch ${batchCount}: Deleted ${deleted} trending_news records`,
        );

        // If we deleted fewer than the batch size, we're done
        if (deleted < this.CLEANUP_BATCH_SIZE) {
          hasMore = false;
        }

        // Small delay between batches to avoid overwhelming the database
        await this.sleep(100);
      } catch (error: any) {
        this.logger.error(
          `Error in batch ${batchCount} of trending_news cleanup`,
          error,
        );
        throw error;
      }
    }

    this.logger.log(
      `Deleted ${totalDeleted} trending_news records in ${batchCount} batches`,
    );
    return totalDeleted;
  }

  /**
   * Cleanup trending_assets table in batches
   */
  private async cleanupTrendingAssets(cutoffDate: Date): Promise<number> {
    let totalDeleted = 0;
    let hasMore = true;
    let batchCount = 0;

    while (hasMore) {
      try {
        // Find IDs to delete (poll_timestamp + asset_id composite key)
        const recordsToDelete = await this.prisma.trending_assets.findMany({
          where: {
            poll_timestamp: {
              lt: cutoffDate,
            },
          },
          select: {
            poll_timestamp: true,
            asset_id: true,
          },
          take: this.CLEANUP_BATCH_SIZE,
        });

        if (recordsToDelete.length === 0) {
          hasMore = false;
          break;
        }

        // Delete in batch
        const deleteResult = await this.prisma.trending_assets.deleteMany({
          where: {
            OR: recordsToDelete.map((record) => ({
              poll_timestamp: record.poll_timestamp,
              asset_id: record.asset_id,
            })),
          },
        });

        const deleted = deleteResult.count;
        totalDeleted += deleted;
        batchCount++;

        this.logger.debug(
          `Batch ${batchCount}: Deleted ${deleted} trending_assets records`,
        );

        // If we deleted fewer than the batch size, we're done
        if (deleted < this.CLEANUP_BATCH_SIZE) {
          hasMore = false;
        }

        // Small delay between batches to avoid overwhelming the database
        await this.sleep(100);
      } catch (error: any) {
        this.logger.error(
          `Error in batch ${batchCount} of trending_assets cleanup`,
          error,
        );
        throw error;
      }
    }

    this.logger.log(
      `Deleted ${totalDeleted} trending_assets records in ${batchCount} batches`,
    );
    return totalDeleted;
  }

  /**
   * Get cleanup status
   */
  getStatus() {
    return {
      isRunning: this.isCleanupRunning,
      configuration: {
        retentionDays: this.DATA_RETENTION_DAYS,
        batchSize: this.CLEANUP_BATCH_SIZE,
      },
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
