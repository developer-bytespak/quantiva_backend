import { Module, forwardRef } from '@nestjs/common';
import { StripeController } from './stripe.controller';
import { StripeService } from './stripe.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { GatewaysModule } from 'src/gateways/gateways.module'; 
import { NotificationsModule } from '../notifications/notifications.module';
import { TradeFeesModule } from '../trade-fees/trade-fees.module';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule, SubscriptionsModule, GatewaysModule, NotificationsModule, forwardRef(() => TradeFeesModule)],
  controllers: [StripeController],
  providers: [StripeService],
  exports: [StripeService],
})
export class StripeModule {}
