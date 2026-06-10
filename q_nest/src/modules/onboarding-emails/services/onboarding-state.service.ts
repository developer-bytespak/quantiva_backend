import { Injectable, Logger } from '@nestjs/common';
import { OnboardingState, PlanTier, ReminderCampaign, ReminderStatus } from '../types';
import { PrismaService } from '../../../prisma/prisma.service';
import { ReminderSchedulerService } from './reminder-scheduler.service';
import { FreeUpgradeCampaignService } from './free-upgrade-campaign.service';
import { entriesForFunnelStage } from '../config/schedule.config';

const STATE_ORDER: OnboardingState[] = [
  OnboardingState.SIGNED_UP,
  OnboardingState.PERSONAL_INFO,
  OnboardingState.KYC,
  OnboardingState.PAID,
  OnboardingState.CONNECT_EXCHANGE,
  OnboardingState.COMPLETED,
];

@Injectable()
export class OnboardingStateService {
  private readonly logger = new Logger(OnboardingStateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ReminderSchedulerService,
    private readonly freeUpgradeCampaign: FreeUpgradeCampaignService,
  ) {}

  async advanceTo(userId: string, newState: OnboardingState): Promise<void> {
    const user = await this.prisma.users.findUnique({
      where: { user_id: userId },
      select: {
        user_id: true,
        onboarding_state: true,
        onboarding_emails_opted_out: true,
        current_tier: true,
      },
    });

    if (!user) {
      this.logger.warn(`advanceTo called for unknown user ${userId}`);
      return;
    }

    // Regression guard — never move backwards. Equal state is allowed (covers the SIGNED_UP
    // initial-signup case where the column default already matches).
    if (STATE_ORDER.indexOf(newState) < STATE_ORDER.indexOf(user.onboarding_state)) {
      this.logger.debug(
        `Skipping advanceTo for user ${userId}: ${user.onboarding_state} -> ${newState} (regression)`,
      );
      return;
    }

    const isStateChange = newState !== user.onboarding_state;

    if (isStateChange) {
      await this.prisma.users.update({
        where: { user_id: userId },
        data: { onboarding_state: newState },
      });
    }

    // Email-scheduler work below depends on Redis (the BullMQ queue). The onboarding
    // state has already been persisted above, so a Redis failure here must NOT bubble
    // up and 500 the caller (signup, personal-info, KYC, exchange-connect, etc.).
    // We swallow + log it; the only consequence is that reminder emails aren't
    // (re)scheduled, which self-heals once Redis is healthy again.
    try {
      let cancelled = 0;
      if (isStateChange) {
        cancelled = await this.scheduler.cancelByCampaignAndState(
          userId,
          ReminderCampaign.FUNNEL,
          user.onboarding_state,
        );
      }

      let queued = 0;
      if (!user.onboarding_emails_opted_out) {
        const alreadyQueued = await this.prisma.onboarding_email_reminders.count({
          where: {
            user_id: userId,
            campaign: ReminderCampaign.FUNNEL,
            onboarding_state: newState,
            status: ReminderStatus.QUEUED,
          },
        });
        if (alreadyQueued === 0) {
          queued = await this.scheduler.enqueue(userId, entriesForFunnelStage(newState));
        }
      }

      this.logger.log(
        `User ${userId} advanced ${user.onboarding_state} -> ${newState} (cancelled=${cancelled}, queued=${queued})`,
      );

      // Engine 2 auto-start: when the funnel completes on the FREE tier, kick off the upgrade drip.
      // start() internally checks for prior FREE_UPGRADE rows and no-ops if it has already run.
      if (newState === OnboardingState.COMPLETED && user.current_tier === PlanTier.FREE) {
        await this.freeUpgradeCampaign.start(userId);
      }
    } catch (error: any) {
      this.logger.error(
        `Email-scheduler step failed for user ${userId} (state ${newState}); onboarding state was still saved. Error: ${error?.message ?? error}`,
      );
    }
  }
}
