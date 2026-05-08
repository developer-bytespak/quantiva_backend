import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { NewsModule } from '../news/news.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { HeldSymbolsWarmerService } from './held-symbols-warmer.service';
import { ExchangePositionsDiscoveryService } from './exchange-positions-discovery.service';
import { NewsWarmerController } from './news-warmer.controller';

@Module({
  imports: [ScheduleModule, NewsModule, PrismaModule, ExchangesModule],
  controllers: [NewsWarmerController],
  providers: [HeldSymbolsWarmerService, ExchangePositionsDiscoveryService],
  exports: [HeldSymbolsWarmerService, ExchangePositionsDiscoveryService],
})
export class NewsWarmerModule {}
