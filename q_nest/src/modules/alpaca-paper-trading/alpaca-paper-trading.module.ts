import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AlpacaPaperTradingService } from './alpaca-paper-trading.service';
import { AlpacaPaperTradingController } from './alpaca-paper-trading.controller';
import { PrismaModule } from '../../prisma/prisma.module';

// Auto Trading Services
import { AutoTradingSessionService } from './services/auto-trading-session.service';
import { AutoTradingExecutionService } from './services/auto-trading-execution.service';
import { AutoTradingCronService } from './services/auto-trading-cron.service';
import { AutoTradingStatsService } from './services/auto-trading-stats.service';
import { AutoTradingController } from './services/auto-trading.controller';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    PrismaModule,
  ],
  controllers: [
    AlpacaPaperTradingController,
    AutoTradingController,
  ],
  providers: [
    AlpacaPaperTradingService,
    AutoTradingSessionService,
    AutoTradingExecutionService,
    AutoTradingCronService,
    AutoTradingStatsService,
  ],
  exports: [
    AlpacaPaperTradingService,
    AutoTradingSessionService,
    AutoTradingStatsService,
  ],
})
export class AlpacaPaperTradingModule {}

