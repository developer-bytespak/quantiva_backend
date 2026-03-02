import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { StrategiesController } from './strategies.controller';
import { SystemCandlesController } from './system-candles.controller';
import { StrategiesService } from './strategies.service';
import { StrategyValidationService } from './services/strategy-validation.service';
import { PreBuiltStrategiesService } from './services/pre-built-strategies.service';
import { StrategyPreviewService } from './services/strategy-preview.service';
import { StrategyExecutionService } from './services/strategy-execution.service';
import { StrategyCacheService } from './services/strategy-cache.service';
import { LLMExplanationProcessorService } from './services/llm-explanation-processor.service';
import { PreBuiltSignalsCronjobService } from './services/pre-built-signals-cronjob.service';
import { StockSignalsCronjobService } from './services/stock-signals-cronjob.service';
import { CustomStrategyCronjobService } from './services/custom-strategy-cronjob.service';
import { StockTrendingService } from './services/stock-trending.service';
import { AlpacaSyncCronjobService } from './services/alpaca-sync-cronjob.service';
import { PaperTradingService } from './services/paper-trading.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { KycModule } from '../../kyc/kyc.module';
import { SignalsModule } from '../signals/signals.module';
import { NewsModule } from '../news/news.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { BinanceModule } from '../binance/binance.module';
import { AiInsightsModule } from '../../ai-insights/ai-insights.module';
import { StocksMarketModule } from '../stocks-market/stocks-market.module';
import { FeatureAccessService } from '../../common/feature-access.service';
import { TierAccessGuard } from '../../common/guards/tier-access.guard';

@Module({
  imports: [
    PrismaModule,
    AdminAuthModule,
    KycModule,
    forwardRef(() => SignalsModule),
    NewsModule,
    forwardRef(() => ExchangesModule),
    BinanceModule,
    ScheduleModule,
    AiInsightsModule,
    StocksMarketModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const jwtConfig = configService.get('jwt');
        return {
          secret: jwtConfig.secret,
          signOptions: { expiresIn: jwtConfig.accessTokenExpiry },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [StrategiesController, SystemCandlesController],
  providers: [
    TierAccessGuard,
    StrategiesService,
    StrategyValidationService,
    PreBuiltStrategiesService,
    StrategyPreviewService,
    StrategyExecutionService,
    StrategyCacheService,
    LLMExplanationProcessorService,
    PreBuiltSignalsCronjobService,
    StockSignalsCronjobService,
    CustomStrategyCronjobService,
    StockTrendingService,
    FeatureAccessService,
  ],
  exports: [
    StrategiesService,
    StrategyValidationService,
    PreBuiltStrategiesService,
    StrategyPreviewService,
    StrategyExecutionService,
    StrategyCacheService,
    LLMExplanationProcessorService,
    PreBuiltSignalsCronjobService,
    StockSignalsCronjobService,
    CustomStrategyCronjobService,
    StockTrendingService,
    FeatureAccessService,
  ],
})
export class StrategiesModule {}

