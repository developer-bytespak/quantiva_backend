import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EngineScoresService } from './engine-scores.service';
import { FundamentalMetricsService } from './fundamental-metrics.service';
import { TechnicalIndicatorsService } from './technical-indicators.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { KycModule } from '../../kyc/kyc.module';

@Module({
  imports: [PrismaModule, KycModule, ScheduleModule],
  providers: [EngineScoresService, FundamentalMetricsService, TechnicalIndicatorsService],
  exports: [EngineScoresService, FundamentalMetricsService, TechnicalIndicatorsService],
})
export class EnginesModule {}

