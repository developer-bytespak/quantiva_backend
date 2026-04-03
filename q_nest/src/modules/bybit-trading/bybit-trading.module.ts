import { Module } from '@nestjs/common';
import { ExchangesModule } from '../exchanges/exchanges.module';
import { BybitTradingService } from './bybit-trading.service';
import { BybitTradingController } from './bybit-trading.controller';

@Module({
  imports: [ExchangesModule],
  providers: [BybitTradingService],
  controllers: [BybitTradingController],
})
export class BybitTradingModule {}
