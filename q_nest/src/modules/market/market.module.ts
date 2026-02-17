import { Module, forwardRef } from '@nestjs/common';
import { MarketController } from './market.controller';
import { MarketService } from './market.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { CoinDetailsCacheService } from './services/coin-details-cache.service';
import { ExchangesService } from './services/exchanges.service';
import { CoinDetailsSyncCron } from './cron/coin-details-sync.cron';
import { ExchangesModule } from '../exchanges/exchanges.module';

@Module({
  imports: [PrismaModule, forwardRef(() => ExchangesModule)],
  controllers: [MarketController],
  providers: [MarketService, CoinDetailsCacheService, ExchangesService, CoinDetailsSyncCron],
  exports: [MarketService, CoinDetailsCacheService, ExchangesService],
})
export class MarketModule {}

