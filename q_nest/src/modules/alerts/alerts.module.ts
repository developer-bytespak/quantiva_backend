import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BinanceModule } from '../binance/binance.module';
import { StocksMarketModule } from '../stocks-market/stocks-market.module';
import { OnboardingEmailsModule } from '../onboarding-emails/onboarding-emails.module';
import { AlertDispatchService } from './alert-dispatch.service';
import { HoldingAlertsService } from './holding-alerts.service';
import { SignalAlertsService } from './signal-alerts.service';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    BinanceModule,
    StocksMarketModule,
    OnboardingEmailsModule,
  ],
  providers: [AlertDispatchService, HoldingAlertsService, SignalAlertsService],
  exports: [SignalAlertsService],
})
export class AlertsModule {}
