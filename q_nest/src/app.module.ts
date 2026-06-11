import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from './config/config.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminAuthModule } from './modules/admin-auth/admin-auth.module';
import { AffiliateModule } from './modules/affiliate/affiliate.module';
import { AffiliateAdminModule } from './modules/affiliate-admin/affiliate-admin.module';
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
import { ContactModule } from './modules/contact/contact.module';
import { OnboardingEmailsModule } from './modules/onboarding-emails/onboarding-emails.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { PositionInsightsModule } from './modules/position-insights/position-insights.module';
import { NewsWarmerModule } from './modules/news-warmer/news-warmer.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    GatewaysModule,
    ScheduleModule.forRoot(),
    // Single global BullMQ connection for ALL queues (onboarding-reminders,
    // strategy-execution, position-cold-refresh). forRoot is global, so feature
    // modules only need registerQueue. Do NOT call forRoot per-module — multiple
    // unnamed forRoots overwrite the same default connection (last-wins).
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => {
        const redis = config.get<{
          host: string;
          port: number;
          username?: string;
          password?: string;
          db: number;
          tls?: object;
          maxRetriesPerRequest: number | null;
          retryStrategy: (times: number) => number;
        }>('bullRedis')!;
        return {
          connection: {
            host: redis.host,
            port: redis.port,
            username: redis.username,
            password: redis.password,
            db: redis.db,
            tls: redis.tls,
            maxRetriesPerRequest: redis.maxRetriesPerRequest,
            retryStrategy: redis.retryStrategy,
          },
        };
      },
      inject: [ConfigService],
    }),
    ThrottlerModule.forRoot([{
      ttl: 60000,  // 1-minute window
      limit: 30,   // 30 requests per minute per IP (general)
    }]),
    AuthModule,
    AdminAuthModule,
    AffiliateModule,
    AffiliateAdminModule,

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
    TradeFeesModule,
    BinanceModule,
    QhqTokenModule,
    ContactModule,
    OnboardingEmailsModule,
    OnboardingModule,
    PositionInsightsModule,
    NewsWarmerModule,
  ],
  controllers: [],
  providers: [
    AccountStreamGateway,
    MarketDetailGateway,
    SubscriptionLoaderMiddleware,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
  exports: [SubscriptionLoaderMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(SubscriptionLoaderMiddleware)
      .forRoutes('*'); // Apply to all routes
  }
}
