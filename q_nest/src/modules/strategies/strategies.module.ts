import { Module } from '@nestjs/common';
import { StrategiesController } from './strategies.controller';
import { StrategiesService } from './strategies.service';
import { StrategyValidationService } from './services/strategy-validation.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [StrategiesController],
  providers: [StrategiesService, StrategyValidationService],
  exports: [StrategiesService, StrategyValidationService],
})
export class StrategiesModule {}

