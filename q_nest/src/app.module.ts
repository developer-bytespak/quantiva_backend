import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from './config/config.module';
import { AuthModule } from './modules/auth/auth.module';
import { KycModule } from './kyc/kyc.module';
import { ExchangesModule } from './modules/exchanges/exchanges.module';
import { UsersModule } from './modules/users/users.module';
import { NewsModule } from './modules/news/news.module';
import { MacroModule } from './modules/macro/macro.module';
import { SentimentModule } from './modules/sentiment/sentiment.module';
import { EnginesModule } from './modules/engines/engines.module';
import { MarketModule } from './modules/market/market.module';
import { StrategiesModule } from './modules/strategies/strategies.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    ScheduleModule.forRoot(),
    AuthModule,
    KycModule,
    ExchangesModule,
    UsersModule,
    NewsModule,
    MacroModule,
    SentimentModule,
    EnginesModule,
    MarketModule,
    StrategiesModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
