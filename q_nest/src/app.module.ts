import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from './config/config.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminAuthModule } from './modules/admin-auth/admin-auth.module';
import { SubscriptionLoaderMiddleware } from './common/middleware/subscription-loader.middleware';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { StripeModule } from './modules/stripe/stripe.module';
import { KycModule } from './kyc/kyc.module';
import { ExchangesModule } from './modules/exchanges/exchanges.module';
import { BinanceTestnetModule } from './modules/binance-testnet/binance-testnet.module';
import { AlpacaPaperTradingModule } from './modules/alpaca-paper-trading/alpaca-paper-trading.module';
import { BinanceTradingModule } from './modules/binance-trading/binance-trading.module';
import { AlpacaTradingModule } from './modules/alpaca-trading/alpaca-trading.module';
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
import { VcPoolModule } from './modules/vc-pool/vc-pool.module';
import { OptionsModule } from './modules/options/options.module';
import { PaperTradingGateway } from './gateways/paper-trading.gateway';
import { BinanceModule } from './modules/binance/binance.module';
import { AccountStreamGateway } from './gateways/account-stream.gateway';
import { MarketDetailGateway } from './gateways/market-detail.gateway';
import { GatewaysModule } from './gateways/gateways.module';
import { TradeFeesModule } from './modules/trade-fees/trade-fees.module';
import { QhqTokenModule } from './modules/qhq-token/qhq-token.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    GatewaysModule,
    ScheduleModule.forRoot(),
    AuthModule,
    AdminAuthModule,

    KycModule,
    ExchangesModule,
    BinanceTestnetModule,
    AlpacaPaperTradingModule,
    BinanceTradingModule,
    AlpacaTradingModule,
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
    VcPoolModule,
    OptionsModule,
    SubscriptionsModule,
    StripeModule,
    BinanceModule,
    QhqTokenModule,
  ],
  controllers: [],
  providers: [AccountStreamGateway, MarketDetailGateway],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(SubscriptionLoaderMiddleware)
      .forRoutes('*'); // Apply to all routes
  }
}
