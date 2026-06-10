import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { QhqTokenModule } from '../qhq-token/qhq-token.module';
import { OnboardingEmailsModule } from '../onboarding-emails/onboarding-emails.module';
import { AffiliateAdminController } from './controllers/affiliate-admin.controller';
import { AffiliateAdminService } from './services/affiliate-admin.service';
import { AffiliateSchedulerService } from './services/affiliate-scheduler.service';

@Module({
  imports: [
    PrismaModule,
    AdminAuthModule,
    AffiliateModule,
    SubscriptionsModule,
    QhqTokenModule,
    OnboardingEmailsModule,
    ScheduleModule,
  ],
  controllers: [AffiliateAdminController],
  providers: [AffiliateAdminService, AffiliateSchedulerService],
  exports: [AffiliateAdminService],
})
export class AffiliateAdminModule {}
