import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { StrategiesController } from './strategies.controller';
import { StrategiesService } from './strategies.service';
import { StrategyValidationService } from './services/strategy-validation.service';
import { PreBuiltStrategiesService } from './services/pre-built-strategies.service';
import { StrategyPreviewService } from './services/strategy-preview.service';
import { StrategyExecutionService } from './services/strategy-execution.service';
import { StrategyCacheService } from './services/strategy-cache.service';
import { LLMExplanationProcessorService } from './services/llm-explanation-processor.service';
import { PreBuiltSignalsCronjobService } from './services/pre-built-signals-cronjob.service';
import { StockSignalsCronjobService } from './services/stock-signals-cronjob.service';
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

@Module({
  imports: [PrismaModule, KycModule, forwardRef(() => SignalsModule), NewsModule, forwardRef(() => ExchangesModule), BinanceModule, ScheduleModule, AiInsightsModule],
  controllers: [StrategiesController],
  providers: [
    StrategiesService,
    StrategyValidationService,
    PreBuiltStrategiesService,
    StrategyPreviewService,
    StrategyExecutionService,
    StrategyCacheService,
    LLMExplanationProcessorService,
    PreBuiltSignalsCronjobService,
    StockSignalsCronjobService,
    StockTrendingService,
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
    StockTrendingService,
  ],
})
export class StrategiesModule {}

