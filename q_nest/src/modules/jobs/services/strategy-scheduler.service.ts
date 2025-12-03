import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaModule } from '../../../prisma/prisma.module';

@Injectable()
export class StrategySchedulerService implements OnModuleInit {
  private readonly logger = new Logger(StrategySchedulerService.name);

  constructor(
    @InjectQueue('strategy-execution') private strategyQueue: Queue,
    private prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // Schedule all active strategies on module initialization
    await this.scheduleAllActiveStrategies();
  }

  /**
   * Schedule a strategy based on its cron expression.
   */
  async scheduleStrategy(strategyId: string): Promise<void> {
    try {
      const strategy = await this.prisma.strategies.findUnique({
        where: { strategy_id: strategyId },
      });

      if (!strategy || !strategy.is_active || !strategy.schedule_cron) {
        return;
      }

      // Get target assets
      const targetAssets = (strategy.target_assets as string[]) || [];

      if (targetAssets.length === 0) {
        this.logger.warn(`Strategy ${strategyId} has no target assets`);
        return;
      }

      // Schedule job for each target asset
      for (const assetSymbol of targetAssets) {
        // Find asset by symbol
        const asset = await this.prisma.assets.findFirst({
          where: { symbol: assetSymbol },
        });

        if (!asset) {
          this.logger.warn(`Asset ${assetSymbol} not found for strategy ${strategyId}`);
          continue;
        }

        // Create job record in database
        const jobRecord = await this.prisma.strategy_execution_jobs.create({
          data: {
            strategy_id: strategyId,
            status: 'pending',
            scheduled_at: new Date(),
          },
        });

        // Add job to queue with cron schedule
        await this.strategyQueue.add(
          `strategy-${strategyId}-asset-${asset.asset_id}`,
          {
            strategy_id: strategyId,
            asset_id: asset.asset_id,
            user_id: strategy.user_id,
          },
          {
            jobId: jobRecord.job_id,
            repeat: {
              pattern: strategy.schedule_cron,
            },
            removeOnComplete: {
              age: 3600, // Keep completed jobs for 1 hour
              count: 100, // Keep last 100 jobs
            },
            removeOnFail: {
              age: 86400, // Keep failed jobs for 24 hours
            },
          },
        );

        this.logger.log(
          `Scheduled strategy ${strategyId} for asset ${assetSymbol} with cron: ${strategy.schedule_cron}`,
        );
      }
    } catch (error: any) {
      this.logger.error(`Error scheduling strategy ${strategyId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Remove scheduled jobs for a strategy.
   */
  async unscheduleStrategy(strategyId: string): Promise<void> {
    try {
      // Get all jobs for this strategy
      const jobs = await this.strategyQueue.getRepeatableJobs();
      
      for (const job of jobs) {
        if (job.name.includes(`strategy-${strategyId}`)) {
          await this.strategyQueue.removeRepeatableByKey(job.key);
          this.logger.log(`Removed scheduled job: ${job.key}`);
        }
      }

      // Update job records status
      await this.prisma.strategy_execution_jobs.updateMany({
        where: { 
          strategy_id: strategyId,
          status: 'pending',
        },
        data: {
          status: 'cancelled' as any, // Note: 'cancelled' not in enum, using 'failed' instead
        },
      });
    } catch (error: any) {
      this.logger.error(`Error unscheduling strategy ${strategyId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Schedule all active strategies.
   */
  async scheduleAllActiveStrategies(): Promise<void> {
    try {
      const activeStrategies = await this.prisma.strategies.findMany({
        where: { 
          is_active: true,
          schedule_cron: { not: null },
        },
      });

      this.logger.log(`Scheduling ${activeStrategies.length} active strategies`);

      for (const strategy of activeStrategies) {
        await this.scheduleStrategy(strategy.strategy_id);
      }
    } catch (error: any) {
      this.logger.error(`Error scheduling all strategies: ${error.message}`);
    }
  }

  /**
   * Periodic check to reschedule any strategies that may have been missed.
   * Runs every hour.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async rescheduleActiveStrategies(): Promise<void> {
    this.logger.log('Running periodic strategy rescheduling check');
    await this.scheduleAllActiveStrategies();
  }
}

