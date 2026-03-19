import { Module, forwardRef } from '@nestjs/common';
import { StripeController } from './stripe.controller';
import { StripeService } from './stripe.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { GatewaysModule } from 'src/gateways/gateways.module'; 
import { NotificationsModule } from '../notifications/notifications.module';
import { TradeFeesModule } from '../trade-fees/trade-fees.module';

@Module({
  imports: [SubscriptionsModule, GatewaysModule, NotificationsModule, forwardRef(() => TradeFeesModule)],
  controllers: [StripeController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
