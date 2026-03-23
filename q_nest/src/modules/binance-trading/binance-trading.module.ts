import { Module } from '@nestjs/common';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { BinanceTradingService } from './binance-trading.service';
import { BinanceTradingController } from './binance-trading.controller';

@Module({
  imports: [ExchangesModule],
  providers: [BinanceTradingService],
  controllers: [BinanceTradingController],
})
export class BinanceTradingModule {}
