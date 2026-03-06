import { Module } from '@nestjs/common';
import { StripeController } from './stripe.controller';
import { StripeService } from './stripe.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { GatewaysModule } from 'src/gateways/gateways.module'; 
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [SubscriptionsModule, GatewaysModule, NotificationsModule],
  controllers: [StripeController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
