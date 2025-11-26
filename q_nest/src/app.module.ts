import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { OrdersModule } from './modules/orders/orders.module';
import { AssetsModule } from './modules/assets/assets.module';
import { ExchangesModule } from './modules/exchanges/exchanges.module';
import { KycModule } from './modules/kyc/kyc.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { SignalsModule } from './modules/signals/signals.module';
import { StrategiesModule } from './modules/strategies/strategies.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { JobsModule } from './modules/jobs/jobs.module';

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    AuthModule,
    OrdersModule,
    AssetsModule,
    ExchangesModule,
    KycModule,
    PortfolioModule,
    SignalsModule,
    StrategiesModule,
    SubscriptionsModule,
    NotificationsModule,
    JobsModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
