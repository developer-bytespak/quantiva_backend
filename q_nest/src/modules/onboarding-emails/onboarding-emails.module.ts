import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { QUEUE_NAME } from './config/schedule.config';
import { OnboardingStateService } from './services/onboarding-state.service';
import { FreeUpgradeCampaignService } from './services/free-upgrade-campaign.service';
import { ReminderSchedulerService } from './services/reminder-scheduler.service';
import { EmailSenderService } from './services/email-sender.service';
import { TemplateRendererService } from './services/template-renderer.service';
import { UnsubscribeTokenService } from './services/unsubscribe-token.service';
import { OnboardingReminderProcessor } from './processor/onboarding-reminder.processor';
import { OnboardingEmailsController } from './controllers/onboarding-emails.controller';

@Module({
  imports: [
    // Bull connection is configured ONCE globally in AppModule (BullModule.forRootAsync).
    // This queue runs on the Render Redis (BULL_REDIS_*) via the INTERNAL host.
    BullModule.registerQueue({ name: QUEUE_NAME }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<{ secret: string }>('jwt')!.secret,
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [OnboardingEmailsController],
  providers: [
    OnboardingStateService,
    FreeUpgradeCampaignService,
    ReminderSchedulerService,
    EmailSenderService,
    TemplateRendererService,
    UnsubscribeTokenService,
    OnboardingReminderProcessor,
  ],
  exports: [
    OnboardingStateService,
    FreeUpgradeCampaignService,
    EmailSenderService,
    TemplateRendererService,
    UnsubscribeTokenService,
  ],
})
export class OnboardingEmailsModule {}
