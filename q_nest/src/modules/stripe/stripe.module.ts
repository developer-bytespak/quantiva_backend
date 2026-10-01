import { Module, forwardRef } from '@nestjs/common';
import { StripeController } from './stripe.controller';
import { StripeService } from './stripe.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { GatewaysModule } from 'src/gateways/gateways.module'; 
import { NotificationsModule } from '../notifications/notifications.module';
import { TradeFeesModule } from '../trade-fees/trade-fees.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { QhqTokenModule } from '../qhq-token/qhq-token.module';
import { OnboardingEmailsModule } from '../onboarding-emails/onboarding-emails.module';

@Module({
  imports: [
    PrismaModule,
    SubscriptionsModule,
    GatewaysModule,
    NotificationsModule,
    OnboardingEmailsModule,
    forwardRef(() => TradeFeesModule),
    forwardRef(() => QhqTokenModule),
  ],
  controllers: [StripeController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
