import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetsSyncCronjobService } from './assets-sync-cronjob.service';
import { MarketModule } from '../market/market.module';

@Module({
  imports: [MarketModule, ScheduleModule],
  controllers: [AssetsController],
  providers: [AssetsService, AssetsSyncCronjobService],
  exports: [AssetsService],
})
export class AssetsModule {}

