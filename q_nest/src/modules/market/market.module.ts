import { Module, forwardRef } from '@nestjs/common';
import { MarketController } from './market.controller';
import { MarketService } from './market.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { CoinDetailsCacheService } from './services/coin-details-cache.service';
import { CoinGeckoMeterService } from './services/coingecko-meter.service';
import { ExchangesService } from './services/exchanges.service';
import { CoinDetailsSyncCron } from './cron/coin-details-sync.cron';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { BinanceModule } from '../binance/binance.module';

@Module({
  imports: [PrismaModule, forwardRef(() => ExchangesModule), BinanceModule],
  controllers: [MarketController],
  providers: [
    MarketService,
    CoinDetailsCacheService,
    CoinGeckoMeterService,
    ExchangesService,
    CoinDetailsSyncCron,
  ],
  exports: [
    MarketService,
    CoinDetailsCacheService,
    CoinGeckoMeterService,
    ExchangesService,
  ],
})
export class MarketModule {}

