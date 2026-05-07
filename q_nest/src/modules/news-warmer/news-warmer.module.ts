import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { NewsModule } from '../news/news.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { HeldSymbolsWarmerService } from './held-symbols-warmer.service';

@Module({
  imports: [ScheduleModule, NewsModule, PrismaModule],
  providers: [HeldSymbolsWarmerService],
  exports: [HeldSymbolsWarmerService],
})
export class NewsWarmerModule {}
