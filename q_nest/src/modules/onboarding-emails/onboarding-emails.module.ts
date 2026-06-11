import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import bullRedisConfig from '../../config/bull-redis.config';
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
    ConfigModule.forFeature(bullRedisConfig),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        // Onboarding email queue runs on the Render Redis (BULL_REDIS_*), not Upstash.
        // Upstash bills per-command, and BullMQ's constant idle polling exhausts that
        // quota; Render bills by memory, so the queue is safe there.
        const redis = config.get<{
          host: string;
          port: number;
          username?: string;
          password?: string;
          db: number;
          tls?: object;
          maxRetriesPerRequest: number | null;
          retryStrategy: (times: number) => number;
        }>('bullRedis')!;
        return {
          connection: {
            host: redis.host,
            port: redis.port,
            username: redis.username,
            password: redis.password,
            db: redis.db,
            tls: redis.tls,
            maxRetriesPerRequest: redis.maxRetriesPerRequest,
            retryStrategy: redis.retryStrategy,
          },
        };
      },
      inject: [ConfigService],
    }),
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
  exports: [OnboardingStateService, FreeUpgradeCampaignService, EmailSenderService],
})
export class OnboardingEmailsModule {}
