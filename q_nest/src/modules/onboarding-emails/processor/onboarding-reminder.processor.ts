import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PlanTier, ReminderCampaign, ReminderStatus } from '../types';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmailSenderService } from '../services/email-sender.service';
import { TemplateRendererService } from '../services/template-renderer.service';
import { UnsubscribeTokenService } from '../services/unsubscribe-token.service';
import { QUEUE_NAME } from '../config/schedule.config';
import type { OnboardingReminderJobData } from '../services/reminder-scheduler.service';

@Processor(QUEUE_NAME)
@Injectable()
export class OnboardingReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(OnboardingReminderProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: EmailSenderService,
    private readonly renderer: TemplateRendererService,
    private readonly unsubscribeToken: UnsubscribeTokenService,
  ) {
    super();
  }

  async process(job: Job<OnboardingReminderJobData>): Promise<void> {
    if (process.env.DRIP_ENABLED === 'false') {
      this.logger.warn(`DRIP_ENABLED=false — skipping job ${job.id}`);
      return;
    }

    const { reminderId } = job.data;

    const reminder = await this.prisma.onboarding_email_reminders.findUnique({
      where: { id: reminderId },
      include: {
        user: {
          select: {
            user_id: true,
            email: true,
            full_name: true,
            username: true,
            onboarding_state: true,
            onboarding_emails_opted_out: true,
            current_tier: true,
          },
        },
      },
    });

    if (!reminder) {
      this.logger.warn(`Reminder ${reminderId} not found — already deleted`);
      return;
    }

    // Pre-send safety checks — any drift between Bull and DB lands here.
    if (reminder.status !== ReminderStatus.QUEUED) {
      this.logger.debug(`Reminder ${reminderId} no longer QUEUED (status=${reminder.status}) — skip`);
      return;
    }
    if (reminder.user.onboarding_emails_opted_out) {
      await this.markCancelled(reminderId, 'opted_out');
      return;
    }
    if (
      reminder.campaign === ReminderCampaign.FUNNEL &&
      reminder.user.onboarding_state !== reminder.onboarding_state
    ) {
      await this.markCancelled(reminderId, 'state_mismatch');
      return;
    }
    if (
      reminder.campaign === ReminderCampaign.FREE_UPGRADE &&
      reminder.user.current_tier !== PlanTier.FREE
    ) {
      await this.markCancelled(reminderId, 'no_longer_free');
      return;
    }

    const token = await this.unsubscribeToken.sign(reminder.user.user_id);
    const unsubscribeUrl = this.unsubscribeToken.buildUrl(reminder.user.user_id, token);
    const dashboardUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard`;
    const firstName = (reminder.user.full_name?.split(' ')[0] || reminder.user.username || 'there').trim();

    // Tier-aware template variant: prefer `<name>_free` for free-tier users when one exists.
    let templateName = reminder.template_name;
    if (reminder.user.current_tier === PlanTier.FREE) {
      const freeVariant = `${templateName}_free`;
      if (await this.renderer.exists(freeVariant)) {
        templateName = freeVariant;
      }
    }

    let rendered;
    try {
      rendered = await this.renderer.render(templateName, {
        firstName,
        dashboardUrl,
        unsubscribeUrl,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Template render failed for ${templateName}: ${msg}`);
      await this.markFailed(reminderId, `render_error:${msg}`);
      return;
    }

    const result = await this.sender.send({
      to: reminder.user.email,
      subject: rendered.subject,
      html: rendered.html,
      unsubscribeUrl,
    });

    if (result.ok) {
      await this.prisma.onboarding_email_reminders.update({
        where: { id: reminderId },
        data: { status: ReminderStatus.SENT, sent_at: new Date() },
      });
      this.logger.log(
        `Sent ${templateName} to user ${reminder.user.user_id} (campaign=${reminder.campaign})`,
      );
    } else {
      await this.markFailed(reminderId, result.error ?? 'unknown_error');
    }
  }

  private async markCancelled(reminderId: string, reason: string): Promise<void> {
    await this.prisma.onboarding_email_reminders.update({
      where: { id: reminderId },
      data: { status: ReminderStatus.CANCELLED, cancelled_at: new Date() },
    });
    this.logger.log(`Reminder ${reminderId} cancelled at fire time: ${reason}`);
  }

  private async markFailed(reminderId: string, reason: string): Promise<void> {
    // No FAILED enum value in current schema — record as CANCELLED with cancelled_at and log the reason.
    await this.prisma.onboarding_email_reminders.update({
      where: { id: reminderId },
      data: { status: ReminderStatus.CANCELLED, cancelled_at: new Date() },
    });
    this.logger.error(`Reminder ${reminderId} failed: ${reason}`);
  }
}
