import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { StrategyQueueModule } from './strategy-queue.module';
import { StrategySchedulerService } from './services/strategy-scheduler.service';

@Module({
  imports: [StrategyQueueModule],
  providers: [JobsService, StrategySchedulerService],
  exports: [JobsService, StrategySchedulerService, StrategyQueueModule],
})
export class JobsModule {}

