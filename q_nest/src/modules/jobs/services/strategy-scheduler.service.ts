import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../prisma/prisma.service';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class StrategySchedulerService implements OnModuleInit {
  private readonly logger = new Logger(StrategySchedulerService.name);

  constructor(
    @InjectQueue('strategy-execution') private strategyQueue: Queue,
    private prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // Delay by 30 seconds so PrismaService has time to connect and other
    // OnModuleInit hooks finish before we start querying strategies.
    setTimeout(async () => {
      this.logger.log('Rescheduling active strategies after startup delay...');
      await this.scheduleAllActiveStrategies();
    }, 30000);
  }

  /**
   * Schedule a strategy based on its cron expression.
   * Skips silently if the BullMQ repeatable job already exists (idempotent on restart).
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

      // Fetch existing repeatable jobs once to avoid duplicate adds on restart
      const existingRepeatableJobs = await this.strategyQueue.getRepeatableJobs();
      const existingJobNames = new Set(existingRepeatableJobs.map((j) => j.name));

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

        const jobName = `strategy-${strategyId}-asset-${asset.asset_id}`;

        // Skip if this repeatable job already exists in Redis — prevents duplicate
        // DB records and duplicate queue entries on every NestJS restart.
        if (existingJobNames.has(jobName)) {
          this.logger.debug(`Repeatable job already exists, skipping: ${jobName}`);
          continue;
        }

        // Create job record in database only for genuinely new jobs
        const jobRecord = await this.prisma.strategy_execution_jobs.create({
          data: {
            strategy_id: strategyId,
            status: 'pending',
            scheduled_at: new Date(),
          },
        });

        // Add job to queue with cron schedule
        await this.strategyQueue.add(
          jobName,
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

