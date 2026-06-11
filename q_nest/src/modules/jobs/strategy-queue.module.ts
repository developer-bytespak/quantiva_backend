import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { StrategyProcessor } from './processors/strategy-processor';

// Bull connection is configured ONCE globally in AppModule (BullModule.forRootAsync).
@Module({
  imports: [
    BullModule.registerQueue({
      name: 'strategy-execution',
    }),
  ],
  providers: [StrategyProcessor],
  exports: [BullModule],
})
export class StrategyQueueModule {}

