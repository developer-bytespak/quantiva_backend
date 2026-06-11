import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PositionInsightsController } from './position-insights.controller';
import { PositionInsightsService } from './position-insights.service';
import { ColdRefreshProcessor, COLD_REFRESH_QUEUE } from './cold-refresh.processor';
import { NewsModule } from '../news/news.module';

// Bull connection is configured ONCE globally in AppModule (BullModule.forRootAsync).
@Module({
  imports: [
    BullModule.registerQueue({ name: COLD_REFRESH_QUEUE }),
    NewsModule,
  ],
  controllers: [PositionInsightsController],
  providers: [PositionInsightsService, ColdRefreshProcessor],
  exports: [PositionInsightsService],
})
export class PositionInsightsModule {}
