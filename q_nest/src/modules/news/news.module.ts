import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { NewsController } from './news.controller';
import { NewsService } from './news.service';
import { NewsCronjobService } from './news-cronjob.service';
import { KycModule } from '../../kyc/kyc.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AssetsModule } from '../assets/assets.module';

@Module({
  imports: [KycModule, PrismaModule, ScheduleModule, AssetsModule], // Provides PythonApiService, PrismaService, AssetsService
  controllers: [NewsController],
  providers: [NewsService, NewsCronjobService],
  exports: [NewsService],
})
export class NewsModule {}

