import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { JobsService } from './jobs.service';
import { StrategyQueueModule } from './strategy-queue.module';
import { StrategySchedulerService } from './services/strategy-scheduler.service';

@Module({
  imports: [ScheduleModule.forRoot(), StrategyQueueModule],
  providers: [JobsService, StrategySchedulerService],
  exports: [JobsService, StrategySchedulerService, StrategyQueueModule],
})
export class JobsModule {}

