import { Module } from '@nestjs/common';
import { MarketController } from './market.controller';
import { MarketService } from './market.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { CoinDetailsCacheService } from './services/coin-details-cache.service';
import { CoinDetailsSyncCron } from './cron/coin-details-sync.cron';

@Module({
  imports: [PrismaModule],
  controllers: [MarketController],
  providers: [MarketService, CoinDetailsCacheService, CoinDetailsSyncCron],
  exports: [MarketService, CoinDetailsCacheService],
})
export class MarketModule {}

