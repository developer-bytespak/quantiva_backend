import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QhqTokenService } from './qhq-token.service';

export const QHQ_QUEUE = 'qhq-rewards';

export const QHQ_JOBS = {
  MONTHLY_ALLOCATION: 'monthly-allocation',
  LOYALTY_BONUS: 'loyalty-bonus',
  UPDATE_MERKLE_ROOT: 'update-merkle-root',
} as const;

@Processor(QHQ_QUEUE)
@Injectable()
export class QhqTokenProcessor extends WorkerHost {
  private readonly logger = new Logger(QhqTokenProcessor.name);

  constructor(
    private qhqService: QhqTokenService,
    @InjectQueue(QHQ_QUEUE) private qhqQueue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<any> {
    this.logger.log(`Processing QHQ job: ${job.name}`);

    switch (job.name) {
      case QHQ_JOBS.MONTHLY_ALLOCATION:
        return this.qhqService.processMonthlyAllocations();

      case QHQ_JOBS.LOYALTY_BONUS:
        return this.qhqService.processLoyaltyBonuses();

      case QHQ_JOBS.UPDATE_MERKLE_ROOT:
        return this.qhqService.generateAndUpdateMerkleRoot();

      default:
        this.logger.warn(`Unknown QHQ job: ${job.name}`);
    }
  }

  // ─── Scheduled Triggers ────────────────────────────────────────────────

  /** Run on the 1st of every month at midnight */
  @Cron('0 0 1 * *')
  async scheduleMonthlyAllocation() {
    this.logger.log('Scheduling monthly QHQ allocation job...');
    await this.qhqQueue.add(QHQ_JOBS.MONTHLY_ALLOCATION, {}, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  /** Run daily at 9am to check loyalty bonuses */
  @Cron('0 9 * * *')
  async scheduleLoyaltyBonus() {
    await this.qhqQueue.add(QHQ_JOBS.LOYALTY_BONUS, {}, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  /** Run every Sunday at midnight to update Merkle root on-chain */
  @Cron('0 0 * * 0')
  async scheduleMerkleRootUpdate() {
    this.logger.log('Scheduling weekly Merkle root update...');
    await this.qhqQueue.add(QHQ_JOBS.UPDATE_MERKLE_ROOT, {}, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10000 },
    });
  }
}
