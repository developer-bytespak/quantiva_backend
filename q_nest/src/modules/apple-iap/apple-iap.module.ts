import { Module, forwardRef } from '@nestjs/common';
import { AppleIapController } from './apple-iap.controller';
import { AppleIapService } from './apple-iap.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { GatewaysModule } from 'src/gateways/gateways.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { QhqTokenModule } from '../qhq-token/qhq-token.module';

@Module({
  imports: [
    PrismaModule,
    SubscriptionsModule,
    GatewaysModule,
    NotificationsModule,
    forwardRef(() => QhqTokenModule),
  ],
  controllers: [AppleIapController],
  providers: [AppleIapService],
  exports: [AppleIapService],
})
export class AppleIapModule {}
