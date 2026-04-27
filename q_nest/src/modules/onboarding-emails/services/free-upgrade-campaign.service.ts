import { Injectable, Logger } from '@nestjs/common';
import { PlanTier, ReminderCampaign } from '../types';
import { PrismaService } from '../../../prisma/prisma.service';
import { ReminderSchedulerService } from './reminder-scheduler.service';
import { entriesForFreeUpgrade } from '../config/schedule.config';

@Injectable()
export class FreeUpgradeCampaignService {
  private readonly logger = new Logger(FreeUpgradeCampaignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ReminderSchedulerService,
  ) {}

  // Starts the free-upgrade drip for a user. No-op if the campaign has ever run for this user
  // before — the existence of any FREE_UPGRADE row (any status) is the no-restart marker.
  async start(userId: string): Promise<{ started: boolean; reason?: string }> {
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: { onboarding_emails_opted_out: true, current_tier: true },
    });

    if (!user) return { started: false, reason: 'user_not_found' };
    if (user.onboarding_emails_opted_out) return { started: false, reason: 'opted_out' };
    if (user.current_tier !== PlanTier.FREE) return { started: false, reason: 'not_on_free_tier' };

    const priorCount = await this.prisma.onboarding_email_reminders.count({
      where: { user_id: userId, campaign: ReminderCampaign.FREE_UPGRADE },
    });

    if (priorCount > 0) {
      this.logger.log(`Free-upgrade campaign already ran for user ${userId} — skipping`);
      return { started: false, reason: 'already_ran' };
    }

    await this.scheduler.enqueue(userId, entriesForFreeUpgrade());
    this.logger.log(`Free-upgrade campaign started for user ${userId}`);
    return { started: true };
  }

  async stop(userId: string): Promise<number> {
    return this.scheduler.cancelByCampaign(userId, ReminderCampaign.FREE_UPGRADE);
  }
}
