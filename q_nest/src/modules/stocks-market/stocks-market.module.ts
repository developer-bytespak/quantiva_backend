import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StocksMarketController } from './stocks-market.controller';
import { StocksMarketService } from './stocks-market.service';
import { AlpacaMarketService } from './services/alpaca-market.service';
import { FmpService } from './services/fmp.service';
import { MarketAggregatorService } from './services/market-aggregator.service';
import { MarketStocksDbService } from './services/market-stocks-db.service';
import { CacheManagerService } from './services/cache-manager.service';
import { MarketSyncCronService } from './services/market-sync-cron.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [StocksMarketController],
  providers: [
    StocksMarketService,
    AlpacaMarketService,
    FmpService,
    MarketAggregatorService,
    MarketStocksDbService,
    CacheManagerService,
    MarketSyncCronService,
  ],
  exports: [StocksMarketService, AlpacaMarketService, MarketStocksDbService, FmpService],
})
export class StocksMarketModule {}
