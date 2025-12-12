import { Module } from '@nestjs/common';
import { StrategiesController } from './strategies.controller';
import { StrategiesService } from './strategies.service';
import { StrategyValidationService } from './services/strategy-validation.service';
import { PreBuiltStrategiesService } from './services/pre-built-strategies.service';
import { StrategyPreviewService } from './services/strategy-preview.service';
import { StrategyExecutionService } from './services/strategy-execution.service';
import { StrategyCacheService } from './services/strategy-cache.service';
import { LLMExplanationProcessorService } from './services/llm-explanation-processor.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { KycModule } from '../../kyc/kyc.module';
import { SignalsModule } from '../signals/signals.module';

@Module({
  imports: [PrismaModule, KycModule, SignalsModule],
  controllers: [StrategiesController],
  providers: [
    StrategiesService,
    StrategyValidationService,
    PreBuiltStrategiesService,
    StrategyPreviewService,
    StrategyExecutionService,
    StrategyCacheService,
    LLMExplanationProcessorService,
  ],
  exports: [
    StrategiesService,
    StrategyValidationService,
    PreBuiltStrategiesService,
    StrategyPreviewService,
    StrategyExecutionService,
    StrategyCacheService,
    LLMExplanationProcessorService,
  ],
})
export class StrategiesModule {}

