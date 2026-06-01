import { Module, forwardRef } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';
import { OnboardingEmailsModule } from '../onboarding-emails/onboarding-emails.module';
import { AffiliateModule } from '../affiliate/affiliate.module';

@Module({
  imports: [
    NotificationsModule,
    forwardRef(() => AuthModule),
    OnboardingEmailsModule,
    AffiliateModule,
  ],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}

