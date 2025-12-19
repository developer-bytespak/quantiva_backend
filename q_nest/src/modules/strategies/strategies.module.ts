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
import { PrismaModule } from '../../prisma/prisma.module';
import { KycModule } from '../../kyc/kyc.module';
import { SignalsModule } from '../signals/signals.module';
import { NewsModule } from '../news/news.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { BinanceModule } from '../binance/binance.module';

@Module({
  imports: [PrismaModule, KycModule, forwardRef(() => SignalsModule), NewsModule, forwardRef(() => ExchangesModule), BinanceModule, ScheduleModule],
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
  ],
})
export class StrategiesModule {}

