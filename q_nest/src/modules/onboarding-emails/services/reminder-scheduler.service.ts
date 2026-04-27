import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { OnboardingState, ReminderCampaign, ReminderStatus } from '../types';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  QUEUE_NAME,
  ReminderEntry,
  getDelayMultiplier,
} from '../config/schedule.config';

export interface OnboardingReminderJobData {
  reminderId: string;
}

@Injectable()
export class ReminderSchedulerService {
  private readonly logger = new Logger(ReminderSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAME) private readonly queue: Queue<OnboardingReminderJobData>,
  ) {}

  async enqueue(userId: string, entries: ReminderEntry[]): Promise<number> {
    if (entries.length === 0) return 0;

    const multiplier = getDelayMultiplier();
    const now = Date.now();

    let queued = 0;
    for (const entry of entries) {
      const delayMs = Math.round(entry.delaySeconds * 1000 * multiplier);
      const scheduledAt = new Date(now + delayMs);

      const reminder = await this.prisma.onboarding_email_reminders.create({
        data: {
          user_id: userId,
          onboarding_state: entry.state ?? OnboardingState.COMPLETED,
          campaign: entry.campaign,
          delay_label: entry.delayLabel,
          template_name: entry.templateName,
          bull_job_id: 'pending',
          status: ReminderStatus.QUEUED,
          scheduled_at: scheduledAt,
        },
      });

      const job = await this.queue.add(
        entry.templateName,
        { reminderId: reminder.id },
        { delay: delayMs, removeOnComplete: true, removeOnFail: false },
      );

      await this.prisma.onboarding_email_reminders.update({
        where: { id: reminder.id },
        data: { bull_job_id: String(job.id) },
      });

      queued++;
    }

    this.logger.log(`Queued ${queued} reminders for user ${userId}`);
    return queued;
  }

  async cancelByCampaignAndState(
    userId: string,
    campaign: ReminderCampaign,
    state: OnboardingState,
  ): Promise<number> {
    const rows = await this.prisma.onboarding_email_reminders.findMany({
      where: {
        user_id: userId,
        campaign,
        onboarding_state: state,
        status: ReminderStatus.QUEUED,
      },
    });

    return this.cancelRows(rows.map((r) => ({ id: r.id, bullJobId: r.bull_job_id })));
  }

  async cancelByCampaign(userId: string, campaign: ReminderCampaign): Promise<number> {
    const rows = await this.prisma.onboarding_email_reminders.findMany({
      where: {
        user_id: userId,
        campaign,
        status: ReminderStatus.QUEUED,
      },
    });

    return this.cancelRows(rows.map((r) => ({ id: r.id, bullJobId: r.bull_job_id })));
  }

  async cancelAll(userId: string): Promise<number> {
    const rows = await this.prisma.onboarding_email_reminders.findMany({
      where: { user_id: userId, status: ReminderStatus.QUEUED },
    });

    return this.cancelRows(rows.map((r) => ({ id: r.id, bullJobId: r.bull_job_id })));
  }

  private async cancelRows(rows: { id: string; bullJobId: string }[]): Promise<number> {
    if (rows.length === 0) return 0;

    for (const row of rows) {
      try {
        const job = await this.queue.getJob(row.bullJobId);
        if (job) await job.remove();
      } catch (error) {
        // Job may have already fired or been removed — pre-send check in the processor handles drift.
        this.logger.debug(`Bull job ${row.bullJobId} not removable: ${(error as Error).message}`);
      }
    }

    const result = await this.prisma.onboarding_email_reminders.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: ReminderStatus.CANCELLED, cancelled_at: new Date() },
    });

    this.logger.log(`Cancelled ${result.count} reminders`);
    return result.count;
  }
}
