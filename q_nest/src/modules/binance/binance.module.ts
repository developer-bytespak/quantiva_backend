import { Module } from '@nestjs/common';
import { BinanceMarketStreamService } from './binance-market-stream.service';
import { BinanceService } from './binance.service';

@Module({
  providers: [BinanceMarketStreamService, BinanceService],
  exports: [BinanceMarketStreamService, BinanceService],
})
export class BinanceModule {}
