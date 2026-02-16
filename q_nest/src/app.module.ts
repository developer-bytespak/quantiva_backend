import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from './config/config.module';
import { AuthModule } from './modules/auth/auth.module';
import { SubscriptionLoaderMiddleware } from './common/middleware/subscription-loader.middleware';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { KycModule } from './kyc/kyc.module';
import { ExchangesModule } from './modules/exchanges/exchanges.module';
import { BinanceTestnetModule } from './modules/binance-testnet/binance-testnet.module';
import { AlpacaPaperTradingModule } from './modules/alpaca-paper-trading/alpaca-paper-trading.module';
import { UsersModule } from './modules/users/users.module';
import { NewsModule } from './modules/news/news.module';
import { MacroModule } from './modules/macro/macro.module';
import { SentimentModule } from './modules/sentiment/sentiment.module';
import { EnginesModule } from './modules/engines/engines.module';
import { MarketModule } from './modules/market/market.module';
import { StocksMarketModule } from './modules/stocks-market/stocks-market.module';
import { StrategiesModule } from './modules/strategies/strategies.module';
import { AiInsightsModule } from './ai-insights/ai-insights.module';
import { TaskSchedulerModule } from './task-scheduler/task-scheduler.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { PaperTradingGateway } from './gateways/paper-trading.gateway';
import { MarketDetailGateway } from './gateways/market-detail.gateway';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    ScheduleModule.forRoot(),
    AuthModule,

    KycModule,
    ExchangesModule,
    BinanceTestnetModule,
    AlpacaPaperTradingModule,
    UsersModule,
    NewsModule,
    MacroModule,
    SentimentModule,
    EnginesModule,
    MarketModule,
    StocksMarketModule,
    StrategiesModule,
    AiInsightsModule,
    TaskSchedulerModule,
    PortfolioModule,
    SubscriptionsModule,
  ],
  controllers: [],
  providers: [PaperTradingGateway, MarketDetailGateway],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(SubscriptionLoaderMiddleware)
      .forRoutes('*'); // Apply to all routes
  }
}
