import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { NewsController } from './news.controller';
import { NewsService } from './news.service';
import { NewsCronjobService } from './news-cronjob.service';
import { KycModule } from '../../kyc/kyc.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AssetsModule } from '../assets/assets.module';
import { BinanceModule } from '../binance/binance.module';

@Module({
  imports: [KycModule, PrismaModule, ScheduleModule, AssetsModule, BinanceModule], // Provides PythonApiService, PrismaService, AssetsService, BinanceService
  controllers: [NewsController],
  providers: [NewsService, NewsCronjobService],
  exports: [NewsService, NewsCronjobService],
})
export class NewsModule {}

