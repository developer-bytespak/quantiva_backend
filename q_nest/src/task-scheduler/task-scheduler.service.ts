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
  signalsDeleted: number;
  signalDetailsDeleted: number;
  signalExplanationsDeleted: number;
  assetMetricsDeleted: number;
  strategyJobsDeleted: number;
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
  private readonly SIGNAL_RETENTION_DAYS: number;
  private readonly METRICS_RETENTION_DAYS: number;
  private readonly JOBS_RETENTION_DAYS: number;
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
    this.SIGNAL_RETENTION_DAYS = parseInt(
      this.configService.get<string>('SIGNAL_RETENTION_DAYS') || '30',
      10,
    );
    this.METRICS_RETENTION_DAYS = parseInt(
      this.configService.get<string>('METRICS_RETENTION_DAYS') || '90',
      10,
    );
    this.JOBS_RETENTION_DAYS = parseInt(
      this.configService.get<string>('JOBS_RETENTION_DAYS') || '14',
      10,
    );
    this.CLEANUP_BATCH_SIZE = parseInt(
      this.configService.get<string>('CLEANUP_BATCH_SIZE') || '100',
      10,
    );

    this.logger.log(
      `Task Scheduler initialized: news/assets=${this.DATA_RETENTION_DAYS}d, signals=${this.SIGNAL_RETENTION_DAYS}d, metrics=${this.METRICS_RETENTION_DAYS}d, jobs=${this.JOBS_RETENTION_DAYS}d, batch=${this.CLEANUP_BATCH_SIZE}`,
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
      signalsDeleted: 0,
      signalDetailsDeleted: 0,
      signalExplanationsDeleted: 0,
      assetMetricsDeleted: 0,
      strategyJobsDeleted: 0,
      errors: [],
    };

    try {
      // Cutoff for news/trending_assets
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.DATA_RETENTION_DAYS);
      const signalCutoff = new Date();
      signalCutoff.setDate(signalCutoff.getDate() - this.SIGNAL_RETENTION_DAYS);
      const metricsCutoff = new Date();
      metricsCutoff.setDate(metricsCutoff.getDate() - this.METRICS_RETENTION_DAYS);
      const jobsCutoff = new Date();
      jobsCutoff.setDate(jobsCutoff.getDate() - this.JOBS_RETENTION_DAYS);

      this.logger.log(
        `Cleaning up: news/assets < ${cutoffDate.toISOString()}, signals < ${signalCutoff.toISOString()}, metrics < ${metricsCutoff.toISOString()}, jobs < ${jobsCutoff.toISOString()}`,
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

      // Cleanup signal_details (child of strategy_signals) - before strategy_signals
      try {
        metrics.signalDetailsDeleted = await this.cleanupSignalDetails(signalCutoff);
      } catch (error: any) {
        this.logger.error('Error cleaning up signal_details', error);
        metrics.errors.push(`signal_details: ${error.message}`);
      }

      // Cleanup signal_explanations (child of strategy_signals)
      try {
        metrics.signalExplanationsDeleted = await this.cleanupSignalExplanations(signalCutoff);
      } catch (error: any) {
        this.logger.error('Error cleaning up signal_explanations', error);
        metrics.errors.push(`signal_explanations: ${error.message}`);
      }

      // Cleanup strategy_signals (parent)
      try {
        metrics.signalsDeleted = await this.cleanupStrategySignals(signalCutoff);
      } catch (error: any) {
        this.logger.error('Error cleaning up strategy_signals', error);
        metrics.errors.push(`strategy_signals: ${error.message}`);
      }

      // Cleanup asset_metrics
      try {
        metrics.assetMetricsDeleted = await this.cleanupAssetMetrics(metricsCutoff);
      } catch (error: any) {
        this.logger.error('Error cleaning up asset_metrics', error);
        metrics.errors.push(`asset_metrics: ${error.message}`);
      }

      // Cleanup strategy_execution_jobs (completed/failed older than JOBS_RETENTION_DAYS)
      try {
        metrics.strategyJobsDeleted = await this.cleanupStrategyExecutionJobs(jobsCutoff);
      } catch (error: any) {
        this.logger.error('Error cleaning up strategy_execution_jobs', error);
        metrics.errors.push(`strategy_execution_jobs: ${error.message}`);
      }

      // Calculate final metrics
      metrics.endTime = new Date();
      metrics.durationMs = metrics.endTime.getTime() - startTime.getTime();

      this.logger.log(
        `Cleanup completed: news=${metrics.newsDeleted}, assets=${metrics.trendingAssetsDeleted}, signals=${metrics.signalsDeleted}, details=${metrics.signalDetailsDeleted}, explanations=${metrics.signalExplanationsDeleted}, metrics=${metrics.assetMetricsDeleted}, jobs=${metrics.strategyJobsDeleted} in ${metrics.durationMs}ms`,
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
   * Cleanup signal_details for signals older than cutoff (FK: must run before strategy_signals)
   */
  private async cleanupSignalDetails(cutoffDate: Date): Promise<number> {
    const result = await this.prisma.signal_details.deleteMany({
      where: {
        signal: {
          timestamp: { lt: cutoffDate },
        },
      },
    });
    this.logger.log(`Deleted ${result.count} signal_details (signals older than ${this.SIGNAL_RETENTION_DAYS} days)`);
    return result.count;
  }

  /**
   * Cleanup signal_explanations for signals older than cutoff (FK: must run before strategy_signals)
   */
  private async cleanupSignalExplanations(cutoffDate: Date): Promise<number> {
    const result = await this.prisma.signal_explanations.deleteMany({
      where: {
        signal: {
          timestamp: { lt: cutoffDate },
        },
      },
    });
    this.logger.log(`Deleted ${result.count} signal_explanations (signals older than ${this.SIGNAL_RETENTION_DAYS} days)`);
    return result.count;
  }

  /**
   * Cleanup strategy_signals older than cutoff (run after details & explanations)
   */
  private async cleanupStrategySignals(cutoffDate: Date): Promise<number> {
    let totalDeleted = 0;
    let hasMore = true;
    while (hasMore) {
      const batch = await this.prisma.strategy_signals.findMany({
        where: { timestamp: { lt: cutoffDate } },
        select: { signal_id: true },
        take: this.CLEANUP_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      const result = await this.prisma.strategy_signals.deleteMany({
        where: { signal_id: { in: batch.map((s) => s.signal_id) } },
      });
      totalDeleted += result.count;
      if (result.count < this.CLEANUP_BATCH_SIZE) hasMore = false;
      await this.sleep(100);
    }
    this.logger.log(`Deleted ${totalDeleted} strategy_signals (older than ${this.SIGNAL_RETENTION_DAYS} days)`);
    return totalDeleted;
  }

  /**
   * Cleanup asset_metrics older than cutoff (metric_date)
   */
  private async cleanupAssetMetrics(cutoffDate: Date): Promise<number> {
    let totalDeleted = 0;
    let hasMore = true;
    while (hasMore) {
      const batch = await this.prisma.asset_metrics.findMany({
        where: { metric_date: { lt: cutoffDate } },
        select: { metric_id: true },
        take: this.CLEANUP_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      const del = await this.prisma.asset_metrics.deleteMany({
        where: { metric_id: { in: batch.map((m) => m.metric_id) } },
      });
      totalDeleted += del.count;
      if (del.count < this.CLEANUP_BATCH_SIZE) hasMore = false;
      await this.sleep(100);
    }
    this.logger.log(`Deleted ${totalDeleted} asset_metrics (older than ${this.METRICS_RETENTION_DAYS} days)`);
    return totalDeleted;
  }

  /**
   * Cleanup completed/failed strategy_execution_jobs older than cutoff
   */
  private async cleanupStrategyExecutionJobs(cutoffDate: Date): Promise<number> {
    const result = await this.prisma.strategy_execution_jobs.deleteMany({
      where: {
        status: { in: ['completed', 'failed'] },
        OR: [
          { completed_at: { lt: cutoffDate } },
          {
            AND: [
              { completed_at: { equals: null } },
              { scheduled_at: { lt: cutoffDate } },
            ],
          },
        ],
      },
    });
    this.logger.log(`Deleted ${result.count} strategy_execution_jobs (completed/failed older than ${this.JOBS_RETENTION_DAYS} days)`);
    return result.count;
  }

  /**
   * Get cleanup status
   */
  getStatus() {
    return {
      isRunning: this.isCleanupRunning,
      configuration: {
        dataRetentionDays: this.DATA_RETENTION_DAYS,
        signalRetentionDays: this.SIGNAL_RETENTION_DAYS,
        metricsRetentionDays: this.METRICS_RETENTION_DAYS,
        jobsRetentionDays: this.JOBS_RETENTION_DAYS,
        batchSize: this.CLEANUP_BATCH_SIZE,
      },
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
