import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BinancePaperTradingController } from './binance-paper-trading.controller';
import { BinancePaperTradingService } from './binance-paper-trading.service';
import { BinanceTestnetModule } from '../binance-testnet/binance-testnet.module';

@Module({
  imports: [
    ConfigModule,
    BinanceTestnetModule,
  ],
  controllers: [BinancePaperTradingController],
  providers: [BinancePaperTradingService],
  exports: [BinancePaperTradingService],
})
export class BinancePaperTradingModule {}
